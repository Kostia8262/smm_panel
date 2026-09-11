/**
 * Веб-морда планировщика: календарь, композер, API.
 *
 * Воркер публикации живёт в отдельном процессе (src/queue/worker.js), чтобы
 * зависшая выгрузка видео не роняла интерфейс. Оба процесса держит PM2.
 */

import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db, getPost, listPosts, touchPost, log } = await import('./db.js');
const { PLATFORMS, PLATFORM_LIST, safeZonesFor } = await import('./platforms/specs.js');
const { connectionStatus, getAdapter } = await import('./platforms/index.js');
const { validatePost } = await import('./validate.js');
const { UPLOAD_DIR, storedName, kindOf, imageSize, cropFor } = await import('./media.js');
const { publishPost } = await import('./queue/publish.js');
const { installAuth, requireAccess } = await import('./auth.js');
const staffDb = await import('./staff.js');
const planDb = await import('./plan.js');
const { writeFileSync } = await import('node:fs');

const app = express();
const PORT = Number(process.env.PORT || 3210);
const PUBLIC_DIR = resolve(here, '../public');

app.set('trust proxy', 1); // за OpenLiteSpeed: иначе в журнале входов адрес прокси
app.use(express.json({ limit: '1mb' }));

// Медиа отдаём без пароля: площадки забирают файлы сами, по публичной ссылке.
// Защита — неугадываемое имя файла, выданное при загрузке.
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.sendFile(join(PUBLIC_DIR, 'login.html'));
});

// Вход, сессии и защита всего остального. Стили и скрипты открыты — без них
// не нарисовать саму страницу входа.
installAuth(app, {
  publicPaths: ['/login', '/css/', '/js/', '/media/', '/healthz', '/favicon.ico'],
  secureCookies: String(process.env.PUBLIC_BASE_URL || '').startsWith('https://'),
});

app.use(express.static(PUBLIC_DIR));

// Первый запуск: без владельца в панель не войти вовсе.
staffDb.ensureOwner(resolve(here, '../data/owner-token.txt'), writeFileSync);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, storedName(file.originalname)),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
});

/* --------------------------------- справочники -------------------------------- */

app.get('/api/specs', (_req, res) => {
  res.json({
    platforms: PLATFORM_LIST.map((p) => ({
      ...p,
      formats: p.formats.map((f) => ({ ...f, safeZones: safeZonesFor(p.id, f.id) })),
    })),
  });
});

app.get('/api/status', (_req, res) => {
  res.json({ platforms: connectionStatus(), publicBase: publicBase() });
});

/* ----------------------------------- посты ----------------------------------- */

app.get('/api/posts', (req, res) => {
  res.json({ posts: listPosts({ from: req.query.from, to: req.query.to }).map(decorate) });
});

app.post('/api/posts', (req, res) => {
  const { title = '', body = '', scheduled_at = null, targets = [] } = req.body || {};
  const info = db
    .prepare('INSERT INTO posts (title, body, scheduled_at, author_id) VALUES (?, ?, ?, ?)')
    .run(title, body, scheduled_at, req.user.id);
  const id = Number(info.lastInsertRowid);
  saveTargets(id, targets);
  log('info', `создан пост #${id}`, { postId: id });
  res.status(201).json({ post: decorate(getPost(id)) });
});

app.get('/api/posts/:id', (req, res) => {
  const post = getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  res.json({ post: decorate(post) });
});

app.put('/api/posts/:id', (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  const { title, body, scheduled_at, status, targets } = req.body || {};
  db.prepare(
    `UPDATE posts SET title = ?, body = ?, scheduled_at = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    title ?? post.title,
    body ?? post.body,
    scheduled_at !== undefined ? scheduled_at : post.scheduled_at,
    status ?? post.status,
    id
  );
  if (Array.isArray(targets)) saveTargets(id, targets);
  res.json({ post: decorate(getPost(id)) });
});

app.delete('/api/posts/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ----------------------------------- медиа ----------------------------------- */

app.post('/api/posts/:id/media', upload.array('files', 20), (req, res) => {
  const id = Number(req.params.id);
  if (!getPost(id)) return res.status(404).json({ error: 'Пост не найден' });
  const insert = db.prepare(`INSERT INTO media
    (post_id, kind, original_name, stored_name, mime, bytes, width, height, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const start = db.prepare('SELECT COUNT(*) n FROM media WHERE post_id = ?').get(id).n;

  for (const [i, file] of (req.files || []).entries()) {
    const kind = kindOf(file.mimetype);
    const { width, height } = kind === 'image' ? imageSize(file.path) : { width: null, height: null };
    insert.run(id, kind, file.originalname, file.filename, file.mimetype, file.size, width, height, start + i);
  }
  touchPost(id);
  res.json({ post: decorate(getPost(id)) });
});

app.put('/api/media/:id/focus', (req, res) => {
  const { focus_x = 0.5, focus_y = 0.5 } = req.body || {};
  db.prepare('UPDATE media SET focus_x = ?, focus_y = ? WHERE id = ?').run(
    Number(focus_x),
    Number(focus_y),
    Number(req.params.id)
  );
  res.json({ ok: true });
});

app.delete('/api/media/:id', (req, res) => {
  db.prepare('DELETE FROM media WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ------------------------------ очередь и отправка ----------------------------- */

app.post('/api/posts/:id/schedule', (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });

  const check = validatePost(post);
  if (!check.ok) return res.status(422).json({ error: 'Пост не проходит проверку', ...check });
  if (!post.scheduled_at) return res.status(422).json({ error: 'Не указано время публикации' });

  // Согласование включается тумблером в настройках. Пока оно включено,
  // СММщик не ставит в очередь сам — пост ждёт владельца. Владелец ставит
  // сразу: требовать утверждения от самого себя бессмысленно.
  const needsReview = staffDb.requireApproval() && req.user.role !== 'owner';
  const status = needsReview ? 'review' : 'scheduled';

  db.prepare("UPDATE posts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  db.prepare("UPDATE post_targets SET status = 'pending', error = NULL WHERE post_id = ?").run(id);
  log(
    'info',
    needsReview
      ? `пост #${id} отправлен на согласование`
      : `пост #${id} поставлен в очередь на ${post.scheduled_at}`,
    { postId: id }
  );
  res.json({ post: decorate(getPost(id)), warnings: check.warnings, review: needsReview });
});

/** Утверждение: только владелец, и только то, что этого ждёт. */
app.post('/api/posts/:id/approve', requireAccess('platforms'), (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  const check = validatePost(post);
  if (!check.ok) return res.status(422).json({ error: 'Пост не проходит проверку', ...check });

  db.prepare(
    `UPDATE posts SET status = 'scheduled', approved_by = ?, approved_at = datetime('now'),
     review_note = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(req.user.id, id);
  log('info', `пост #${id} утверждён: ${req.user.name}`, { postId: id });
  res.json({ post: decorate(getPost(id)) });
});

/** Возврат на доработку: без причины возвращать нельзя — иначе непонятно, что чинить. */
app.post('/api/posts/:id/reject', requireAccess('platforms'), (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(422).json({ error: 'Напишите, что поправить' });
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });

  db.prepare(
    "UPDATE posts SET status = 'draft', review_note = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(note.slice(0, 500), id);
  log('warn', `пост #${id} возвращён на доработку`, { postId: id });
  res.json({ post: decorate(getPost(id)) });
});

app.post('/api/posts/:id/unschedule', (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE posts SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(id);
  res.json({ post: decorate(getPost(id)) });
});

app.post('/api/posts/:id/publish-now', async (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  // Иначе «опубликовать сейчас» — дыра мимо согласования: пост уходит в пять
  // сетей, минуя ровно ту проверку, ради которой тумблер и включён.
  if (staffDb.requireApproval() && req.user.role !== 'owner' && post.status !== 'scheduled') {
    return res.status(403).json({ error: 'Пока включено согласование, публикует владелец' });
  }
  const check = validatePost(post);
  if (!check.ok) return res.status(422).json({ error: 'Пост не проходит проверку', ...check });
  const result = await publishPost(id);
  res.json({ post: decorate(getPost(id)), result });
});

app.get('/api/log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const rows = db.prepare('SELECT * FROM publish_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ log: rows });
});

app.get('/api/posts/:id/log', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM publish_log WHERE post_id = ? ORDER BY id DESC LIMIT 100')
    .all(Number(req.params.id));
  res.json({ log: rows });
});

/** Проверка связи с площадкой — по кнопке в интерфейсе. */
app.post('/api/platforms/:id/check', requireAccess('platforms'), async (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter.isConfigured()) {
    return res.status(400).json({ ok: false, missing: adapter.missingConfig() });
  }
  try {
    res.json(await adapter.check());
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ------------------------------ контент-план ------------------------------ */

app.get('/api/plan', (req, res) => {
  res.json({
    items: planDb.listPlan({ status: req.query.status || null }),
    statuses: Object.values(planDb.PLAN_STATUS),
    rubrics: planDb.RUBRICS,
    summary: planDb.planSummary(),
  });
});

app.post('/api/plan', (req, res) => {
  try {
    res.status(201).json({ item: planDb.createPlanItem(req.body || {}, req.user.id) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.put('/api/plan/:id', (req, res) => {
  try {
    res.json({ item: planDb.updatePlanItem(Number(req.params.id), req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

/** Утверждает идеи владелец — это та же развилка, что и с постами. */
app.post('/api/plan/:id/approve', requireAccess('platforms'), (req, res) => {
  res.json({ item: planDb.approvePlanItem(Number(req.params.id), req.user.id) });
});

/**
 * Заготовка поста из идеи. Доступно обоим: СММщик берёт утверждённое в работу
 * сам, иначе владелец становится узким местом на каждом шаге.
 */
app.post('/api/plan/:id/to-post', (req, res) => {
  try {
    const item = planDb.getPlanItem(Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'Пункт плана не найден' });
    if (item.status === 'idea' && staffDb.requireApproval() && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Идея ещё не утверждена владельцем' });
    }
    res.json(planDb.planToPost(Number(req.params.id), { db, staffId: req.user.id }));
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.delete('/api/plan/:id', (req, res) => {
  planDb.removePlanItem(Number(req.params.id));
  res.json({ ok: true });
});

/* --------------------------------- тренды --------------------------------- */

app.get('/api/trends', (req, res) => {
  res.json({
    trends: planDb.listTrends({ includeArchived: req.query.all === '1' }),
    sources: Object.values(planDb.TREND_SOURCES),
  });
});

/**
 * Приём тренда. Сюда пишет и панель, и разбор со стороны — у Instagram,
 * Facebook и TikTok публичного API трендов нет, и сигнал попадает в базу
 * только так. Ключ отдельный, чтобы не гонять сессию в скриптах.
 */
app.post('/api/trends', (req, res) => {
  const key = req.headers['x-ingest-key'];
  const allowed = req.user?.role === 'owner' || (process.env.TRENDS_INGEST_KEY && key === process.env.TRENDS_INGEST_KEY);
  if (!allowed) return res.status(403).json({ error: 'Тренды добавляет владелец' });
  try {
    const payload = Array.isArray(req.body?.trends) ? req.body.trends : [req.body];
    const added = payload.map((t) => planDb.addTrend(t, req.user?.name || 'импорт'));
    res.status(201).json({ trends: added });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.post('/api/trends/:id/archive', requireAccess('platforms'), (req, res) => {
  res.json({ trend: planDb.archiveTrend(Number(req.params.id), req.body?.archived !== false) });
});

app.delete('/api/trends/:id', requireAccess('platforms'), (req, res) => {
  planDb.removeTrend(Number(req.params.id));
  res.json({ ok: true });
});

/* -------------------------------- сотрудники -------------------------------- */

app.get('/api/staff', requireAccess('staff'), (_req, res) => {
  res.json({ staff: staffDb.list(), roles: Object.values(staffDb.ROLES) });
});

app.post('/api/staff', requireAccess('staff'), (req, res) => {
  try {
    // Ответ содержит токен целиком — единственный раз за его жизнь.
    res.status(201).json({ staff: staffDb.create(req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.put('/api/staff/:id', requireAccess('staff'), (req, res) => {
  try {
    res.json({ staff: staffDb.update(Number(req.params.id), req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.post('/api/staff/:id/token', requireAccess('staff'), (req, res) => {
  try {
    res.json({ staff: staffDb.reissueToken(Number(req.params.id)) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', requireAccess('staff'), (req, res) => {
  try {
    staffDb.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

/** Свой токен можно посмотреть всегда: человек уже вошёл, тайны тут нет. */
app.get('/api/me/token', (req, res) => {
  const token = staffDb.tokenOf(req.user.id);
  if (!token) return res.status(404).json({ error: 'Сотрудник не найден' });
  res.json({ token });
});

app.post('/api/me/token', (req, res) => {
  // Перевыпуск своего токена рвёт и текущую сессию — так и должно быть.
  const fresh = staffDb.reissueToken(req.user.id);
  res.json({ token: fresh.token, relogin: true });
});

/* -------------------------------- настройки -------------------------------- */

app.get('/api/settings', (req, res) => {
  res.json({
    requireApproval: staffDb.requireApproval(),
    canEdit: req.user.role === 'owner',
  });
});

app.put('/api/settings', requireAccess('platforms'), (req, res) => {
  if (req.body?.requireApproval !== undefined) {
    staffDb.setSetting('require_approval', req.body.requireApproval ? '1' : '0');
    log('info', `согласование постов ${req.body.requireApproval ? 'включено' : 'выключено'}`);
  }
  res.json({ requireApproval: staffDb.requireApproval(), canEdit: true });
});

/* --------------------------------- служебное --------------------------------- */

/**
 * Сохранение площадок поста.
 *
 * Раньше строки удалялись и создавались заново — и вместе с ними исчезали
 * `status`, `external_id` и `published_at`. Для опубликованного поста это
 * значит потерю следа публикации, а следующий прогон очереди отправил бы его
 * повторно: пост вышел бы в сети дважды. Поэтому здесь только то, что
 * действительно изменилось.
 */
function saveTargets(postId, targets) {
  const existing = db.prepare('SELECT * FROM post_targets WHERE post_id = ?').all(postId);
  const wanted = targets.filter((t) => PLATFORMS[t.platform]);

  const keyOf = (t) => `${t.platform}:${t.format_id || PLATFORMS[t.platform].formats[0].id}`;
  const wantedKeys = new Set(wanted.map(keyOf));

  // Убираем только снятые площадки — и только те, что ещё не опубликованы.
  const dropStmt = db.prepare('DELETE FROM post_targets WHERE id = ?');
  for (const row of existing) {
    const key = `${row.platform}:${row.format_id}`;
    if (!wantedKeys.has(key) && row.status !== 'published') dropStmt.run(row.id);
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO post_targets (post_id, platform, format_id, text_override) VALUES (?, ?, ?, ?)'
  );
  const updateText = db.prepare('UPDATE post_targets SET text_override = ? WHERE id = ?');

  for (const t of wanted) {
    const formatId = t.format_id || PLATFORMS[t.platform].formats[0].id;
    const row = existing.find((r) => r.platform === t.platform && r.format_id === formatId);
    if (row) updateText.run(t.text_override ?? null, row.id);
    else insert.run(postId, t.platform, formatId, t.text_override ?? null);
  }
}

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
}

/** Пост + всё, что нужно интерфейсу: ссылки на файлы, кропы, итог проверки. */
function decorate(post) {
  if (!post) return post;
  const base = publicBase();
  post.media = (post.media || []).map((m) => ({
    ...m,
    url: `${base}/media/${m.stored_name}`,
    crops: Object.fromEntries(
      (post.targets || []).map((t) => {
        const format = PLATFORMS[t.platform]?.formats.find((f) => f.id === t.format_id);
        return [
          `${t.platform}:${t.format_id}`,
          format ? cropFor({ width: m.width, height: m.height, focusX: m.focus_x, focusY: m.focus_y }, format) : null,
        ];
      })
    ),
  }));
  post.validation = validatePost(post);
  return post;
}

app.get('*', (_req, res) => res.sendFile(join(resolve(here, '../public'), 'index.html')));

app.listen(PORT, () => {
  console.log(`Планировщик слушает http://localhost:${PORT}`);
  const notReady = connectionStatus().filter((p) => !p.configured);
  if (notReady.length) {
    console.log(`Не настроены площадки: ${notReady.map((p) => p.title).join(', ')}`);
  }
});
