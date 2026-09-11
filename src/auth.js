/**
 * Вход и сессии.
 *
 * Ключ от панели — токен сотрудника, как в админке школы. Но в запросах он
 * не участвует: при входе обменивается на сессию в httpOnly-cookie. Токен
 * всплывает ровно один раз и не лежит в localStorage, откуда его забирает
 * любой XSS; сессию к тому же можно оборвать, не трогая сам токен.
 *
 * В базе сессий лежит только sha256-отпечаток — украденный дамп не пускает.
 */

import { randomBytes, createHash } from 'node:crypto';
import { db, log } from './db.js';
import { findByToken, getById, touchSeen, can } from './staff.js';

const SESSION_COOKIE = 'smm_session';
const SESSION_DAYS = 14;

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(staffId, { userAgent = '', ip = '' } = {}) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, staff_id, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${SESSION_DAYS} days'))`
  ).run(tokenHash(token), staffId, String(userAgent).slice(0, 200), String(ip).slice(0, 64));
  return token;
}

export function readSession(cookieToken) {
  if (!cookieToken) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.staff_id, st.name, st.role, st.active
       FROM sessions s JOIN staff st ON st.id = s.staff_id
       WHERE s.token_hash = ? AND datetime(s.expires_at) > datetime('now')`
    )
    .get(tokenHash(cookieToken));
  if (!row || !row.active) return null;
  // Продлеваем срок при активности, но не чаще раза в сутки — иначе каждый
  // опрос календаря пишет в базу.
  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', '+${SESSION_DAYS} days')
     WHERE id = ? AND datetime(expires_at) < datetime('now', '+${SESSION_DAYS - 1} days')`
  ).run(row.id);
  return { id: row.staff_id, name: row.name, role: row.role };
}

export function destroySession(cookieToken) {
  if (!cookieToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(cookieToken));
}

export function dropExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')").run();
}

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

/** Ограничитель попыток подбора: токен длинный, но дверь всё равно закрываем. */
const attempts = new Map();

function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  if (rec.until > now) return true;
  if (now - (rec.at || 0) > 15 * 60 * 1000) rec.count = 0;
  rec.count += 1;
  rec.at = now;
  if (rec.count > 10) {
    rec.until = now + 10 * 60 * 1000;
    rec.count = 0;
  }
  attempts.set(ip, rec);
  return false;
}

export function installAuth(app, { publicPaths = [], secureCookies = false } = {}) {
  dropExpiredSessions();

  const isPublic = (path) =>
    publicPaths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

  app.use((req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    req.user = readSession(req.cookies[SESSION_COOKIE]);
    next();
  });

  app.post('/api/login', (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (tooManyAttempts(req.ip)) {
      return res.status(429).json({ error: 'Слишком много попыток. Подождите десять минут' });
    }
    const staff = findByToken(token);
    if (!staff) {
      log('warn', `неудачный вход по токену …${token.slice(-6) || '—'}`);
      return res.status(401).json({ error: 'Токен не подошёл' });
    }
    const session = createSession(staff.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setSessionCookie(res, session, secureCookies);
    touchSeen(staff.id);
    log('info', `вход: ${staff.name}`);
    res.json({ user: { id: staff.id, name: staff.name, role: staff.role } });
  });

  app.post('/api/logout', (req, res) => {
    destroySession(req.cookies[SESSION_COOKIE]);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Не выполнен вход' });
    res.json({ user: req.user });
  });

  // Всё остальное — только для вошедших.
  app.use((req, res, next) => {
    if (req.user || isPublic(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Не выполнен вход' });
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  });
}

/** Охранник по области доступа. Карта прав — одна, в staff.js. */
export function requireAccess(area) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Не выполнен вход' });
    if (!can(req.user.role, area)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

export function isOwner(req) {
  return req.user?.role === 'owner';
}

export { getById };
