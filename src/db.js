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
  {
    // Вход по токену вместо пароля — как в админке школы: сотрудника заводит
    // владелец, при создании выпускается токен, он же и есть ключ от панели.
    // Таблицы пересобираются, а не правятся: `users.password_hash` объявлен
    // NOT NULL, а SQLite не умеет снимать это ограничение через ALTER.
    name: '004-staff-tokens',
    sql: `
      CREATE TABLE staff (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        role         TEXT NOT NULL DEFAULT 'smm',
        token        TEXT NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        note         TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX idx_staff_token ON staff(token);

      DROP TABLE sessions;
      DROP TABLE users;

      CREATE TABLE sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        user_agent TEXT NOT NULL DEFAULT '',
        ip         TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_sessions_staff ON sessions(staff_id);

      -- Настройки панели. Пока одна: требовать ли утверждение владельцем
      -- перед тем, как пост уйдёт в очередь.
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO settings (key, value) VALUES ('require_approval', '1');
    `,
  },
  {
    // Пост, ждущий утверждения, и след того, кто его вёл.
    name: '005-post-review',
    sql: `
      ALTER TABLE posts ADD COLUMN author_id INTEGER REFERENCES staff(id);
      ALTER TABLE posts ADD COLUMN approved_by INTEGER REFERENCES staff(id);
      ALTER TABLE posts ADD COLUMN approved_at TEXT;
      ALTER TABLE posts ADD COLUMN review_note TEXT;
    `,
  },
  {
    /**
     * Контент-план и тренды.
     *
     * План — это то, что обсуждается и утверждается ДО того, как появился
     * пост: тема, рубрика, площадки и что нужно снять. Пост из плана рождается
     * одним нажатием и хранит обратную ссылку, чтобы было видно, какая идея
     * дошла до публикации, а какая осела.
     *
     * Тренды — сырьё для плана. Живут отдельно, потому что протухают: то, что
     * гремело две недели назад, сегодня уже вредно брать в работу.
     */
    name: '006-plan-trends',
    sql: `
      CREATE TABLE trends (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        platform    TEXT NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        metric      TEXT NOT NULL DEFAULT '',
        url         TEXT,
        source      TEXT NOT NULL DEFAULT 'research',
        relevance   INTEGER NOT NULL DEFAULT 3,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT,
        used_count  INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_trends_live ON trends(archived, platform, captured_at);

      CREATE TABLE plan_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        idea        TEXT NOT NULL DEFAULT '',
        rubric      TEXT NOT NULL DEFAULT '',
        platforms   TEXT NOT NULL DEFAULT '[]',
        planned_for TEXT,
        status      TEXT NOT NULL DEFAULT 'idea',
        need_media  TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL DEFAULT '',
        trend_id    INTEGER REFERENCES trends(id) ON DELETE SET NULL,
        post_id     INTEGER REFERENCES posts(id) ON DELETE SET NULL,
        author_id   INTEGER REFERENCES staff(id),
        approved_by INTEGER REFERENCES staff(id),
        approved_at TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_plan_status ON plan_items(status, planned_for);
    `,
  },
  {
    /**
     * Проекты.
     *
     * Школ четыре, и аккаунты у них разные — у «Дошколярика» свои Instagram
     * и Facebook, а не академии. Пока панель знала один набор токенов из
     * `.env`, любой пост уходил в один и тот же аккаунт; проект и есть то,
     * что отвечает на вопрос «куда именно».
     *
     * Токены переезжают сюда же, в карточку проекта: значения шифруются
     * (src/secrets.js), в базе лежит только шифротекст.
     */
    name: '007-projects',
    sql: `
      CREATE TABLE projects (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slug       TEXT NOT NULL UNIQUE,
        title      TEXT NOT NULL,
        subtitle   TEXT NOT NULL DEFAULT '',
        accent     TEXT NOT NULL DEFAULT '#e0a94b',
        position   INTEGER NOT NULL DEFAULT 0,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO projects (slug, title, subtitle, accent, position) VALUES
        ('education', 'Комп''ютерна академія', 'mycomputer.education', '#e0a94b', 1),
        ('school',    'Школа дизайну',         'mycomputer.school',    '#7aa7e0', 2),
        ('fluentfox', 'FluentFox',             'англійська',           '#6fc39a', 3),
        ('child',     'Дошколярик',            'doshkolyarik',         '#e08a5a', 4);

      CREATE TABLE project_accounts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        platform   TEXT NOT NULL,
        config     TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (project_id, platform)
      );

      ALTER TABLE posts ADD COLUMN project_id INTEGER REFERENCES projects(id);
      ALTER TABLE plan_items ADD COLUMN project_id INTEGER REFERENCES projects(id);
      ALTER TABLE trends ADD COLUMN project_id INTEGER REFERENCES projects(id);

      UPDATE posts SET project_id = 1 WHERE project_id IS NULL;
      UPDATE plan_items SET project_id = 1 WHERE project_id IS NULL;

      CREATE INDEX idx_posts_project ON posts(project_id, scheduled_at);
      CREATE INDEX idx_plan_project ON plan_items(project_id, status);
    `,
  },
  {
    /**
     * Надёжность отправки.
     *
     * Три дыры, которые чинятся вместе, потому что все три про один момент —
     * пост в процессе отправки:
     *
     *   1. Пост, упавший в статусе `publishing` (перезапуск, падение), не
     *      подхватывался никогда: воркер брал только `scheduled` и `partial`.
     *   2. Публикация шла прямо в HTTP-запросе, а Instagram ждёт готовности
     *      видео до пяти минут — запрос отваливался по таймауту.
     *   3. Если площадка приняла пост, а запись в базу не прошла, повтор
     *      отправлял его второй раз. Telegram ключа идемпотентности не даёт,
     *      поэтому честный ответ — не «повторить молча», а признаться:
     *      отметка ставится ДО вызова, и найденная при старте отметка значит
     *      «не знаем, ушло или нет» и требует человека.
     */
    name: '008-delivery-safety',
    sql: `
      ALTER TABLE posts ADD COLUMN publishing_since TEXT;
      ALTER TABLE posts ADD COLUMN deleted_at TEXT;
      ALTER TABLE plan_items ADD COLUMN deleted_at TEXT;

      ALTER TABLE post_targets ADD COLUMN sending_since TEXT;

      ALTER TABLE project_accounts ADD COLUMN expires_at TEXT;
      ALTER TABLE project_accounts ADD COLUMN refresh_needed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE project_accounts ADD COLUMN checked_at TEXT;
      ALTER TABLE project_accounts ADD COLUMN last_error TEXT;

      CREATE INDEX idx_posts_publishing ON posts(status, publishing_since);
      CREATE INDEX idx_posts_alive ON posts(deleted_at);
    `,
  },
  {
    /**
     * Слоты и рубрики-очереди.
     *
     * Подсмотрено у Buffer и SocialBee, и не зря: выбирать время у каждого
     * поста руками — самая частая операция дня, и она лишняя. Сетка «пн, ср,
     * пт в 10:00 и 18:30» задаётся один раз, пост падает в ближайший
     * свободный слот.
     *
     * Рубрика — это очередь со своим ритмом. У школы контент сезонный и
     * повторяемый («работа ученика», «набор в группу»), и лучшие посты имеет
     * смысл пускать по второму кругу, а не хоронить после первой публикации.
     */
    name: '009-slots-categories',
    sql: `
      CREATE TABLE categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#e0a94b',
        evergreen  INTEGER NOT NULL DEFAULT 0,
        recycle_days INTEGER NOT NULL DEFAULT 60,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (project_id, title)
      );

      -- weekday: 1 = понедельник … 7 = воскресенье (как ISO, а не как JS,
      -- где неделя начинается с воскресенья и путает при чтении SQL).
      CREATE TABLE slots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        weekday     INTEGER NOT NULL,
        time        TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        active      INTEGER NOT NULL DEFAULT 1,
        UNIQUE (project_id, weekday, time)
      );

      ALTER TABLE posts ADD COLUMN category_id INTEGER REFERENCES categories(id);
      ALTER TABLE posts ADD COLUMN recycle INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE posts ADD COLUMN recycled_from INTEGER REFERENCES posts(id);
      ALTER TABLE plan_items ADD COLUMN category_id INTEGER REFERENCES categories(id);

      CREATE INDEX idx_slots_project ON slots(project_id, active);
      CREATE INDEX idx_categories_project ON categories(project_id, position);
    `,
  },
  {
    /**
     * Ссылки, переходы и связь с заявками.
     *
     * Ради этого стоило строить своё. Публикацию умеют все сервисы, а вот
     * ответить «сколько учеников пришло с этого поста» не может ни один —
     * у них нет наших заявок.
     *
     * Цепочка: ссылка в посте подменяется короткой, она считает переход и
     * уводит на сайт с метками UTM; сайт кладёт метки в заявку (поля там уже
     * есть); панель сопоставляет заявки по `utm_campaign` с постом.
     */
    name: '010-links-attribution',
    sql: `
      CREATE TABLE links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT NOT NULL UNIQUE,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        platform    TEXT,
        target_url  TEXT NOT NULL,
        campaign    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Переходы храним записями, а не счётчиком: по ним видно, когда пост
      -- «выстрелил», а счётчик отвечает только «сколько всего».
      CREATE TABLE link_clicks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id    INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        at         TEXT NOT NULL DEFAULT (datetime('now')),
        user_agent TEXT NOT NULL DEFAULT '',
        referer    TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX idx_links_post ON links(post_id);
      CREATE INDEX idx_clicks_link ON link_clicks(link_id, at);
    `,
  },
  {
    /**
     * Обязательная подпись к постам.
     *
     * Своя у каждого проекта: у четырёх школ разные сайты и разные
     * аудитории, общая приставка звала бы людей не туда.
     *
     * Подпись обязательна, но выключатель у поста есть: мем с подписью в
     * четыре строки выглядит как реклама, и запрет без исключений кончился
     * бы тем, что её отключили бы у всего проекта разом.
     */
    name: '011-signature',
    sql: `
      ALTER TABLE projects ADD COLUMN signature TEXT NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN signature_enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE posts ADD COLUMN skip_signature INTEGER NOT NULL DEFAULT 0;

      UPDATE projects SET signature =
        'Комп''ютерна академія My Computer Academy' || char(10) ||
        'Записатися на пробне заняття: https://mycomputer.education' || char(10) ||
        'Телефон і Telegram: +38 (095) 462-46-72'
      WHERE slug = 'education';

      UPDATE projects SET signature =
        'Школа дизайну My Computer Academy' || char(10) ||
        'Курси та запис: https://mycomputer.school' || char(10) ||
        'Телефон і Telegram: +38 (095) 462-46-72'
      WHERE slug = 'school';

      UPDATE projects SET signature =
        'FluentFox — англійська для дітей та підлітків' || char(10) ||
        'Запис на пробне заняття: +38 (095) 462-46-72'
      WHERE slug = 'fluentfox';

      UPDATE projects SET signature =
        'Дошколярик — підготовка до школи' || char(10) ||
        'Запис і питання: +38 (095) 462-46-72'
      WHERE slug = 'child';
    `,
  },
  {
    /**
     * Настоящие контакты FluentFox и «Дошколярика» — с их сайтов.
     *
     * Правим только нетронутые подписи: если владелец уже переписал текст
     * под себя, миграция не имеет права его затирать. Сравнение с точным
     * старым значением и есть эта проверка.
     *
     * Подписи держим короткими: в Threads всего 500 знаков, и четыре строки
     * контактов съели бы четверть поста. Адреса и второй телефон сознательно
     * оставлены сайту — в подписи только то, по чему пишут и звонят.
     */
    name: '012-real-contacts',
    sql: `
      UPDATE projects SET
        subtitle = 'fluent-fox.site',
        signature =
          'FluentFox English School · Дніпро' || char(10) ||
          'Запис на пробне заняття: https://fluent-fox.site' || char(10) ||
          'Телефон, Viber, WhatsApp: +38 (095) 462-46-72' || char(10) ||
          'Telegram: https://t.me/fluentfox_ua'
      WHERE slug = 'fluentfox'
        AND signature = 'FluentFox — англійська для дітей та підлітків' || char(10) ||
                        'Запис на пробне заняття: +38 (095) 462-46-72';

      UPDATE projects SET
        subtitle = 'child.mycomputer.education',
        signature =
          'Дошколярик · центр розвитку дитини, Дніпро' || char(10) ||
          'Запис: https://child.mycomputer.education/uk/' || char(10) ||
          'Телефон, Viber, WhatsApp: +38 (095) 462-46-72'
      WHERE slug = 'child'
        AND signature = 'Дошколярик — підготовка до школи' || char(10) ||
                        'Запис і питання: +38 (095) 462-46-72';

      -- Домен FluentFox — наш: без него ссылки в его постах не подменялись бы
      -- короткими и не считали переходы.
      INSERT INTO settings (key, value)
      VALUES ('own_domains', 'mycomputer.education,mycomputer.school,fluent-fox.site')
      ON CONFLICT(key) DO UPDATE SET value =
        CASE WHEN instr(settings.value, 'fluent-fox.site') > 0
             THEN settings.value
             ELSE settings.value || ',fluent-fox.site' END;
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

export function listPosts({ from = null, to = null, projectId = null } = {}) {
  let sql = 'SELECT * FROM posts';
  // Удалённые не показываем, но и не стираем: запись о вышедшем посте — это
  // память о том, что мы уже говорили.
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (projectId) {
    where.push('project_id = ?');
    params.push(projectId);
  }
  if (from && to) {
    // Черновики без даты тоже нужны в списке — иначе их негде найти.
    where.push('((scheduled_at BETWEEN ? AND ?) OR scheduled_at IS NULL)');
    params.push(from, to);
  }
  sql += ` WHERE ${where.join(' AND ')}`;
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
