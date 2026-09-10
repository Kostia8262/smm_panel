/**
 * Вход и сессии.
 *
 * Basic-аутентификация из первой версии заменена нормальной формой: браузер
 * не умеет из неё выходить, не показывает, кто вошёл, и не даёт объяснить
 * человеку, что пароль по умолчанию надо сменить.
 *
 * Устройство простое и без внешних зависимостей:
 *   пароль    — scrypt с солью, в таблице users;
 *   сессия    — случайный токен в таблице sessions, в cookie только он;
 *   проверка  — по каждому запросу, срок продлевается при активности.
 *
 * Токен в cookie, а не подписанный JWT, потому что сессию нужно уметь
 * оборвать: смена пароля обязана выкинуть чужие входы немедленно.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db, log } from './db.js';

const SESSION_COOKIE = 'smm_session';
const SESSION_DAYS = 14;
const SCRYPT_KEYLEN = 64;

/* ------------------------------- пароли ------------------------------- */

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const attempt = scryptSync(password, salt, SCRYPT_KEYLEN);
  const known = Buffer.from(key, 'hex');
  // Длины совпадают всегда, но timingSafeEqual падает, если нет.
  if (attempt.length !== known.length) return false;
  return timingSafeEqual(attempt, known);
}

/* ------------------------------ учётные записи ------------------------------ */

/**
 * Первый запуск: заводим admin/admin и помечаем пароль временным.
 * Пароль по умолчанию — сознательное решение владельца на время сборки;
 * пометка `must_change` заставляет интерфейс говорить об этом на каждом экране.
 */
export function ensureSeedUser() {
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count > 0) return;
  db.prepare(
    'INSERT INTO users (login, password_hash, display_name, must_change) VALUES (?, ?, ?, 1)'
  ).run('admin', hashPassword('admin'), 'Администратор');
  log('warn', 'создан вход по умолчанию admin/admin — сменить пароль');
}

export function findUser(login) {
  return db.prepare('SELECT * FROM users WHERE login = ?').get(String(login || '').trim());
}

export function changePassword(userId, password) {
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(
    hashPassword(password),
    userId
  );
  // Смена пароля обрывает все сессии, включая чужие: если пароль меняют
  // потому что он утёк, оставить активный вход — значит не сменить ничего.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/* -------------------------------- сессии -------------------------------- */

function tokenHash(token) {
  // В базе лежит только отпечаток: украденный дамп не даст войти.
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(userId, { userAgent = '', ip = '' } = {}) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${SESSION_DAYS} days'))`
  ).run(tokenHash(token), userId, String(userAgent).slice(0, 200), String(ip).slice(0, 64));
  return token;
}

export function readSession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.expires_at, u.id AS user_id, u.login, u.display_name, u.must_change
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND datetime(s.expires_at) > datetime('now')`
    )
    .get(tokenHash(token));
  if (!row) return null;
  // Продлеваем срок при активности, но не чаще раза в день — иначе каждый
  // опрос календаря пишет в базу.
  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', '+${SESSION_DAYS} days')
     WHERE id = ? AND datetime(expires_at) < datetime('now', '+${SESSION_DAYS - 1} days')`
  ).run(row.id);
  return row;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function dropExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')").run();
}

/* ------------------------------ подключение ------------------------------ */

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, secure) {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 3600}`,
  ];
  if (secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Ставит маршруты входа и защиту всего остального.
 * @param {import('express').Express} app
 * @param {{publicPaths: string[], secureCookies: boolean}} opts
 */
export function installAuth(app, { publicPaths = [], secureCookies = false } = {}) {
  ensureSeedUser();
  dropExpiredSessions();

  const isPublic = (path) =>
    publicPaths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

  app.use((req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    req.user = readSession(req.cookies[SESSION_COOKIE]);
    next();
  });

  app.post('/api/login', (req, res) => {
    const { login = '', password = '' } = req.body || {};
    const user = findUser(login);
    // Одинаковый ответ на «нет такого» и «пароль не тот»: подсказывать,
    // какой логин существует, — значит помогать подбирать.
    if (!user || !verifyPassword(password, user.password_hash)) {
      log('warn', `неудачный вход: ${String(login).slice(0, 40)}`);
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    const token = createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setSessionCookie(res, token, secureCookies);
    log('info', `вход: ${user.login}`);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    destroySession(req.cookies[SESSION_COOKIE]);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Не выполнен вход' });
    res.json({ user: publicUser(req.user) });
  });

  app.post('/api/password', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Не выполнен вход' });
    const { current = '', next: nextPassword = '' } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.user_id);
    if (!verifyPassword(current, user.password_hash)) {
      return res.status(400).json({ error: 'Текущий пароль не подходит' });
    }
    if (String(nextPassword).length < 8) {
      return res.status(400).json({ error: 'Новый пароль короче восьми символов' });
    }
    changePassword(user.id, nextPassword);
    clearSessionCookie(res);
    log('info', `пароль изменён: ${user.login}`);
    res.json({ ok: true, relogin: true });
  });

  // Всё остальное — только для вошедших.
  app.use((req, res, next) => {
    if (req.user || isPublic(req.path)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Не выполнен вход' });
    }
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  });
}

export function publicUser(row) {
  return {
    id: row.user_id ?? row.id,
    login: row.login,
    name: row.display_name || row.login,
    mustChange: Boolean(row.must_change),
  };
}
