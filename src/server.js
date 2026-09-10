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

const app = express();
const PORT = Number(process.env.PORT || 3210);

app.use(express.json({ limit: '1mb' }));

// Медиа отдаём без пароля: площадки забирают файлы сами, по публичной ссылке.
// Защита — неугадываемое имя файла, выданное при загрузке.
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// Общий пароль на команду. Без HTTPS его ставить бессмысленно, поэтому
// сервис живёт на поддомене с сертификатом, а не на голом порту.
app.use((req, res, next) => {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) return next(); // локальная разработка
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (user === (process.env.AUTH_USER || 'smm') && pass === expected) return next();
  }
  // realm только латиницей: кириллица в заголовке роняет ответ (ERR_INVALID_CHAR)
  res.set('WWW-Authenticate', 'Basic realm="SMM planner"');
  res.status(401).send('Нужен вход');
});

app.use(express.static(resolve(here, '../public')));

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
    .prepare('INSERT INTO posts (title, body, scheduled_at) VALUES (?, ?, ?)')
    .run(title, body, scheduled_at);
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

  db.prepare("UPDATE posts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ?").run(id);
  db.prepare("UPDATE post_targets SET status = 'pending', error = NULL WHERE post_id = ?").run(id);
  log('info', `пост #${id} поставлен в очередь на ${post.scheduled_at}`, { postId: id });
  res.json({ post: decorate(getPost(id)), warnings: check.warnings });
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
  const check = validatePost(post);
  if (!check.ok) return res.status(422).json({ error: 'Пост не проходит проверку', ...check });
  const result = await publishPost(id);
  res.json({ post: decorate(getPost(id)), result });
});

app.get('/api/posts/:id/log', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM publish_log WHERE post_id = ? ORDER BY id DESC LIMIT 100')
    .all(Number(req.params.id));
  res.json({ log: rows });
});

/** Проверка связи с площадкой — по кнопке в интерфейсе. */
app.post('/api/platforms/:id/check', async (req, res) => {
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

/* --------------------------------- служебное --------------------------------- */

function saveTargets(postId, targets) {
  db.prepare('DELETE FROM post_targets WHERE post_id = ?').run(postId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO post_targets (post_id, platform, format_id, text_override) VALUES (?, ?, ?, ?)'
  );
  for (const t of targets) {
    if (!PLATFORMS[t.platform]) continue;
    insert.run(postId, t.platform, t.format_id || PLATFORMS[t.platform].formats[0].id, t.text_override ?? null);
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
