/**
 * Журнал: чтение `publish_log` так, чтобы на «почему не ушло» отвечалось
 * за один взгляд, а не пролистыванием перезапусков воркера.
 *
 * Категория события не хранится в базе, а считается по тексту при чтении.
 * Причины две. Записи пишутся из шести десятков мест, и протаскивать новый
 * аргумент через каждое значит однажды забыть его в новом. А правило,
 * поправленное здесь, сразу переразмечает и всю старую историю — колонка
 * в базе так не умеет.
 */

import { db } from './db.js';
import { PLATFORMS } from './platforms/specs.js';
import { getSetting, setSetting } from './staff.js';

export const KINDS = {
  publish: 'Публикации',
  post: 'Посты',
  access: 'Доступы и настройки',
  people: 'Входы и сотрудники',
  system: 'Служебное',
  mail: 'Рассылка',
};

/*
 * Порядок правил важен: срабатывает первое. «Неудачный вход по токену» —
 * про людей, хотя в нём есть слово «токен», поэтому люди идут раньше доступов.
 */
const RULES = [
  // Рассылка пишет с приставкой — и в ней бывают «доступ» и «сотрудник»,
  // поэтому её правило стоит первым.
  ['mail', /^рассылка: /],
  ['people', /^вход: |неудачный вход|сотрудник|перевыпущен токен:|заведён владелец|файл с токеном владельца/],
  [
    'publish',
    /^опубликовано:|^не ушло в |не отправлен:|публиковать некуда|с опозданием|не знаем, ушёл ли|завис в отправке|в очередь немедленно|повтор|подменено ссылок|снят из сети|после ручной проверки/,
  ],
  [
    'system',
    /^воркер|^сторож токенов|необработанная ошибка|место под файлы|загрузка отклонена по квоте|подмести|снять файлы|^убрано |^сняты с диска|^сбор трендов|^из ленты принято/,
  ],
  ['post', /создан пост|^пост #\d+|миниатюра отклонена|добавлен тренд/],
  [
    'access',
    /токен|доступ|подключ|^вход facebook|ключ приёма ленты|заявкам школы|согласование постов|заведён проект/i,
  ],
];

/*
 * Штатный пульс системы: сам по себе ничего не значит, но при каждом
 * перезапуске его набегает по паре строк. В ленте такие записи, идущие
 * подряд, сворачиваются в одну — иначе они вытесняют с экрана настоящие.
 */
const ROUTINE = /^воркер запущен|^сторож токенов проверил|^убрано (файлов|миниатюр)|^сняты с диска|^сбор трендов:|^из ленты принято/;

const SUCCESS = /^опубликовано:|подключён кнопкой|продлён/;

export function classify({ message = '', level = 'info', platform = null, post_id = null }) {
  let kind = RULES.find(([, re]) => re.test(message))?.[0];
  if (!kind) kind = post_id ? 'post' : platform ? 'access' : 'system';
  const tone = level === 'error' ? 'danger' : level === 'warn' ? 'warn' : SUCCESS.test(message) ? 'ok' : '';
  const routine = kind === 'system' && level === 'info' && ROUTINE.test(message);
  return { kind, tone, routine };
}

// Функции живут в соединении: фильтр по категории и поиск без учёта регистра
// работают в самом запросе, и подгрузка страниц не пропускает записи.
// Встроенные lower() и LIKE в SQLite понимают регистр только у латиницы.
db.function('journal_kind', { deterministic: true }, (message, level, platform, postId) =>
  classify({ message, level, platform, post_id: postId }).kind
);
db.function('journal_has', { deterministic: true }, (text, needle) =>
  String(text ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase()) ? 1 : 0
);

const PLATFORM_WORD = new RegExp(`\\b(${Object.keys(PLATFORMS).join('|')})\\b`, 'g');

/**
 * Текст записи для человека. Сам текст в базе не трогаем — меняется только
 * показ: названия площадок с заглавной и проект по имени, а не «#1».
 */
function humanize(message, projectTitles) {
  let text = String(message)
    .replace(PLATFORM_WORD, (id) => PLATFORMS[id]?.title || id)
    .replace(/(проекта?) #(\d+)/g, (whole, word, id) =>
      projectTitles.has(Number(id)) ? `${word} «${projectTitles.get(Number(id))}»` : whole
    );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function snippet(post) {
  const source = (post.title || '').trim() || String(post.body || '').trim().split('\n')[0];
  if (!source) return 'без текста';
  return source.length > 70 ? `${source.slice(0, 68).trimEnd()}…` : source;
}

function linkFrom(payload) {
  if (!payload) return null;
  try {
    const url = JSON.parse(payload)?.url;
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Время в журнале пишется SQLite-ом в UTC без зоны — отдаём с зоной. */
function isoUtc(stamp) {
  return stamp ? `${String(stamp).replace(' ', 'T')}Z` : null;
}

/**
 * @param {{kind?: string, problems?: boolean, platform?: string, q?: string,
 *   before?: number, limit?: number, role: string}} opts
 */
export function listJournal({ kind = '', problems = false, platform = '', q = '', before = 0, limit = 100, role }) {
  const where = [];
  const params = [];
  const kindExpr = 'journal_kind(l.message, l.level, l.platform, l.post_id)';

  // Неудачные входы с хвостом токена и перевыпуск чужих ключей СММщику не
  // показываем: раздел «Сотрудники» ему закрыт, и журнал не должен быть
  // обходом этого запрета.
  if (role !== 'owner') where.push(`${kindExpr} != 'people'`);
  if (kind && KINDS[kind]) {
    where.push(`${kindExpr} = ?`);
    params.push(kind);
  }
  if (problems) where.push("l.level IN ('error', 'warn')");
  if (platform && PLATFORMS[platform]) {
    where.push('l.platform = ?');
    params.push(platform);
  }
  const needle = String(q || '').trim();
  if (needle) {
    const postNo = needle.match(/^#?(\d+)$/);
    if (postNo) {
      where.push('(l.post_id = ? OR journal_has(l.message, ?))');
      params.push(Number(postNo[1]), needle);
    } else {
      where.push('(journal_has(l.message, ?) OR journal_has(p.title, ?) OR journal_has(p.body, ?))');
      params.push(needle, needle, needle);
    }
  }
  if (Number(before) > 0) {
    where.push('l.id < ?');
    params.push(Number(before));
  }

  const size = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const rows = db
    .prepare(
      `SELECT l.id, l.post_id, l.platform, l.level, l.message, l.payload, l.created_at,
              p.title AS post_title, p.body AS post_body, p.status AS post_status,
              p.deleted_at AS post_deleted, p.project_id,
              pr.title AS project_title, pr.accent AS project_accent
         FROM publish_log l
         LEFT JOIN posts p ON p.id = l.post_id
         LEFT JOIN projects pr ON pr.id = p.project_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.id DESC
        LIMIT ?`
    )
    .all(...params, size);

  const projectTitles = new Map(db.prepare('SELECT id, title FROM projects').all().map((p) => [p.id, p.title]));

  const log = rows.map((r) => ({
    id: r.id,
    at: isoUtc(r.created_at),
    level: r.level,
    platform: r.platform,
    message: humanize(r.message, projectTitles),
    ...classify(r),
    link: linkFrom(r.payload),
    post: r.post_id
      ? {
          id: r.post_id,
          exists: r.post_status != null,
          title: r.post_status != null ? snippet({ title: r.post_title, body: r.post_body }) : null,
          status: r.post_status,
          deleted: Boolean(r.post_deleted),
          project: r.project_id ? { id: r.project_id, title: r.project_title, accent: r.project_accent } : null,
        }
      : null,
  }));

  return { log, nextBefore: rows.length === size ? rows[rows.length - 1].id : null };
}

/* ------------------------------- сводка ------------------------------- */

const HEARTBEAT_KEY = 'worker_heartbeat';

/** Воркер отмечается каждый тик: по журналу видно запуск, но не смерть. */
export function workerHeartbeat(tickMs) {
  setSetting(HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), tickMs }));
}

export function workerState(now = Date.now()) {
  let beat = null;
  try {
    beat = JSON.parse(getSetting(HEARTBEAT_KEY, 'null'));
  } catch {
    beat = null;
  }
  if (!beat?.at) return { state: 'unknown', seenAt: null, tickMs: null };
  const tickMs = Number(beat.tickMs) || 60000;
  const ago = now - Date.parse(beat.at);
  // Три пропущенных тика, но не меньше трёх минут: долгая выгрузка видео
  // держит тик, а не убивает воркер, и паниковать от неё не нужно.
  const silent = ago > Math.max(tickMs * 3, 180000);
  return { state: silent ? 'silent' : 'alive', seenAt: beat.at, tickMs, agoMs: Math.max(ago, 0) };
}

export function journalSummary({ days = 7, role, now = Date.now() } = {}) {
  const since = new Date(now - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const hidePeople = role !== 'owner' ? "AND journal_kind(message, level, platform, post_id) != 'people'" : '';

  const byPlatform = db
    .prepare(
      `SELECT platform, COUNT(*) AS n FROM post_targets
        WHERE status = 'published' AND published_at >= ?
        GROUP BY platform ORDER BY n DESC`
    )
    .all(since)
    .map((r) => ({ platform: r.platform, count: r.n }));

  const failures = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM publish_log
        WHERE level = 'error' AND created_at >= ?
          AND journal_kind(message, level, platform, post_id) = 'publish'`
    )
    .get(since);

  const problems = db
    .prepare(`SELECT COUNT(*) AS n FROM publish_log WHERE level IN ('error', 'warn') AND created_at >= ? ${hidePeople}`)
    .get(since);

  // Что висит прямо сейчас, а не что падало за неделю: упавший и потом
  // ушедший пост решения уже не ждёт.
  const waiting = db
    .prepare(
      `SELECT p.id FROM posts p
        WHERE p.deleted_at IS NULL
          AND (p.status IN ('failed', 'partial')
               OR EXISTS (SELECT 1 FROM post_targets t WHERE t.post_id = p.id AND t.status = 'needs_check'))
        ORDER BY p.id DESC`
    )
    .all()
    .map((r) => r.id);

  return {
    days,
    published: { total: byPlatform.reduce((s, r) => s + r.count, 0), byPlatform },
    failures: { count: failures.n, lastAt: isoUtc(failures.last) },
    problems: problems.n,
    waiting: { count: waiting.length, ids: waiting.slice(0, 5) },
    worker: workerState(now),
  };
}
