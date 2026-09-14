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
import { mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt } from './secrets.js';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(here, '../data/smm.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/*
 * База — не публичный файл: в ней доступы площадок (пусть и шифротекстом),
 * контент-план и переходы. Ключ шифрования рядом лежит с правами 600, а база
 * оставалась 644 — читал бы любой пользователь сервера. WAL и SHM закрываем
 * тоже: в них те же данные, просто ещё не слитые в основной файл.
 */
for (const suffix of ['', '-wal', '-shm']) {
  try {
    chmodSync(`${DB_PATH}${suffix}`, 0o600);
  } catch {
    // Файла ещё нет (первый запуск) или Windows, где прав в юникс-смысле нет.
  }
}

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
  {
    /**
     * Наблюдения за темами в Threads.
     *
     * Поиск Threads не отдаёт цифры вовлечённости — только тексты. Значит
     * тренд для нас это не «сколько лайков», а **как меняется объём
     * разговора**: сегодня по запросу двадцать постов, неделю назад было
     * пять. Поэтому храним замеры по дням, а не разовый снимок: без истории
     * рост от падения не отличить.
     *
     * Сами найденные посты тоже храним — по ним видно, какими словами люди
     * говорят о нашей теме, и это сырьё для формулировок.
     */
    name: '013-trend-watch',
    sql: `
      CREATE TABLE trend_keywords (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        phrase     TEXT NOT NULL,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (project_id, phrase)
      );

      CREATE TABLE trend_observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        keyword_id  INTEGER NOT NULL REFERENCES trend_keywords(id) ON DELETE CASCADE,
        observed_on TEXT NOT NULL,
        found       INTEGER NOT NULL DEFAULT 0,
        top_share   REAL,
        media_mix   TEXT NOT NULL DEFAULT '{}',
        words       TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (keyword_id, observed_on)
      );

      CREATE TABLE trend_posts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        keyword_id  INTEGER NOT NULL REFERENCES trend_keywords(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        username    TEXT NOT NULL DEFAULT '',
        text        TEXT NOT NULL DEFAULT '',
        permalink   TEXT,
        media_type  TEXT,
        in_top      INTEGER NOT NULL DEFAULT 0,
        posted_at   TEXT,
        seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (keyword_id, external_id)
      );

      -- Показатели наших вышедших постов: по ним считается, что заходит
      -- именно нашей аудитории, а не Threads вообще.
      CREATE TABLE post_stats (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        platform    TEXT NOT NULL,
        views       INTEGER,
        likes       INTEGER,
        comments    INTEGER,
        reposts     INTEGER,
        quotes      INTEGER,
        score       REAL,
        per_hour    REAL,
        label       TEXT,
        measured_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (post_id, platform, measured_at)
      );

      CREATE INDEX idx_obs_keyword ON trend_observations(keyword_id, observed_on);
      CREATE INDEX idx_trend_posts_keyword ON trend_posts(keyword_id, seen_at);
      CREATE INDEX idx_post_stats ON post_stats(post_id, platform);
    `,
  },
  {
    /**
     * Чужие посты, увиденные в ленте.
     *
     * Официальный поиск Threads вовлечённости не отдаёт, поэтому цифры
     * приходят из браузера СММщика: расширение читает то, мимо чего человек
     * пролистал сам.
     *
     * Счётчики растут со временем, и один пост попадает сюда много раз.
     * Храним максимум виденного, а не последний снимок: пролистав ленту
     * дважды, второй раз можно застать кэш с прежними цифрами.
     */
    name: '014-observed-posts',
    sql: `
      CREATE TABLE observed_posts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        platform    TEXT NOT NULL,
        external_id TEXT NOT NULL,
        username    TEXT NOT NULL DEFAULT '',
        text        TEXT NOT NULL DEFAULT '',
        permalink   TEXT,
        media_type  TEXT,
        posted_at   TEXT,
        age_hours   REAL,
        likes       INTEGER NOT NULL DEFAULT 0,
        comments    INTEGER NOT NULL DEFAULT 0,
        reposts     INTEGER NOT NULL DEFAULT 0,
        quotes      INTEGER NOT NULL DEFAULT 0,
        score       REAL NOT NULL DEFAULT 0,
        per_hour    REAL NOT NULL DEFAULT 0,
        label       TEXT,
        first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (platform, external_id)
      );

      CREATE INDEX idx_observed_score ON observed_posts(platform, per_hour DESC);
      CREATE INDEX idx_observed_seen ON observed_posts(last_seen);
    `,
  },
  {
    /*
     * Токен сотрудника перестаёт лежать в базе открытым.
     *
     * Он и есть единственный ключ от панели — пароля нет вовсе. Сессии
     * хешировались с самого начала, токены нет: украденный дамп пускал внутрь
     * навсегда, и отзыв сессий от этого не спасал. С 11.09 база уезжает ещё и
     * в репозиторий бэкапов, так что это перестало быть теорией.
     *
     * Хранится тремя полями, каждое отвечает за своё:
     *   token_hash — sha256, по нему ищет вход. Обратно не разворачивается;
     *   token_enc  — шифротекст (secrets.js), чтобы человек мог посмотреть
     *                свой токен. Ключ лежит отдельным файлом и уезжает в
     *                бэкапы другой дорогой — дамп базы без него бесполезен;
     *   token_tail — шесть последних знаков для списка сотрудников: отличить
     *                одну строку от другой, не трогая ключ шифрования.
     */
    name: '015-staff-token-hash',
    run(database) {
      database.exec(`
        ALTER TABLE staff ADD COLUMN token_hash TEXT;
        ALTER TABLE staff ADD COLUMN token_enc  TEXT;
        ALTER TABLE staff ADD COLUMN token_tail TEXT;
      `);

      const update = database.prepare(
        'UPDATE staff SET token_hash = ?, token_enc = ?, token_tail = ? WHERE id = ?'
      );
      for (const row of database.prepare('SELECT id, token FROM staff').all()) {
        update.run(
          createHash('sha256').update(row.token).digest('hex'),
          encrypt(row.token),
          String(row.token).slice(-6),
          row.id
        );
      }

      // Индекс висел на открытом столбце — снять его обязательно до DROP.
      database.exec(`
        DROP INDEX IF EXISTS idx_staff_token;
        ALTER TABLE staff DROP COLUMN token;
        CREATE UNIQUE INDEX idx_staff_token_hash ON staff(token_hash);
      `);
    },
  },
  {
    /*
     * Сторож сроков жизни токенов.
     *
     * Таблица под это была заведена ещё миграцией 002, но с ключом по одной
     * площадке — на времена, когда доступы лежали в `.env` единым набором.
     * Теперь у каждой школы свой аккаунт, и срок у каждого свой: у академии
     * токен Threads может умереть за месяц до «Дошколярика». Пересобираем на
     * пару (проект, площадка). Терять нечего — писать в неё было некому.
     *
     * Почему вообще отдельная таблица, а не поле в `project_accounts`:
     * доступы правит человек, а это пишет сторож раз в шесть часов. Смешивать
     * их значит трогать шифрованные значения ради служебной отметки.
     */
    name: '016-token-health-per-project',
    sql: `
      DROP TABLE IF EXISTS token_health;

      CREATE TABLE token_health (
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        platform    TEXT NOT NULL,
        -- NULL означает «срок неизвестен или его нет»: у бессрочного токена
        -- системного пользователя и у токена бота Telegram даты смерти нет.
        expires_at  TEXT,
        -- Срок не всегда можно прочитать у площадки. У Threads его негде
        -- спросить, и он считается от дня, когда токен вписали. Такую дату
        -- помечаем, чтобы интерфейс не выдавал догадку за факт.
        estimated   INTEGER NOT NULL DEFAULT 0,
        state       TEXT NOT NULL DEFAULT 'unknown',
        account     TEXT NOT NULL DEFAULT '',
        checked_at  TEXT,
        last_error  TEXT,
        -- О какой беде уже писали в журнал. Без этого сторож повторял бы одно
        -- и то же предупреждение каждые шесть часов, и на третий день его
        -- перестали бы читать.
        warned_stage TEXT,
        PRIMARY KEY (project_id, platform)
      );
    `,
  },
  {
    /*
     * Правило Meta «90 дней без входа в приложение» — второй срок токена.
     *
     * Токен может быть бессрочным, а доступ приложения к данным — нет:
     * `debug_token` отдаёт его отдельно, `data_access_expires_at`. Сторож
     * смотрел только на срок токена, и 12.12.2026 у Instagram и Threads
     * доступ кончился бы без единого предупреждения.
     *
     *   data_access_at — когда кончится доступ к данным (ISO), NULL — не
     *                    отслеживается или площадка не отдала;
     *   reason         — какая из двух дат ближе: 'token' или 'data'. От
     *                    неё зависит, что советовать: продлить токен или
     *                    войти кнопкой заново.
     *
     * Стоит здесь, сразу после создания таблицы, а не в конце списка, — и это
     * законно: порядок выполнения задаёт массив, а не имя. Имя с буквой, чтобы
     * не спорить с номерами миграций, которые в тот же день писали в конец
     * списка соседние сессии.
     */
    name: '016a-token-data-access',
    sql: `
      ALTER TABLE token_health ADD COLUMN data_access_at TEXT;
      ALTER TABLE token_health ADD COLUMN reason TEXT;
    `,
  },
  {
    /*
     * Дата выпуска токена — отдельно от даты правки карточки.
     *
     * Срок жизни токена Threads спросить у площадки негде, и сторож считал его
     * от `updated_at` — даты любой правки карточки. 12.09.2026 это вскрылось на
     * деле: поправили id аккаунта, и расчётный срок токена сбросился на
     * «60 дней от сегодня», хотя сам токен не менялся. Через месяц такая правка
     * подарила бы токену лишний месяц жизни, и сторож проспал бы продление.
     *
     * Пишется в ISO с зоной, а не через `datetime('now')`: у той даты зоны нет,
     * и её приходилось дописывать руками при чтении — ровно та операция, что
     * однажды сдвинула время постов на три часа.
     *
     * Старым записям лучшее, что известно, — дата последней правки.
     */
    name: '017-token-saved-at',
    sql: `
      ALTER TABLE project_accounts ADD COLUMN token_saved_at TEXT;
      UPDATE project_accounts SET token_saved_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at);
    `,
  },
  {
    /*
     * Файл кадра снят с диска после публикации (см. retention.js).
     *
     * Строка остаётся: это история того, что уходило в сети. Интерфейсу
     * отметка говорит, что картинки по ссылке больше нет и рисовать битый
     * кадр не надо.
     */
    name: '018-media-purged',
    sql: `
      ALTER TABLE media ADD COLUMN purged_at TEXT;
      CREATE INDEX idx_media_stored ON media(stored_name);
    `,
  },
  {
    /*
     * Миниатюра кадра, сделанная браузером при загрузке.
     *
     * Оригинал снимается с диска после публикации, а история в календаре
     * должна остаться с картинкой. Миниатюру делает браузер, а не сервер:
     * на VPS нет ни sharp (нативная сборка), ни права грузить единственное
     * ядро обработкой, а браузер уже держит файл в руках.
     */
    name: '019-media-thumb',
    sql: `
      ALTER TABLE media ADD COLUMN thumb_name TEXT;
      ALTER TABLE media ADD COLUMN thumb_bytes INTEGER;
      CREATE INDEX idx_media_thumb ON media(thumb_name);
    `,
  },
  {
    /*
     * Цвета рубрик.
     *
     * Затравка красила все рубрики одним золотом, и в сетке расписания их
     * было не отличить. Одинаковый цвет у всех рубрик проекта — след
     * затравки, а не выбор, поэтому разводим его по палитре. Один раз:
     * дальше цвет выбирает человек, и повторять это при чтении нельзя.
     * Палитра переписана сюда, а не взята из schedule.js: миграция должна
     * делать то же самое, даже если палитра потом сменится.
     */
    name: '020-category-colors',
    run(db) {
      const palette = ['#e0a94b', '#7aa7e0', '#6fc39a', '#e08a5a', '#d47fa6', '#a58be0', '#5fbcbc', '#b5b85a'];
      const paint = db.prepare('UPDATE categories SET color = ? WHERE id = ?');
      for (const { project_id } of db.prepare('SELECT DISTINCT project_id FROM categories').all()) {
        const rows = db.prepare('SELECT id, color FROM categories WHERE project_id = ? ORDER BY position, id').all(project_id);
        if (rows.length < 2 || !rows.every((r) => r.color === palette[0])) continue;
        rows.forEach((r, i) => paint.run(palette[i % palette.length], r.id));
      }
    },
  },
  {
    /*
     * Подключение Facebook кнопкой — так, чтобы не сломать бессрочные токены.
     *
     * На 13.09.2026 у Facebook и Instagram стоят бессрочные токены страницы.
     * Замена их чем-то худшим — срочным токеном, токеном с меньшими правами,
     * токеном чужой страницы — останавливает постинг школы. Поэтому:
     *
     *   oauth_pending   — результат входа ждёт здесь, пока владелец не
     *                     выберет страницу и панель не проверит замену. До
     *                     этого карточка проекта не меняется вовсе. Токены
     *                     страниц лежат шифротекстом, живут 15 минут.
     *   account_backups — прежние доступы перед каждой заменой. Строка config
     *                     в том же виде, что в project_accounts (поля уже
     *                     зашифрованы), так что откат — перенос строки назад.
     */
    name: '021-oauth-pending-backups',
    sql: `
      CREATE TABLE oauth_pending (
        id         TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        staff_id   INTEGER NOT NULL,
        platform   TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE account_backups (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        platform       TEXT NOT NULL,
        config         TEXT NOT NULL,
        token_saved_at TEXT,
        reason         TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_account_backups ON account_backups(project_id, platform, id);
    `,
  },
  {
    /*
     * Рассылка, фаза 1: базы адресов (docs/рассылка.md, §4).
     *
     * Базы принадлежат школе. Человек — одна строка на школу, в скольких бы
     * базах он ни был; свои колонки файла живут в членстве, а не в контакте,
     * чтобы «курс» из одной базы не затирал «курс» из другой.
     *
     * Стоп-лист отдельно от контактов и по хешу адреса. Иначе повторная
     * загрузка той же базы воскрешала бы отписанных, а стёртый по просьбе
     * человек возвращался бы со следующим файлом.
     *
     * Время — ISO UTC с «Z»: урок миграции 017.
     */
    name: '022-mail-lists',
    sql: `
      CREATE TABLE mail_lists (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        consent_basis TEXT NOT NULL,
        consent_note  TEXT NOT NULL DEFAULT '',
        columns       TEXT NOT NULL DEFAULT '[]',
        created_by    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        archived_at   TEXT,
        UNIQUE (project_id, name)
      );

      CREATE TABLE mail_contacts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email       TEXT NOT NULL,
        name        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active',
        status_note TEXT,
        status_at   TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (project_id, email)
      );

      -- Исходный файл (source) лежит только до подтверждения или отказа:
      -- без него не сменить кодировку и лист, не загружая файл заново.
      CREATE TABLE mail_imports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        list_id     INTEGER REFERENCES mail_lists(id),
        source_name TEXT NOT NULL,
        source      BLOB,
        format      TEXT NOT NULL,
        encoding    TEXT,
        delimiter   TEXT,
        sheet       INTEGER,
        sheets      TEXT NOT NULL DEFAULT '[]',
        has_header  INTEGER NOT NULL DEFAULT 0,
        header      TEXT NOT NULL DEFAULT '[]',
        roles       TEXT NOT NULL DEFAULT '{}',
        stats       TEXT NOT NULL DEFAULT '{}',
        progress    TEXT NOT NULL DEFAULT '{}',
        status      TEXT NOT NULL,
        error       TEXT,
        created_by  INTEGER REFERENCES staff(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        finished_at TEXT
      );

      CREATE TABLE mail_list_members (
        list_id    INTEGER NOT NULL REFERENCES mail_lists(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES mail_contacts(id) ON DELETE CASCADE,
        attrs      TEXT NOT NULL DEFAULT '{}',
        import_id  INTEGER REFERENCES mail_imports(id),
        added_by   INTEGER REFERENCES staff(id) ON DELETE SET NULL,
        added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        removed_at TEXT,
        PRIMARY KEY (list_id, contact_id)
      );

      CREATE TABLE mail_suppressions (
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email_hash  TEXT NOT NULL,
        reason      TEXT NOT NULL,
        campaign_id INTEGER,
        note        TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (project_id, email_hash)
      );

      -- Разобранные строки до подтверждения — черновик, а не данные школы.
      CREATE TABLE mail_import_rows (
        import_id  INTEGER NOT NULL REFERENCES mail_imports(id) ON DELETE CASCADE,
        row_no     INTEGER NOT NULL,
        seq        INTEGER NOT NULL,
        email      TEXT,
        name       TEXT NOT NULL DEFAULT '',
        attrs      TEXT NOT NULL DEFAULT '{}',
        verdict    TEXT NOT NULL,
        issues     TEXT NOT NULL DEFAULT '[]',
        suggestion TEXT,
        decision   TEXT,
        PRIMARY KEY (import_id, seq)
      );

      CREATE INDEX idx_mail_lists_project ON mail_lists(project_id, archived_at);
      CREATE INDEX idx_mail_contacts_status ON mail_contacts(project_id, status);
      CREATE INDEX idx_mail_members_contact ON mail_list_members(contact_id);
      CREATE INDEX idx_mail_imports_status ON mail_imports(status, created_at);
      CREATE INDEX idx_mail_import_rows_verdict ON mail_import_rows(import_id, verdict);
    `,
  },
  {
    /*
     * Видео и сторис (13.09.2026).
     *
     * Паспорт ролика. Сервер знал о видео только размер файла: длительность и
     * размеры кадра не писались вовсе, и проверка «Reels Facebook до 90 с»
     * не срабатывала никогда. Длительность и размеры ложатся в уже
     * существующие столбцы, кодеки и частота кадров — в новые
     * (src/video-probe.js разбирает контейнер без ffmpeg).
     *
     * Кадры цели. Один набор файлов на все площадки не давал собрать «карусель
     * 4:5 в ленту + вертикальная сторис» одним постом. `media_ids` — JSON со
     * списком id кадров, NULL — все кадры поста, как было.
     *
     * Части публикации. Серия сторис — это отдельная публикация на каждый
     * кадр. Упади третий кадр из пяти — первые два уже вышли, и повтор не
     * имеет права выпустить их снова. `parts` — JSON с тем, что уже вышло:
     * id кадра, id публикации у площадки, ссылка.
     *
     * Имя с буквой по уговору 16a: номера в тот день писали в конец списка
     * несколько сессий сразу.
     */
    name: '022v-video-stories',
    sql: `
      ALTER TABLE media ADD COLUMN video_codec TEXT;
      ALTER TABLE media ADD COLUMN audio_codec TEXT;
      ALTER TABLE media ADD COLUMN fps REAL;
      ALTER TABLE post_targets ADD COLUMN media_ids TEXT;
      ALTER TABLE post_targets ADD COLUMN parts TEXT;
    `,
  },
  {
    /*
     * Звук Instagram (13.09.2026, src/audio.js).
     *
     * `post_targets.audio` — выбранный трек из библиотеки Instagram или
     * название собственного звука ролика, JSON. У цели, а не у поста: звук
     * бывает только у Instagram и только у Reels.
     *
     * `media.derived` — кадр, собранный панелью из других кадров (Reels из
     * фото рендерит браузер). JSON: из каких кадров и с какими настройками.
     * Такой кадр не «ещё один файл поста»: в цели, где кадры не выбраны явно,
     * он не попадает — иначе ролик ушёл бы в Telegram рядом с теми же фото.
     *
     * `trends.audio` — трендовый звук на доске трендов: из идеи он доезжает
     * до поста уже выбранным.
     */
    name: '023-instagram-audio',
    sql: `
      ALTER TABLE post_targets ADD COLUMN audio TEXT;
      ALTER TABLE media ADD COLUMN derived TEXT;
      ALTER TABLE trends ADD COLUMN audio TEXT;
    `,
  },
  {
    /**
     * Настройки цели, которые есть только у своей площадки (13.09.2026).
     *
     * `post_targets.options` — JSON. Сейчас его понимает Telegram:
     * `{pin, noPreview, button: {text, url}}` — закрепить пост, не рисовать
     * превью ссылки, кнопка-ссылка под последним сообщением. Отдельными
     * колонками не заводим: у каждой сети такие настройки свои, и колонка
     * на каждую превратила бы таблицу в свалку пустых полей.
     */
    name: '024t-target-options',
    sql: `ALTER TABLE post_targets ADD COLUMN options TEXT;`,
  },
  {
    /*
     * Рассылка, фаза 2: ящики-отправители, пробные письма, отписки
     * (docs/рассылка.md, §4 и §8).
     *
     * Ящик — общий на панель, а не на школу: потолок Google считается на ящик.
     * В базе только refresh-токен шифротекстом; access-токен живёт час и
     * держится в памяти процесса. `token_expires_at` заполнен, только если
     * Google сам назвал срок — так выглядит приложение, забытое в Testing.
     *
     * Пробные письма пишутся отдельно от будущей очереди рассылок: по ним
     * видно «эту версию письма смотрели глазами», и они входят в суточный
     * счётчик ящика.
     */
    name: '025-mail-senders',
    sql: `
      CREATE TABLE mail_senders (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        provider          TEXT NOT NULL DEFAULT 'gmail',
        email             TEXT NOT NULL UNIQUE,
        display_name      TEXT NOT NULL DEFAULT '',
        kind              TEXT NOT NULL,
        refresh_token_enc TEXT,
        scopes            TEXT NOT NULL DEFAULT '',
        token_saved_at    TEXT,
        token_expires_at  TEXT,
        daily_cap         INTEGER,
        warmup_from       TEXT,
        window_from       TEXT NOT NULL DEFAULT '08:00',
        window_to         TEXT NOT NULL DEFAULT '21:00',
        paused_until      TEXT,
        state             TEXT NOT NULL DEFAULT 'unknown',
        checked_at        TEXT,
        last_error        TEXT,
        warned_stage      TEXT,
        connected_by      INTEGER REFERENCES staff(id) ON DELETE SET NULL,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        disconnected_at   TEXT
      );

      CREATE TABLE mail_test_sends (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id    INTEGER NOT NULL REFERENCES mail_senders(id),
        campaign_id  INTEGER,
        content_hash TEXT,
        to_email     TEXT NOT NULL,
        gmail_id     TEXT,
        sent_by      INTEGER REFERENCES staff(id) ON DELETE SET NULL,
        sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE mail_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL,
        campaign_id INTEGER,
        contact_id  INTEGER,
        type        TEXT NOT NULL,
        source      TEXT NOT NULL,
        note        TEXT,
        at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX idx_mail_tests_sender ON mail_test_sends(sender_id, sent_at);
      CREATE INDEX idx_mail_events_campaign ON mail_events(campaign_id, type);
      CREATE INDEX idx_mail_events_contact ON mail_events(contact_id, at);
    `,
  },
  {
    /*
     * Аккаунты, за которыми следим (14.09.2026, src/trends/accounts.js).
     *
     * Конкуренты и образцы подачи — на экране трендов рядом с фразами.
     * Instagram собирается машиной (Business Discovery): суточный снимок
     * подписчиков — ради прироста за неделю, последние посты — ради сравнения
     * «этот пост против обычного у того же аккаунта». Остальные площадки
     * хранятся ссылкой: чужих цифр их API не отдаёт.
     *
     * `signaled` — пост уже ушёл сигналом на доску трендов: без отметки каждый
     * суточный обход клал бы туда тот же пост заново.
     */
    name: '026-watched-accounts',
    sql: `
      CREATE TABLE watched_accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        platform     TEXT NOT NULL,
        username     TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'competitor',
        note         TEXT NOT NULL DEFAULT '',
        display_name TEXT,
        followers    INTEGER,
        media_count  INTEGER,
        checked_at   TEXT,
        last_error   TEXT,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (project_id, platform, username)
      );

      CREATE TABLE watched_snapshots (
        account_id  INTEGER NOT NULL REFERENCES watched_accounts(id) ON DELETE CASCADE,
        observed_on TEXT NOT NULL,
        followers   INTEGER,
        media_count INTEGER,
        PRIMARY KEY (account_id, observed_on)
      );

      CREATE TABLE watched_posts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id  INTEGER NOT NULL REFERENCES watched_accounts(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        kind        TEXT,
        caption     TEXT NOT NULL DEFAULT '',
        permalink   TEXT,
        posted_at   TEXT,
        likes       INTEGER,
        comments    INTEGER,
        views       INTEGER,
        signaled    INTEGER NOT NULL DEFAULT 0,
        first_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (account_id, external_id)
      );

      CREATE INDEX idx_watched_project ON watched_accounts(project_id, platform);
      CREATE INDEX idx_watched_posts ON watched_posts(account_id, posted_at);
    `,
  },
  {
    /*
     * Рассылка, фаза 3: письма (docs/рассылка.md, §4 и §9–10).
     *
     * Содержимое письма — блоки JSON, из них собирается и предпросмотр, и
     * пробное, и боевое письмо: что видели, то и уходит. `content_hash` —
     * отпечаток содержимого; утверждение запоминает свой отпечаток, и правка
     * после утверждения возвращает письмо в черновик, а воркер не отправит
     * письмо, отпечаток которого разошёлся с утверждённым.
     *
     * Картинки писем — отдельно от кадров постов: свой каталог без публичной
     * раздачи (получателю картинка приходит внутри письма) и свой срок жизни —
     * пока письмо не разослано до последнего адресата.
     */
    name: '027-mail-campaigns',
    sql: `
      CREATE TABLE mail_campaigns (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sender_id     INTEGER REFERENCES mail_senders(id),
        title         TEXT NOT NULL DEFAULT '',
        subject       TEXT NOT NULL DEFAULT '',
        preheader     TEXT NOT NULL DEFAULT '',
        from_name     TEXT NOT NULL DEFAULT '',
        reply_to      TEXT,
        blocks        TEXT NOT NULL DEFAULT '[]',
        content_hash  TEXT,
        status        TEXT NOT NULL DEFAULT 'draft',
        review_note   TEXT,
        approved_by   INTEGER REFERENCES staff(id) ON DELETE SET NULL,
        approved_at   TEXT,
        approved_hash TEXT,
        scheduled_at  TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        pause_reason  TEXT,
        copied_from   INTEGER REFERENCES mail_campaigns(id) ON DELETE SET NULL,
        created_by    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        deleted_at    TEXT
      );

      CREATE TABLE mail_campaign_lists (
        campaign_id INTEGER NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
        list_id     INTEGER NOT NULL REFERENCES mail_lists(id),
        mode        TEXT NOT NULL DEFAULT 'include',
        PRIMARY KEY (campaign_id, list_id)
      );

      CREATE TABLE mail_media (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id   INTEGER NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
        stored_name   TEXT NOT NULL,
        original_name TEXT NOT NULL DEFAULT '',
        mime          TEXT NOT NULL,
        bytes         INTEGER NOT NULL,
        width         INTEGER,
        height        INTEGER,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        purged_at     TEXT
      );

      CREATE INDEX idx_mail_campaigns_project ON mail_campaigns(project_id, deleted_at, updated_at);
      CREATE INDEX idx_mail_campaigns_due ON mail_campaigns(status, scheduled_at);
      CREATE INDEX idx_mail_media_campaign ON mail_media(campaign_id);
      CREATE INDEX idx_mail_media_stored ON mail_media(stored_name);
    `,
  },
  {
    /*
     * Рассылка, фаза 4: отправка (docs/рассылка.md, §10).
     *
     * Одно письмо одному человеку — строка `mail_sends`. Снимок получателей
     * делается в момент старта: база, поправленная посреди многодневной
     * рассылки, не даёт ни дублей, ни пропусков. UNIQUE (campaign_id, email) —
     * страховка самой базы от второго письма тому же адресу в той же рассылке.
     *
     * `sending` — письмо захвачено отправщиком; не дождались ответа Google —
     * `unknown`, и повторять его сама очередь не будет: дубль хуже пропажи.
     *
     * `link_map` — короткие ссылки рассылки: одна на адрес в письме, общая
     * для всех получателей. `hold_reason` — почему ящик придержан до
     * `paused_until` (Google попросил притормозить или кончился лимит).
     */
    name: '028-mail-sends',
    sql: `
      CREATE TABLE mail_sends (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id   INTEGER NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
        sender_id     INTEGER NOT NULL REFERENCES mail_senders(id),
        contact_id    INTEGER REFERENCES mail_contacts(id) ON DELETE SET NULL,
        email         TEXT NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        via_list_id   INTEGER,
        status        TEXT NOT NULL DEFAULT 'queued',
        attempts      INTEGER NOT NULL DEFAULT 0,
        not_before    TEXT,
        sending_since TEXT,
        sent_at       TEXT,
        gmail_id      TEXT,
        error         TEXT,
        UNIQUE (campaign_id, email)
      );

      CREATE INDEX idx_mail_sends_queue ON mail_sends(campaign_id, status, id);
      CREATE INDEX idx_mail_sends_sender_day ON mail_sends(sender_id, sent_at);
      CREATE INDEX idx_mail_sends_contact ON mail_sends(contact_id);
      CREATE INDEX idx_mail_sends_email ON mail_sends(email, status);

      ALTER TABLE mail_campaigns ADD COLUMN link_map TEXT;
      ALTER TABLE mail_senders ADD COLUMN hold_reason TEXT;
      ALTER TABLE links ADD COLUMN mail_campaign_id INTEGER REFERENCES mail_campaigns(id) ON DELETE SET NULL;
    `,
  },
  {
    /*
     * Подписка с сайтов (docs/рассылка.md, фаза 6): форма в подвале сайта.
     *
     * Двойное подтверждение: адрес попадает в базу только после нажатия
     * кнопки в письме. Иначе форму заполнит кто угодно чужим адресом, и
     * рассылка начнёт слать тем, кто ни на что не подписывался, — прямая
     * дорога в «Спам» для всех писем ящика.
     *
     * В строке — хеш токена, а не сам токен: утечка базы не даёт подтвердить
     * чужие подписки. `ip_hash` — для ограничения частоты, без самого адреса.
     */
    name: '029-mail-signups',
    sql: `
      CREATE TABLE mail_signups (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email           TEXT NOT NULL,
        token_hash      TEXT NOT NULL UNIQUE,
        status          TEXT NOT NULL DEFAULT 'pending',
        site            TEXT NOT NULL DEFAULT '',
        page            TEXT NOT NULL DEFAULT '',
        ip_hash         TEXT,
        error           TEXT,
        contact_id      INTEGER REFERENCES mail_contacts(id) ON DELETE SET NULL,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        confirm_sent_at TEXT,
        confirmed_at    TEXT
      );

      CREATE INDEX idx_mail_signups_email ON mail_signups(project_id, email, created_at);
      CREATE INDEX idx_mail_signups_ip ON mail_signups(ip_hash, created_at);
    `,
  },
  {
    /*
     * Подписка с сайтов: доказательство согласия и источник (14.09.2026, мост
     * «CRM школы ↔ панель»; 029 уже выкачена, поэтому отдельной миграцией).
     *
     * `consent_version` — код текста согласия, который человек видел рядом с
     * формой: закон о персональных данных и п. 7.2 политики требуют отдельного
     * согласия на маркетинг, а текст у формы со временем меняется. `lang` —
     * язык страницы подписки. utm — откуда пришёл: замыкает отчёт «пост или
     * реклама → подписка».
     */
    name: '030-mail-signup-consent',
    sql: `
      ALTER TABLE mail_signups ADD COLUMN consent_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE mail_signups ADD COLUMN lang TEXT NOT NULL DEFAULT 'uk';
      ALTER TABLE mail_signups ADD COLUMN utm_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE mail_signups ADD COLUMN utm_medium TEXT NOT NULL DEFAULT '';
      ALTER TABLE mail_signups ADD COLUMN utm_campaign TEXT NOT NULL DEFAULT '';
      ALTER TABLE mail_signups ADD COLUMN referrer TEXT NOT NULL DEFAULT '';
      ALTER TABLE mail_signups ADD COLUMN landing_path TEXT NOT NULL DEFAULT '';
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
      // Шаг бывает двух видов. Обычный — голый SQL. Второй появился, когда
      // понадобилось перешифровать уже лежащие в базе данные: такое SQL не
      // умеет, а разносить это на «миграцию + скрипт руками» значит однажды
      // выкатить схему и забыть скрипт.
      if (m.sql) db.exec(m.sql);
      if (m.run) m.run(db);
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
  const media = db
    .prepare('SELECT id, post_id, kind, stored_name, mime, purged_at, thumb_name FROM media ORDER BY position')
    .all();
  for (const p of posts) {
    p.targets = targets.filter((t) => t.post_id === p.id);
    p.media = media.filter((m) => m.post_id === p.id);
  }
  return posts;
}

export function touchPost(id) {
  db.prepare("UPDATE posts SET updated_at = datetime('now') WHERE id = ?").run(id);
}
