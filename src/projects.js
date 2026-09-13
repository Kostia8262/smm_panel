/**
 * Проекты и их подключения к площадкам.
 *
 * Проект — это школа со своим набором аккаунтов: у «Дошколярика» свои
 * Instagram и Facebook, у академии свои. Всё, что публикуется, принадлежит
 * проекту, и токены берутся из его карточки, а не из общего `.env`.
 *
 * Значения токенов шифруются перед записью. Наружу отдаются только хвосты
 * («…a41f»): знать, что поле заполнено, интерфейсу нужно, а сам ключ — нет.
 */

import { db, log } from './db.js';
import { encryptFields, decryptFields, tail } from './secrets.js';
import { PLATFORMS } from './platforms/specs.js';

/**
 * Какие поля нужны каждой площадке. Отсюда же рисуется форма в карточке
 * проекта — второго списка полей в интерфейсе нет.
 *
 * `token: true` — поле, смена которого означает новый токен. От него, и
 * только от него, отсчитывается срок жизни там, где площадка срок не отдаёт.
 * Секрет приложения тоже секретный, но токена он не меняет.
 */
export const ACCOUNT_FIELDS = {
  telegram: [
    { key: 'botToken', title: 'Токен бота', hint: 'Выдаёт @BotFather', secret: true, token: true },
    { key: 'chatId', title: 'Канал', hint: '@имя_канала или числовой id', secret: false },
  ],
  threads: [
    // Подсказка про ID приложения — не лишняя: генератор токена показывает его
    // рядом с токеном, и в это поле он попадал дважды.
    { key: 'userId', title: 'ID аккаунта', hint: 'Можно оставить пустым — подставится по токену. Не ID приложения', secret: false },
    { key: 'accessToken', title: 'Токен доступа', hint: 'Живёт 60 дней, продлевается сам', secret: true, token: true },
  ],
  instagram: [
    { key: 'userId', title: 'ID аккаунта', hint: 'Business или Creator', secret: false },
    { key: 'pageToken', title: 'Токен страницы', hint: 'Тот же, что у Facebook', secret: true, token: true },
  ],
  facebook: [
    { key: 'pageId', title: 'ID страницы', secret: false },
    { key: 'pageToken', title: 'Токен страницы', hint: 'Бессрочный — у system user', secret: true, token: true },
    { key: 'appId', title: 'ID приложения', secret: false },
    { key: 'appSecret', title: 'Секрет приложения', secret: true },
  ],
  tiktok: [
    { key: 'clientKey', title: 'Client key', secret: false },
    { key: 'clientSecret', title: 'Client secret', secret: true },
    { key: 'accessToken', title: 'Токен доступа', secret: true, token: true },
    { key: 'refreshToken', title: 'Refresh token', secret: true },
    { key: 'privacy', title: 'Приватность', hint: 'SELF_ONLY до аудита, потом PUBLIC_TO_EVERYONE', secret: false },
    { key: 'domainVerified', title: 'Домен подтверждён', hint: 'true или false', secret: false },
  ],
};

/* -------------------------------- проекты -------------------------------- */

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    accent: row.accent,
    active: Boolean(row.active),
    position: row.position,
    signature: row.signature || '',
    signatureEnabled: Boolean(row.signature_enabled),
  };
}

export function listProjects({ includeInactive = false } = {}) {
  const sql = `SELECT * FROM projects ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY position, id`;
  return db.prepare(sql).all().map(fromRow);
}

export function getProject(id) {
  return fromRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

export function getProjectBySlug(slug) {
  return fromRow(db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug));
}

export function createProject({ slug, title, subtitle = '', accent = '#e0a94b' }) {
  const cleanSlug = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const cleanTitle = String(title || '').trim();
  if (!cleanSlug) throw new Error('Не указан короткий код проекта');
  if (!cleanTitle) throw new Error('Не указано название проекта');
  if (getProjectBySlug(cleanSlug)) throw new Error(`Проект «${cleanSlug}» уже есть`);

  const position = (db.prepare('SELECT COALESCE(MAX(position), 0) m FROM projects').get().m || 0) + 1;
  const info = db
    .prepare('INSERT INTO projects (slug, title, subtitle, accent, position) VALUES (?, ?, ?, ?, ?)')
    .run(cleanSlug, cleanTitle, String(subtitle).slice(0, 120), accent, position);
  log('info', `заведён проект: ${cleanTitle}`);
  return getProject(Number(info.lastInsertRowid));
}

export function updateProject(id, { title, subtitle, accent, active, signature, signatureEnabled }) {
  const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!current) throw new Error('Проект не найден');
  db.prepare(
    `UPDATE projects SET title = ?, subtitle = ?, accent = ?, active = ?,
     signature = ?, signature_enabled = ? WHERE id = ?`
  ).run(
    title !== undefined ? String(title).trim() : current.title,
    subtitle !== undefined ? String(subtitle).slice(0, 120) : current.subtitle,
    accent || current.accent,
    active === undefined ? current.active : active ? 1 : 0,
    signature !== undefined ? String(signature).slice(0, 600) : current.signature,
    signatureEnabled === undefined ? current.signature_enabled : signatureEnabled ? 1 : 0,
    id
  );
  return getProject(id);
}

/* ------------------------------ подключения ------------------------------ */

/** Расшифрованные значения — только для адаптеров, наружу не отдаются. */
export function credentialsFor(projectId, platform) {
  const row = db
    .prepare('SELECT config FROM project_accounts WHERE project_id = ? AND platform = ?')
    .get(projectId, platform);
  if (!row) return {};
  try {
    return decryptFields(JSON.parse(row.config));
  } catch {
    return {};
  }
}

/**
 * Когда выпущен нынешний токен, в ISO с зоной.
 *
 * Нужно сторожу: у Threads срок жизни негде спросить, и единственная точка
 * отсчёта — день выпуска токена. Правка остальных полей эту дату не трогает.
 */
export function tokenSavedAt(projectId, platform) {
  const row = db
    .prepare('SELECT token_saved_at FROM project_accounts WHERE project_id = ? AND platform = ?')
    .get(projectId, platform);
  return row?.token_saved_at || null;
}

/**
 * Выставить дату выпуска токена руками.
 *
 * Нужно, когда токен выпустили раньше, чем вписали в панель: иначе расчётный
 * срок вышел бы длиннее настоящего, и продление опоздало бы. Ошибиться лучше в
 * сторону более ранней даты — это лишь заставит сторожа продлить на несколько
 * часов раньше, а более поздняя дата заставит его опоздать.
 */
export function setTokenSavedAt(projectId, platform, when) {
  const at = new Date(when);
  if (Number.isNaN(at.getTime())) throw new Error(`Не понимаю дату «${when}»`);
  if (at.getTime() > Date.now() + 60000) throw new Error('Дата выпуска токена не может быть в будущем');

  const info = db
    .prepare('UPDATE project_accounts SET token_saved_at = ? WHERE project_id = ? AND platform = ?')
    .run(at.toISOString(), projectId, platform);
  if (!info.changes) throw new Error(`У проекта #${projectId} нет доступов ${platform}`);

  // Срок пересчитается — старая отметка сторожа больше не верна.
  db.prepare('DELETE FROM token_health WHERE project_id = ? AND platform = ?').run(projectId, platform);
  log('info', `дата выпуска токена ${platform} у проекта #${projectId}: ${at.toISOString()}`);
  return at.toISOString();
}

export function saveAccount(projectId, platform, values) {
  if (!PLATFORMS[platform]) throw new Error(`Неизвестная площадка «${platform}»`);
  const fields = ACCOUNT_FIELDS[platform] || [];
  const current = credentialsFor(projectId, platform);

  // Пустое поле означает «не менять»: интерфейс не показывает сохранённые
  // секреты, и отправить их обратно целиком он не может.
  const merged = {};
  for (const field of fields) {
    const incoming = values?.[field.key];
    merged[field.key] = incoming === undefined || incoming === '' ? current[field.key] || '' : String(incoming).trim();
  }

  // Дата выпуска токена сдвигается, только когда сменился сам токен. Тот же
  // токен, присланный повторно, — не новый: иначе сохранение формы с
  // заполненным полем незаметно продлевало бы расчётный срок.
  const tokenField = fields.find((f) => f.token);
  const tokenChanged = Boolean(
    tokenField && merged[tokenField.key] && merged[tokenField.key] !== (current[tokenField.key] || '')
  );
  const previous = db
    .prepare('SELECT token_saved_at FROM project_accounts WHERE project_id = ? AND platform = ?')
    .get(projectId, platform);
  const tokenAt = tokenChanged ? new Date().toISOString() : previous?.token_saved_at || null;

  db.prepare(
    `INSERT INTO project_accounts (project_id, platform, config, updated_at, token_saved_at)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(project_id, platform) DO UPDATE SET
       config = excluded.config,
       updated_at = datetime('now'),
       token_saved_at = excluded.token_saved_at`
  ).run(projectId, platform, JSON.stringify(encryptFields(merged)), tokenAt);

  // Отметку сторожа снимаем: вписали новый токен — старое предупреждение
  // врёт, а ждать шести часов до следующего обхода, глядя на красную плашку
  // над уже исправленным, незачем.
  db.prepare('DELETE FROM token_health WHERE project_id = ? AND platform = ?').run(projectId, platform);

  log('info', `обновлены доступы ${platform} у проекта #${projectId}`);
  return accountStatus(projectId, platform);
}

export function clearAccount(projectId, platform) {
  db.prepare('DELETE FROM project_accounts WHERE project_id = ? AND platform = ?').run(projectId, platform);
  db.prepare('DELETE FROM token_health WHERE project_id = ? AND platform = ?').run(projectId, platform);
  log('warn', `сняты доступы ${platform} у проекта #${projectId}`);
}

/** Что показывать в карточке: заполнено ли, чего не хватает, хвосты значений. */
export function accountStatus(projectId, platform) {
  const spec = PLATFORMS[platform];
  const fields = ACCOUNT_FIELDS[platform] || [];
  const creds = credentialsFor(projectId, platform);
  const missing = fields.filter((f) => !isOptional(platform, f.key) && !creds[f.key]).map((f) => f.title);

  return {
    platform,
    title: spec?.title || platform,
    accent: spec?.accent,
    configured: missing.length === 0,
    missing,
    notes: spec?.notes || [],
    fields: fields.map((f) => ({
      ...f,
      filled: Boolean(creds[f.key]),
      // Несекретные значения показываем целиком: id канала полезно видеть.
      preview: creds[f.key] ? (f.secret ? tail(creds[f.key]) : creds[f.key]) : '',
    })),
  };
}

/** Не всё обязательно: приватность и флаг домена у TikTok имеют значения по умолчанию. */
function isOptional(platform, key) {
  return platform === 'tiktok' && (key === 'privacy' || key === 'domainVerified');
}

export function projectAccounts(projectId) {
  return Object.keys(PLATFORMS).map((platform) => accountStatus(projectId, platform));
}

/** Сводка для переключателя: сколько площадок подключено у каждого проекта. */
export function projectsWithCounts() {
  return listProjects().map((p) => {
    const accounts = projectAccounts(p.id);
    return {
      ...p,
      connected: accounts.filter((a) => a.configured).length,
      total: accounts.length,
    };
  });
}

/**
 * Разовый перенос доступов из `.env` в первый проект.
 *
 * До появления проектов токены жили в окружении, и молча их потерять при
 * переходе — значит остановить публикацию, не сказав об этом.
 */
export function importEnvAccounts(projectId = 1) {
  const already = db.prepare('SELECT COUNT(*) n FROM project_accounts').get().n;
  if (already > 0) return null;

  const fromEnv = {
    telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
    threads: { userId: process.env.THREADS_USER_ID, accessToken: process.env.THREADS_ACCESS_TOKEN },
    instagram: { userId: process.env.INSTAGRAM_USER_ID, pageToken: process.env.FACEBOOK_PAGE_TOKEN },
    facebook: {
      pageId: process.env.FACEBOOK_PAGE_ID,
      pageToken: process.env.FACEBOOK_PAGE_TOKEN,
      appId: process.env.META_APP_ID,
      appSecret: process.env.META_APP_SECRET,
    },
    tiktok: {
      clientKey: process.env.TIKTOK_CLIENT_KEY,
      clientSecret: process.env.TIKTOK_CLIENT_SECRET,
      accessToken: process.env.TIKTOK_ACCESS_TOKEN,
      refreshToken: process.env.TIKTOK_REFRESH_TOKEN,
      privacy: process.env.TIKTOK_PRIVACY,
      domainVerified: process.env.TIKTOK_DOMAIN_VERIFIED,
    },
  };

  const moved = [];
  for (const [platform, values] of Object.entries(fromEnv)) {
    if (!Object.values(values).some(Boolean)) continue;
    saveAccount(projectId, platform, values);
    moved.push(platform);
  }
  if (moved.length) log('info', `доступы из .env перенесены в проект #${projectId}: ${moved.join(', ')}`);
  return moved;
}
