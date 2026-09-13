/**
 * Веб-морда планировщика: календарь, композер, API.
 *
 * Воркер публикации живёт в отдельном процессе (src/queue/worker.js), чтобы
 * зависшая выгрузка видео не роняла интерфейс. Оба процесса держит PM2.
 */

import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db, getPost, listPosts, touchPost, log } = await import('./db.js');
const { PLATFORMS, PLATFORM_LIST, safeZonesFor } = await import('./platforms/specs.js');
const { connectionStatus, getAdapter, idMismatch } = await import('./platforms/index.js');
const { validatePost } = await import('./validate.js');
const { UPLOAD_DIR, THUMB_DIR, storedName, kindOf, imageSize, cropFor, isAllowedMedia, checkThumb, removeStored } =
  await import('./media.js');
const retention = await import('./retention.js');
const { publishPost } = await import('./queue/publish.js');
const { installAuth, requireAccess } = await import('./auth.js');
const { tooManyAttempts, clearAttempts } = await import('./ratelimit.js');
const staffDb = await import('./staff.js');
const planDb = await import('./plan.js');
const projectsDb = await import('./projects.js');
const scheduleDb = await import('./schedule.js');
const linksDb = await import('./links.js');
const collector = await import('./trends/collector.js');
const observed = await import('./trends/observed.js');
const { signatureFor, withSignature } = await import('./signature.js');
const tokensDb = await import('./tokens.js');
const { writeFileSync } = await import('node:fs');
const { encrypt: encryptSecret, decrypt: decryptSecret } = await import('./secrets.js');

const app = express();
const PORT = Number(process.env.PORT || 3210);
const PUBLIC_DIR = resolve(here, '../public');

app.set('trust proxy', 1); // за OpenLiteSpeed: иначе в журнале входов адрес прокси
app.disable('x-powered-by'); // версия стека — бесплатная подсказка тому, кто ищет дыру
app.use(express.json({ limit: '1mb' }));

/*
 * Заголовки безопасности.
 *
 * Все шестнадцать сайтов сети их отдают, а панель — единственный хост без
 * них, при том что внутри неё доступы ко всем соцсетям школы. Набор тот же,
 * что у сети, с двумя отличиями: рамки запрещены целиком (панель нечего
 * встраивать, в отличие от сайта), и внешних источников нет вовсе — ни
 * шрифтов, ни аналитики, поэтому 'self' без исключений.
 *
 * `unsafe-inline` здесь нет намеренно: ради этого из login.html убран
 * встроенный скрипт, а из index.html — атрибут style.
 */
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (String(process.env.PUBLIC_BASE_URL || '').startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

/*
 * Медиа отдаём без пароля: площадки забирают файлы сами, по публичной ссылке.
 * Защита — неугадываемое имя файла, выданное при загрузке.
 *
 * Своя политика поверх общей: даже если в каталог однажды попадёт что-то
 * исполняемое, браузер не должен ни выполнить его, ни угадать тип вопреки
 * заголовку. Загрузка фильтрует типы на входе, это — второй рубеж.
 */
app.use(
  '/media',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    setHeaders(res) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);

/*
 * Нет файла — честный 404.
 *
 * Без этого запрос проваливался дальше, в общий маршрут интерфейса, и
 * получал главную страницу панели с кодом 200. Найдено 12.09.2026: снятый
 * после публикации кадр «открывался» по ссылке. Площадке, которая попросит
 * пропавший файл, HTML под видом успеха дал бы невнятное «формат не
 * поддерживается» вместо ясного «файла нет».
 */
app.use('/media', (_req, res) => {
  res.status(404).type('text/plain').send('Файла нет');
});
app.get('/healthz', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

/**
 * Короткая ссылка из поста. Открыта без входа — по ней ходят подписчики.
 * Неизвестный код уводит на сайт школы, а не показывает ошибку: человек
 * пришёл по ссылке из соцсети и не виноват, что мы её потеряли.
 */
app.get('/r/:code', (req, res) => {
  const link = linksDb.findByCode(req.params.code);
  if (!link) return res.redirect(302, 'https://mycomputer.education/');
  linksDb.registerClick(link.id, {
    userAgent: req.headers['user-agent'],
    referer: req.headers.referer,
  });
  res.redirect(302, link.target_url);
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.sendFile(join(PUBLIC_DIR, 'login.html'));
});

// Вход, сессии и защита всего остального. Стили и скрипты открыты — без них
// не нарисовать саму страницу входа.
installAuth(app, {
  publicPaths: [
    '/login', '/css/', '/js/', '/media/', '/healthz', '/favicon.ico', '/r/',
    '/api/ingest/observed', // расширение ходит с ключом, а не с сессией
  ],
  secureCookies: String(process.env.PUBLIC_BASE_URL || '').startsWith('https://'),
  // Файл нужен до первого входа. После — это ключ от панели, лежащий на
  // диске открытым, и удаляется он сам.
  ownerTokenFile: resolve(here, '../data/owner-token.txt'),
});

app.use(express.static(PUBLIC_DIR));

/*
 * Миниатюры — только вошедшим, в отличие от оригиналов в /media.
 *
 * Оригинал обязан быть открыт: его качает площадка. Миниатюра площадке не
 * нужна, а живёт она дольше оригинала — всю историю поста. Открыть её наружу
 * значило бы, что снятый после публикации кадр всё равно висит по ссылке,
 * пусть и уменьшенным. Поэтому раздача стоит после входа.
 */
app.use(
  '/thumbs',
  express.static(THUMB_DIR, {
    maxAge: '30d',
    setHeaders(res) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);
app.use('/thumbs', (_req, res) => {
  res.status(404).type('text/plain').send('Миниатюры нет');
});

// Первый запуск: без владельца в панель не войти вовсе.
staffDb.ensureOwner(resolve(here, '../data/owner-token.txt'), writeFileSync);

// Разовый переезд доступов из .env в карточку первого проекта: молча их
// потерять при переходе на проекты — значит остановить публикацию.
projectsDb.importEnvAccounts(1);

/**
 * Какой проект открыт. Приходит параметром `project`; без него берём первый —
 * панель всегда должна что-то показывать, даже по прямой ссылке из письма.
 */
/**
 * Сравнение секретов за постоянное время.
 *
 * Обычное `!==` отваливается на первом несовпавшем знаке, и по времени ответа
 * ключ подбирается посимвольно. Через сеть это тяжело, но и стоит нам одну
 * строку. Хеши равной длины — чтобы `timingSafeEqual` не падал на разных.
 */
function sameSecret(a, b) {
  const left = createHash('sha256').update(String(a ?? '')).digest();
  const right = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(left, right);
}

function currentProjectId(req) {
  const raw = Number(req.query.project || req.body?.projectId || 0);
  if (raw && projectsDb.getProject(raw)) return raw;
  const first = projectsDb.listProjects()[0];
  return first ? first.id : null;
}

const upload = multer({
  storage: multer.diskStorage({
    // Миниатюры — в свой каталог: у них другая раздача и другой срок жизни.
    destination: (_req, file, cb) => cb(null, file.fieldname === 'thumbs' ? THUMB_DIR : UPLOAD_DIR),
    // Расширение — из типа файла, а не из присланного имени: см. media.js.
    filename: (_req, file, cb) => cb(null, storedName(file.mimetype)),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
  // Имя файла из формы multer по умолчанию читает как latin1, и «фото.jpg»
  // ложилось в базу как «ÑÐ¾ÑÐ¾.jpg» — у школы все имена файлов кириллицей.
  // Найдено 13.09.2026 при проверке миниатюр.
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    // Миниатюру делает canvas панели, и это всегда JPEG. Другой тип под этим
    // полем — не наша миниатюра; молча пропускаем, а не роняем всю загрузку.
    if (file.fieldname === 'thumbs') return cb(null, file.mimetype === 'image/jpeg');
    if (isAllowedMedia(file.mimetype)) return cb(null, true);
    cb(new Error(`Такой тип файла панель не принимает: ${file.mimetype || 'неизвестный'}`));
  },
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

app.get('/api/status', (req, res) => {
  const projectId = currentProjectId(req);
  res.json({
    projectId,
    platforms: connectionStatus((platform) => projectsDb.credentialsFor(projectId, platform)),
    publicBase: publicBase(),
  });
});

/* -------------------------------- проекты -------------------------------- */

app.get('/api/projects', (_req, res) => {
  res.json({ projects: projectsDb.projectsWithCounts() });
});

app.post('/api/projects', requireAccess('platforms'), (req, res) => {
  try {
    res.status(201).json({ project: projectsDb.createProject(req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.put('/api/projects/:id', requireAccess('platforms'), (req, res) => {
  try {
    res.json({ project: projectsDb.updateProject(Number(req.params.id), req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

/** Карточка проекта: его подключения. Токены наружу не отдаются — только хвосты. */
app.get('/api/projects/:id/accounts', requireAccess('platforms'), (req, res) => {
  const project = projectsDb.getProject(Number(req.params.id));
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  res.json({ project, accounts: projectsDb.projectAccounts(project.id) });
});

app.put('/api/projects/:id/accounts/:platform', requireAccess('platforms'), (req, res) => {
  try {
    const status = projectsDb.saveAccount(Number(req.params.id), req.params.platform, req.body || {});
    res.json({ account: status });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.delete('/api/projects/:id/accounts/:platform', requireAccess('platforms'), (req, res) => {
  projectsDb.clearAccount(Number(req.params.id), req.params.platform);
  res.json({ ok: true });
});

app.post('/api/projects/:id/accounts/:platform/check', requireAccess('platforms'), async (req, res) => {
  const projectId = Number(req.params.id);
  const adapter = getAdapter(req.params.platform);
  const creds = projectsDb.credentialsFor(projectId, req.params.platform);
  if (!adapter.isConfigured(creds)) {
    return res.status(400).json({ ok: false, missing: adapter.missingConfig(creds) });
  }
  try {
    const result = await adapter.check(creds);
    // Связь есть — но это ещё не значит, что пост уйдёт: публикация идёт на
    // вписанный id, а проверка связи у Threads на `me`.
    const warning = idMismatch(creds, result);
    res.json(warning ? { ...result, warning } : result);
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* --------------------------- сроки жизни токенов --------------------------- */

/**
 * Что сторож знает о токенах. Обход площадок делает воркер раз в шесть часов,
 * здесь только чтение отметок: ходить в Graph API из обработчика запроса —
 * значит держать открытую карточку проекта на минуту ради служебной справки.
 */
app.get('/api/tokens', requireAccess('platforms'), (req, res) => {
  const scope = req.query.project === 'all' ? null : currentProjectId(req);
  res.json({ tokens: tokensDb.tokenHealth({ projectId: scope }), policy: tokensDb.TOKEN_POLICY });
});

/** Тревога для значка у раздела «Проекты»: владелец сидит в календаре. */
app.get('/api/tokens/alerts', requireAccess('platforms'), (_req, res) => {
  res.json(tokensDb.tokenAlerts());
});

/**
 * Продлить токен руками. Обычно это делает сторож сам за две недели до
 * смерти, но кнопка нужна: после разбирательств с площадкой ждать очередного
 * обхода незачем.
 */
app.post('/api/tokens/:platform/renew', requireAccess('platforms'), async (req, res) => {
  const projectId = currentProjectId(req);
  try {
    const { expiresAt } = await tokensDb.renewToken(projectId, req.params.platform);
    res.json({ ok: true, expiresAt });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/** Прогнать обход сейчас, не дожидаясь воркера. */
app.post('/api/tokens/check', requireAccess('platforms'), async (_req, res) => {
  try {
    const checked = await tokensDb.sweepTokens();
    res.json({ ok: true, checked: checked.length, tokens: tokensDb.tokenHealth() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ----------------------------------- посты ----------------------------------- */

app.get('/api/posts', (req, res) => {
  const posts = listPosts({
    from: req.query.from,
    to: req.query.to,
    projectId: currentProjectId(req),
  });
  res.json({ posts: posts.map(decorate) });
});

app.post('/api/posts', (req, res) => {
  const { title = '', body = '', scheduled_at = null, targets = [] } = req.body || {};
  const info = db
    .prepare('INSERT INTO posts (title, body, scheduled_at, author_id, project_id) VALUES (?, ?, ?, ?, ?)')
    .run(title, body, scheduled_at, req.user.id, currentProjectId(req));
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
  const { title, body, scheduled_at, status, targets, category_id, recycle, skip_signature, project_id } =
    req.body || {};

  // Проект определяет, в чьи аккаунты уйдёт пост. Уже опубликованному его
  // менять нельзя: в сетях останется запись от одной школы, а в панели
  // будет числиться другая.
  if (project_id !== undefined && project_id !== post.project_id) {
    if (post.targets.some((t) => t.status === 'published')) {
      return res.status(422).json({ error: 'Пост уже публиковался — проект менять поздно' });
    }
    if (!projectsDb.getProject(project_id)) {
      return res.status(422).json({ error: 'Проект не найден' });
    }
    // Рубрика принадлежит проекту: при переезде она теряет смысл.
    db.prepare('UPDATE posts SET project_id = ?, category_id = NULL WHERE id = ?').run(project_id, id);
    log('info', `пост #${id} переведён в другой проект`, { postId: id });
  }
  db.prepare(
    `UPDATE posts SET title = ?, body = ?, scheduled_at = ?, status = ?, category_id = ?,
     recycle = ?, skip_signature = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    title ?? post.title,
    body ?? post.body,
    scheduled_at !== undefined ? scheduled_at : post.scheduled_at,
    status ?? post.status,
    project_id !== undefined && project_id !== post.project_id
      ? null
      : category_id !== undefined
      ? category_id
      : post.category_id,
    recycle === undefined ? post.recycle : recycle ? 1 : 0,
    skip_signature === undefined ? post.skip_signature : skip_signature ? 1 : 0,
    id
  );
  if (Array.isArray(targets)) saveTargets(id, targets);
  res.json({ post: decorate(getPost(id)) });
});

/**
 * Удаление — мягкое. Панель обязана помнить, о чём мы уже говорили, а
 * стёртый пост уносит с собой и эту память, и след публикации: по внешнему
 * id мы больше не свяжем вышедший в сети пост с нашим планом.
 */
app.delete('/api/posts/:id', (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.targets.some((t) => t.status === 'published')) {
    db.prepare("UPDATE posts SET deleted_at = datetime('now') WHERE id = ?").run(id);
    log('warn', `пост #${id} убран из панели (уже публиковался — запись сохранена)`, { postId: id });
    return res.json({ ok: true, soft: true });
  }
  // Ничего не выходило — уносим совсем, чтобы черновики не копились.
  // Строки кадров уходят каскадом, а файлы на диске каскад не трогает: без
  // этого они лежали сиротами до суточной уборки. Снимаем через retention —
  // у вечнозелёной копии может оказаться тот же файл.
  const files = post.media.map((m) => m.stored_name);
  const thumbs = post.media.map((m) => m.thumb_name).filter(Boolean);
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  for (const name of files) retention.releaseFile(name);
  for (const name of thumbs) retention.releaseThumb(name);
  res.json({ ok: true, soft: false });
});

/* ----------------------------------- медиа ----------------------------------- */

/**
 * Квота на загрузки — до того, как multer запишет файл на диск.
 *
 * Проверять после записи поздно: полгигабайта уже легли на общий с сайтами
 * сети диск. Размер берём из заголовка запроса — он чуть больше суммы файлов
 * из-за обёртки multipart, и ошибка в эту сторону безопасна.
 */
function uploadQuota(req, res, next) {
  const incoming = Number(req.headers['content-length'] || 0);
  const { ok, used, quota } = retention.quotaCheck(incoming);
  if (ok) return next();
  const mb = (n) => Math.round(n / 1048576);
  log('warn', `загрузка отклонена по квоте: занято ${mb(used)} из ${mb(quota)} МБ`);
  res.status(507).json({
    error: `Место под файлы кончилось: занято ${mb(used)} из ${mb(quota)} МБ. Файлы опубликованных постов снимаются сами — подождите или удалите лишние черновики.`,
  });
}

const mediaUpload = upload.fields([
  { name: 'files', maxCount: 20 },
  { name: 'thumbs', maxCount: 20 },
]);

app.post('/api/posts/:id/media', uploadQuota, mediaUpload, (req, res) => {
  const id = Number(req.params.id);
  const files = req.files?.files || [];
  const thumbs = req.files?.thumbs || [];
  if (!getPost(id)) {
    for (const f of files) removeStored(f.filename);
    for (const t of thumbs) removeStored(t.filename, THUMB_DIR);
    return res.status(404).json({ error: 'Пост не найден' });
  }

  // Миниатюра привязана к файлу по номеру в имени (`thumb-3.jpg` — к четвёртому
  // файлу), а не по порядку: браузер не для всякого файла сумеет её сделать
  // (видео в кодеке, которого он не знает), и порядок бы съехал.
  const thumbByIndex = new Map();
  for (const t of thumbs) {
    const index = Number(/^thumb-(\d+)\.jpg$/.exec(t.originalname)?.[1]);
    const verdict = checkThumb(t.path, t.size);
    if (Number.isInteger(index) && index < files.length && verdict.ok && !thumbByIndex.has(index)) {
      thumbByIndex.set(index, t);
    } else {
      if (!verdict.ok) log('warn', `миниатюра отклонена: ${verdict.reason}`, { postId: id });
      removeStored(t.filename, THUMB_DIR);
    }
  }

  const insert = db.prepare(`INSERT INTO media
    (post_id, kind, original_name, stored_name, mime, bytes, width, height, position, thumb_name, thumb_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const start = db.prepare('SELECT COUNT(*) n FROM media WHERE post_id = ?').get(id).n;

  for (const [i, file] of files.entries()) {
    const kind = kindOf(file.mimetype);
    const { width, height } = kind === 'image' ? imageSize(file.path) : { width: null, height: null };
    const thumb = thumbByIndex.get(i);
    insert.run(
      id, kind, file.originalname, file.filename, file.mimetype, file.size, width, height, start + i,
      thumb?.filename || null, thumb?.size || null
    );
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
  const id = Number(req.params.id);
  // Файл с диска снимается вместе со строкой. Раньше оставался: снятый с
  // поста кадр по-прежнему открывался по своей публичной ссылке — навсегда
  // и для кого угодно, кто эту ссылку однажды видел.
  //
  // Но не всегда: вечнозелёная копия ссылается на тот же файл, и прямое
  // удаление стирало кадр у поста, который ещё ждёт своей очереди. Решает
  // retention — файл уходит, только если больше никому не нужен.
  const row = db.prepare('SELECT stored_name, thumb_name FROM media WHERE id = ?').get(id);
  db.prepare('DELETE FROM media WHERE id = ?').run(id);
  if (row) {
    retention.releaseFile(row.stored_name);
    retention.releaseThumb(row.thumb_name);
  }
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

/**
 * «Опубликовать сейчас» = поставить в очередь на сию секунду.
 *
 * Раньше публикация шла прямо в этом запросе, а Instagram ждёт готовности
 * видео до пяти минут: запрос отваливался по таймауту прокси, и человек не
 * узнавал результата, хотя пост уходил. Теперь отправкой всегда занимается
 * воркер — один владелец процесса, никакой гонки между ним и веб-мордой.
 */
app.post('/api/posts/:id/publish-now', (req, res) => {
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

  db.prepare(
    `UPDATE posts SET status = 'scheduled', scheduled_at = datetime('now', 'localtime'),
     updated_at = datetime('now') WHERE id = ?`
  ).run(id);
  db.prepare(
    "UPDATE post_targets SET status = 'pending', error = NULL WHERE post_id = ? AND status IN ('failed', 'pending')"
  ).run(id);
  log('info', `пост #${id} отправлен в очередь немедленно`, { postId: id });

  res.status(202).json({ post: decorate(getPost(id)), queued: true });
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

/* ------------------------------ контент-план ------------------------------ */

app.get('/api/plan', (req, res) => {
  // `project=all` — общий взгляд на четыре школы разом: при планировании
  // месяца важно видеть, где густо, а где неделю пусто.
  const all = req.query.project === 'all';
  const projectId = all ? null : currentProjectId(req);
  res.json({
    projectId,
    scope: all ? 'all' : 'project',
    items: planDb.listPlan({ status: req.query.status || null, projectId }),
    statuses: Object.values(planDb.PLAN_STATUS),
    rubrics: planDb.RUBRICS,
    summary: planDb.planSummary(projectId),
  });
});

app.post('/api/plan', (req, res) => {
  try {
    const payload = { ...(req.body || {}), projectId: currentProjectId(req) };
    res.status(201).json({ item: planDb.createPlanItem(payload, req.user.id) });
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
  const all = req.query.project === 'all';
  res.json({
    scope: all ? 'all' : 'project',
    projectId: all ? null : currentProjectId(req),
    trends: planDb.listTrends({
      includeArchived: req.query.all === '1',
      projectId: all ? null : currentProjectId(req),
    }),
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
    const projectId = req.user ? currentProjectId(req) : null;
    const added = payload.map((t) =>
      planDb.addTrend({ projectId, ...t }, req.user?.name || 'импорт')
    );
    res.status(201).json({ trends: added });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

/* --------------------- приём ленты из расширения --------------------- */

/**
 * Пачка постов, увиденных в браузере СММщика.
 *
 * Ключ, а не сессия: расширение живёт в чужой вкладке, и гонять туда
 * cookie панели значит отдать ключ от неё странице Threads.
 */
app.post('/api/ingest/observed', (req, res) => {
  // Единственная дверь наружу кроме входа, и до сих пор она была без счётчика:
  // ключ можно было перебирать бесконечно, а главное — бесконечно писать в
  // базу. Считаем попытки так же, как у входа.
  if (tooManyAttempts(`ingest:${req.ip}`)) {
    return res.status(429).json({ error: 'Слишком много попыток. Подождите десять минут' });
  }
  const key = req.headers['x-ingest-key'];
  const expected = staffDb.getSetting('ingest_key', '') || process.env.TRENDS_INGEST_KEY || '';
  if (!expected || !sameSecret(key, expected)) {
    return res.status(403).json({ error: 'Ключ приёма не подошёл' });
  }
  clearAttempts(`ingest:${req.ip}`);
  const projectId = Number(req.body?.projectId) || null;
  const result = observed.ingest(req.body?.posts || [], { projectId });
  res.json(result);
});

/** Выводы по чужой ленте: что заходит, в каком формате и в какие часы. */
app.get('/api/observed/digest', (req, res) => {
  res.json(
    observed.digest({
      days: Math.min(60, Number(req.query.days) || 7),
      projectId: req.query.project === 'all' ? null : currentProjectId(req),
    })
  );
});

/** Ключ приёма выдаётся владельцем и виден только ему. */
app.get('/api/ingest/key', requireAccess('platforms'), (req, res) => {
  const key = staffDb.getSetting('ingest_key', '');
  const projectId = currentProjectId(req);
  const project = projectsDb.getProject(projectId);
  res.json({
    key,
    projectId,
    projectTitle: project?.title || '',
    panelUrl: publicBase(),
    // Одна строка вместо трёх полей: переносить руками адрес, номер и ключ —
    // три шанса ошибиться, и первый же вопрос будет «а что куда вписывать».
    setup: key ? encodeSetup({ panelUrl: publicBase(), projectId, ingestKey: key }) : '',
  });
});

/** Настройка расширения одной строкой: `smm1.<base64>`. */
function encodeSetup(payload) {
  return `smm1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

app.post('/api/ingest/key', requireAccess('platforms'), (_req, res) => {
  const key = randomKey();
  staffDb.setSetting('ingest_key', key);
  log('warn', 'перевыпущен ключ приёма ленты');
  res.json({ key });
});

function randomKey() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------- наблюдение за темами ------------------------- */

app.get('/api/trends/keywords', (req, res) => {
  const projectId = currentProjectId(req);
  const keywords = collector.listKeywords(projectId).map((k) => ({
    ...k,
    history: collector.historyFor(k.id, 30),
    growth: collector.growthFor(k.id),
  }));
  res.json({ keywords });
});

app.post('/api/trends/keywords', requireAccess('platforms'), (req, res) => {
  try {
    res.status(201).json({ keywords: collector.addKeyword(currentProjectId(req), req.body?.phrase) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.delete('/api/trends/keywords/:id', requireAccess('platforms'), (req, res) => {
  collector.removeKeyword(Number(req.params.id));
  res.json({ keywords: collector.listKeywords(currentProjectId(req)) });
});

/**
 * Ручной сбор. Идёт в ответе запроса намеренно: замеров единицы, каждый —
 * два запроса к Threads, и человек нажал кнопку именно чтобы увидеть итог.
 */
app.post('/api/trends/collect', requireAccess('platforms'), async (req, res) => {
  try {
    res.json(await collector.collectForProject(currentProjectId(req)));
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

/* ------------------------------- отдача поста ------------------------------- */

/**
 * Что пост принёс: переходы и заявки. Ради этого отчёта и стоило строить
 * свою панель — ни один сервис планирования не знает про наши заявки.
 */
app.get('/api/posts/:id/report', async (req, res) => {
  const post = getPost(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  const report = await linksDb.postReport(post, {
    apiUrl: staffDb.getSetting('leads_api_url', 'https://mycomputer.education'),
    apiToken: leadsApiToken(),
  });
  res.json(report);
});

/** Токен админки школы лежит зашифрованным — как и доступы к площадкам. */
function leadsApiToken() {
  const stored = staffDb.getSetting('leads_api_token', '');
  if (!stored) return process.env.LEADS_API_TOKEN || '';
  try {
    return decryptSecret(stored);
  } catch {
    return '';
  }
}

app.put('/api/settings/leads', requireAccess('platforms'), (req, res) => {
  const { url, token } = req.body || {};
  if (url !== undefined) staffDb.setSetting('leads_api_url', String(url).trim());
  if (token) staffDb.setSetting('leads_api_token', encryptSecret(String(token).trim()));
  if (req.body?.ownDomains !== undefined) {
    staffDb.setSetting('own_domains', String(req.body.ownDomains).trim());
  }
  log('info', 'обновлён доступ к заявкам школы');
  res.json({
    url: staffDb.getSetting('leads_api_url', ''),
    hasToken: Boolean(staffDb.getSetting('leads_api_token', '')),
    ownDomains: staffDb.getSetting('own_domains', 'mycomputer.education,mycomputer.school'),
  });
});

app.get('/api/settings/leads', requireAccess('platforms'), (_req, res) => {
  res.json({
    url: staffDb.getSetting('leads_api_url', 'https://mycomputer.education'),
    hasToken: Boolean(staffDb.getSetting('leads_api_token', '')),
    ownDomains: staffDb.getSetting('own_domains', 'mycomputer.education,mycomputer.school'),
  });
});

/* --------------------------- расписание и рубрики --------------------------- */

app.get('/api/schedule', (req, res) => {
  const projectId = currentProjectId(req);
  scheduleDb.seedCategories(projectId);
  res.json({
    projectId,
    weekdays: scheduleDb.WEEKDAYS,
    categories: scheduleDb.listCategories(projectId),
    slots: scheduleDb.listSlots(projectId),
    nextFree: scheduleDb.nextFreeSlot(projectId),
  });
});

app.post('/api/schedule/slots', requireAccess('platforms'), (req, res) => {
  try {
    res.json({ slots: scheduleDb.addSlot(currentProjectId(req), req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.delete('/api/schedule/slots/:id', requireAccess('platforms'), (req, res) => {
  scheduleDb.removeSlot(Number(req.params.id));
  res.json({ slots: scheduleDb.listSlots(currentProjectId(req)) });
});

app.post('/api/categories', requireAccess('platforms'), (req, res) => {
  try {
    res.status(201).json({ category: scheduleDb.createCategory(currentProjectId(req), req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.put('/api/categories/:id', requireAccess('platforms'), (req, res) => {
  try {
    res.json({ category: scheduleDb.updateCategory(Number(req.params.id), req.body || {}) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.delete('/api/categories/:id', requireAccess('platforms'), (req, res) => {
  scheduleDb.removeCategory(Number(req.params.id));
  res.json({ ok: true });
});

/** Положить пост в ближайший свободный слот — вместо выбора времени руками. */
app.post('/api/posts/:id/slot', (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });

  const when = scheduleDb.nextFreeSlot(post.project_id, {
    categoryId: post.category_id || null,
    excludePostId: id,
  });
  if (!when) {
    return res.status(422).json({
      error: 'Свободных слотов нет — добавьте сетку расписания в настройках',
    });
  }
  db.prepare("UPDATE posts SET scheduled_at = ?, updated_at = datetime('now') WHERE id = ?").run(when, id);
  res.json({ post: decorate(getPost(id)), scheduledAt: when });
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
  // Подпись кладём в сам пост: её считают и проверка, и счётчики в
  // композере, и превью — все по одному и тому же значению.
  const project = post.project_id ? projectsDb.getProject(post.project_id) : null;
  post.signature = signatureFor(post, project);
  post.projectSignature = project ? project.signature : '';
  post.signatureEnabled = project ? project.signatureEnabled : false;
  post.media = (post.media || []).map((m) => ({
    ...m,
    // Снятый после публикации файл по ссылке больше не открывается —
    // интерфейс рисует вместо него заглушку, а не битую картинку.
    purged: Boolean(m.purged_at),
    url: m.purged_at ? null : `${base}/media/${m.stored_name}`,
    // Относительный адрес: миниатюра только для вошедших и открывается из
    // самой панели, внешний адрес ей ни к чему.
    thumbUrl: m.thumb_name ? `/thumbs/${m.thumb_name}` : null,
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

/**
 * Отклонённая загрузка должна объяснять себя.
 *
 * Фильтр типов роняет запрос исключением, и без этого обработчика СММщик
 * видел бы пустую 500 на попытку положить, скажем, PDF — и решил бы, что
 * сломалась панель, а не что формат не тот.
 */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Файл больше 512 МБ — столько не примет ни одна сеть' });
  }
  if (req.path.endsWith('/media') || err?.code?.startsWith?.('LIMIT_')) {
    return res.status(415).json({ error: err.message });
  }
  log('error', `необработанная ошибка на ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: 'Что-то пошло не так' });
});

app.get('*', (_req, res) => res.sendFile(join(resolve(here, '../public'), 'index.html')));

app.listen(PORT, () => {
  console.log(`Планировщик слушает http://localhost:${PORT}`);
  // Сводка по проектам: у каждого свой набор доступов, и «не настроено»
  // без имени проекта больше ничего не значит.
  for (const project of projectsDb.listProjects()) {
    const notReady = connectionStatus((platform) => projectsDb.credentialsFor(project.id, platform))
      .filter((p) => !p.configured)
      .map((p) => p.title);
    if (notReady.length) console.log(`${project.title}: не настроены ${notReady.join(', ')}`);
  }
});
