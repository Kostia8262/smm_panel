/**
 * Сотрудники и роли.
 *
 * Механика повторяет админку школы: владелец заводит человека, тому сразу
 * выпускается токен, и этот токен — единственный ключ от панели. Пароля нет
 * намеренно: заводить учётку ради пароля, который всё равно перешлют в чат,
 * смысла не имеет, а токен можно отозвать одним нажатием.
 *
 * Отличие от школьной панели: токен не ходит в каждом запросе заголовком, а
 * обменивается на сессию в httpOnly-cookie. Токен всплывает ровно один раз —
 * при входе, и не лежит в localStorage, откуда его забирает любой XSS.
 */

import { randomBytes } from 'node:crypto';
import { db, log } from './db.js';

/** Владелец видит и может всё. СММщик ведёт посты и не трогает доступы. */
export const ROLES = {
  owner: {
    id: 'owner',
    title: 'Владелец',
    hint: 'Всё: сотрудники, токены площадок, утверждение постов, настройки.',
  },
  smm: {
    id: 'smm',
    title: 'СММщик',
    hint: 'Посты, календарь и журнал. Токены площадок и сотрудников не видит.',
  },
};

/**
 * Что кому доступно. Единственная карта прав в проекте — в школьной панели
 * такая же разъезжалась, пока была размазана по классам и трём спискам.
 */
export const ACCESS = {
  calendar: ['owner', 'smm'],
  post: ['owner', 'smm'],
  platforms: ['owner'],
  journal: ['owner', 'smm'],
  staff: ['owner'],
  settings: ['owner', 'smm'], // СММщик видит только свой токен
};

export function can(role, area) {
  return Boolean(ACCESS[area]?.includes(role));
}

export function genToken() {
  return randomBytes(24).toString('hex');
}

function fromRow(row, { withToken = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    name: row.name,
    role: row.role,
    roleTitle: ROLES[row.role]?.title || row.role,
    active: Boolean(row.active),
    note: row.note || '',
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    // Хвост токена — чтобы отличить одного сотрудника от другого в списке,
    // не показывая ключ целиком.
    tokenTail: row.token ? row.token.slice(-6) : null,
  };
  if (withToken) out.token = row.token;
  return out;
}

export function list() {
  // Одинарные кавычки обязательны: в двойных SQLite видит имя столбца,
  // а не строку, и запрос падает на «no such column: owner».
  return db.prepare("SELECT * FROM staff ORDER BY (role = 'owner') DESC, id").all().map((r) => fromRow(r));
}

export function getById(id) {
  return fromRow(db.prepare('SELECT * FROM staff WHERE id = ?').get(id));
}

export function findByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM staff WHERE token = ? AND active = 1').get(String(token).trim());
}

export function create({ name, role = 'smm', note = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Не указано имя сотрудника');
  if (!ROLES[role]) throw new Error(`Неизвестная роль «${role}»`);
  const token = genToken();
  const info = db
    .prepare('INSERT INTO staff (name, role, token, note) VALUES (?, ?, ?, ?)')
    .run(clean, role, token, String(note).slice(0, 300));
  log('info', `заведён сотрудник ${clean} (${ROLES[role].title})`);
  // Токен отдаём целиком ровно здесь: второй раз его показать будет негде,
  // в базе он лежит, но интерфейс покажет только хвост.
  return fromRow(db.prepare('SELECT * FROM staff WHERE id = ?').get(info.lastInsertRowid), {
    withToken: true,
  });
}

export function update(id, { name, role, note, active }) {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!staff) throw new Error('Сотрудник не найден');
  if (role && !ROLES[role]) throw new Error(`Неизвестная роль «${role}»`);

  // Владелец обязан остаться хотя бы один: иначе панель запрётся изнутри,
  // и чинить придётся руками в базе на сервере.
  if (staff.role === 'owner' && (role === 'smm' || active === false)) {
    const owners = db
      .prepare("SELECT COUNT(*) n FROM staff WHERE role = 'owner' AND active = 1 AND id != ?")
      .get(id).n;
    if (owners === 0) throw new Error('Это единственный владелец — панель останется без доступа');
  }

  db.prepare(
    `UPDATE staff SET name = ?, role = ?, note = ?, active = ? WHERE id = ?`
  ).run(
    name !== undefined ? String(name).trim() : staff.name,
    role || staff.role,
    note !== undefined ? String(note).slice(0, 300) : staff.note,
    active === undefined ? staff.active : active ? 1 : 0,
    id
  );
  return getById(id);
}

/** Перевыпуск: старый токен перестаёт работать, сессии по нему обрываются. */
export function reissueToken(id) {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!staff) throw new Error('Сотрудник не найден');
  const token = genToken();
  db.prepare('UPDATE staff SET token = ? WHERE id = ?').run(token, id);
  db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(id);
  log('warn', `перевыпущен токен: ${staff.name}`);
  return fromRow(db.prepare('SELECT * FROM staff WHERE id = ?').get(id), { withToken: true });
}

export function remove(id) {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!staff) throw new Error('Сотрудник не найден');
  if (staff.role === 'owner') {
    const owners = db
      .prepare("SELECT COUNT(*) n FROM staff WHERE role = 'owner' AND active = 1 AND id != ?")
      .get(id).n;
    if (owners === 0) throw new Error('Это единственный владелец — удалять нельзя');
  }
  db.prepare('DELETE FROM staff WHERE id = ?').run(id);
  log('warn', `удалён сотрудник: ${staff.name}`);
}

/** Свой токен человеку показать можно: он уже вошёл, и это его же ключ. */
export function tokenOf(id) {
  const row = db.prepare('SELECT token FROM staff WHERE id = ?').get(id);
  return row ? row.token : null;
}

export function touchSeen(id) {
  db.prepare("UPDATE staff SET last_seen_at = datetime('now') WHERE id = ?").run(id);
}

/* ------------------------------ настройки ------------------------------ */

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function requireApproval() {
  return getSetting('require_approval', '1') === '1';
}

/**
 * Первый запуск: владелец без токена — это панель, в которую не войти.
 * Токен печатается в лог и кладётся рядом с базой, потому что показать его
 * больше негде: интерфейса ещё нет, а входа — тем более.
 */
export function ensureOwner(tokenFilePath, writeFile) {
  const count = db.prepare('SELECT COUNT(*) n FROM staff').get().n;
  if (count > 0) return null;
  const token = genToken();
  db.prepare("INSERT INTO staff (name, role, token) VALUES (?, 'owner', ?)").run('Владелец', token);
  log('warn', 'заведён владелец — токен входа записан в data/owner-token.txt');
  try {
    writeFile(tokenFilePath, `${token}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`Не удалось записать файл с токеном: ${err.message}`);
  }
  console.log(`\n=== ТОКЕН ВЛАДЕЛЬЦА (показывается один раз) ===\n${token}\n`);
  return token;
}
