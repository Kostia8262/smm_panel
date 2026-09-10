/**
 * Хранилище на встроенном в Node SQLite (`node:sqlite`).
 *
 * Почему именно он: нативных сборок не требует, а значит выкатка на сервер —
 * это `git pull` без компиляции. Проверено: Node 24 локально и Node 26 на VPS.
 *
 * Схема миграций простая и намеренно тупая: список шагов, каждый выполняется
 * один раз, отметка в таблице `migrations`. Откатов нет — только вперёд.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(here, '../data/smm.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const MIGRATIONS = [
  {
    name: '001-init',
    sql: `
      CREATE TABLE posts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT NOT NULL DEFAULT '',
        body         TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'draft',
        scheduled_at TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Один пост × одна площадка. Текст можно переопределить: в Threads
      -- влезает 500 символов, и общий текст приходится ужимать именно там.
      CREATE TABLE post_targets (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        platform      TEXT NOT NULL,
        format_id     TEXT NOT NULL,
        text_override TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        external_id   TEXT,
        external_url  TEXT,
        error         TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        published_at  TEXT,
        UNIQUE (post_id, platform, format_id)
      );

      -- Мастер-медиа. Нарезки под раскладки живут отдельно, в renders.
      CREATE TABLE media (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_name   TEXT NOT NULL,
        mime          TEXT NOT NULL,
        bytes         INTEGER NOT NULL,
        width         INTEGER,
        height        INTEGER,
        duration      REAL,
        focus_x       REAL NOT NULL DEFAULT 0.5,
        focus_y       REAL NOT NULL DEFAULT 0.5,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE renders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        format_key  TEXT NOT NULL,
        stored_name TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (media_id, format_key)
      );

      -- Журнал попыток публикации: без него разбирать «почему не ушло»
      -- придётся по логам PM2, а они ротируются.
      CREATE TABLE publish_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id    INTEGER,
        platform   TEXT,
        level      TEXT NOT NULL DEFAULT 'info',
        message    TEXT NOT NULL,
        payload    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_posts_scheduled ON posts(status, scheduled_at);
      CREATE INDEX idx_targets_post ON post_targets(post_id);
      CREATE INDEX idx_media_post ON media(post_id, position);
      CREATE INDEX idx_log_post ON publish_log(post_id, created_at);
    `,
  },
  {
    name: '002-token-health',
    sql: `
      -- Сроки жизни токенов. Токены Threads и страницы Facebook живут 60 дней
      -- и умирают молча — сторож читает эту таблицу и пишет письмо заранее.
      CREATE TABLE token_health (
        platform    TEXT PRIMARY KEY,
        expires_at  TEXT,
        checked_at  TEXT,
        last_error  TEXT
      );
    `,
  },
  {
    name: '003-users',
    sql: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        login         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT NOT NULL DEFAULT '',
        must_change   INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- В базе только отпечаток токена: украденный дамп не даёт войти.
      CREATE TABLE sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_agent TEXT NOT NULL DEFAULT '',
        ip         TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_sessions_user ON sessions(user_id);
    `,
  },
];

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM migrations').all().map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(m.name);
      db.exec('COMMIT');
      console.log(`[db] применена миграция ${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция ${m.name} не прошла: ${err.message}`);
    }
  }
}

migrate();

export function log(level, message, { postId = null, platform = null, payload = null } = {}) {
  db.prepare(
    'INSERT INTO publish_log (post_id, platform, level, message, payload) VALUES (?, ?, ?, ?, ?)'
  ).run(postId, platform, level, message, payload ? JSON.stringify(payload) : null);
  const tag = platform ? `${level}/${platform}` : level;
  console.log(`[${tag}] ${message}`);
}

/** Пост со всеми площадками и медиа — то, чем оперирует и интерфейс, и воркер. */
export function getPost(id) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!post) return null;
  post.targets = db.prepare('SELECT * FROM post_targets WHERE post_id = ? ORDER BY id').all(id);
  post.media = db.prepare('SELECT * FROM media WHERE post_id = ? ORDER BY position, id').all(id);
  return post;
}

export function listPosts({ from = null, to = null } = {}) {
  let sql = 'SELECT * FROM posts';
  const params = [];
  if (from && to) {
    // Черновики без даты тоже нужны в списке — иначе их негде найти.
    sql += " WHERE (scheduled_at BETWEEN ? AND ?) OR scheduled_at IS NULL";
    params.push(from, to);
  }
  sql += ' ORDER BY scheduled_at IS NULL, scheduled_at';
  const posts = db.prepare(sql).all(...params);
  const targets = db.prepare('SELECT * FROM post_targets').all();
  const media = db.prepare('SELECT id, post_id, kind, stored_name, mime FROM media ORDER BY position').all();
  for (const p of posts) {
    p.targets = targets.filter((t) => t.post_id === p.id);
    p.media = media.filter((m) => m.post_id === p.id);
  }
  return posts;
}

export function touchPost(id) {
  db.prepare("UPDATE posts SET updated_at = datetime('now') WHERE id = ?").run(id);
}
