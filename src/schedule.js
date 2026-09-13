/**
 * Слоты расписания и рубрики-очереди.
 *
 * Смысл слотов: время публикации — решение, принимаемое один раз для всей
 * школы, а не заново для каждого поста. «Пн, ср, пт в 10:00 и 18:30» —
 * и дальше пост просто падает в ближайший свободный слот.
 *
 * Смысл рубрик: у школы контент повторяемый и сезонный. Рубрика — это
 * очередь со своим ритмом, а помеченная «вечнозелёной» возвращает лучшее
 * в оборот вместо того, чтобы хоронить пост после первой публикации.
 *
 * Время везде местное и без зоны — как и остальная панель.
 */

import { db, log } from './db.js';

const pad = (n) => String(n).padStart(2, '0');

/** ISO-нумерация: 1 — понедельник, 7 — воскресенье. */
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:00`;
}

/* -------------------------------- рубрики -------------------------------- */

export function listCategories(projectId) {
  return db
    .prepare('SELECT * FROM categories WHERE project_id = ? ORDER BY position, id')
    .all(projectId)
    .map((row) => ({
      id: row.id,
      title: row.title,
      color: row.color,
      evergreen: Boolean(row.evergreen),
      recycleDays: row.recycle_days,
      position: row.position,
    }));
}

export function createCategory(projectId, { title, color = '#e0a94b', evergreen = false, recycleDays = 60 }) {
  const clean = String(title || '').trim();
  if (!clean) throw new Error('Не указано название рубрики');
  const position = (db.prepare('SELECT COALESCE(MAX(position), 0) m FROM categories WHERE project_id = ?').get(projectId).m || 0) + 1;
  try {
    const info = db
      .prepare(
        `INSERT INTO categories (project_id, title, color, evergreen, recycle_days, position)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(projectId, clean, color, evergreen ? 1 : 0, Number(recycleDays) || 60, position);
    return listCategories(projectId).find((c) => c.id === Number(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error(`Рубрика «${clean}» уже есть`);
    throw err;
  }
}

export function updateCategory(id, { title, color, evergreen, recycleDays }) {
  const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!row) throw new Error('Рубрика не найдена');
  db.prepare(
    'UPDATE categories SET title = ?, color = ?, evergreen = ?, recycle_days = ? WHERE id = ?'
  ).run(
    title !== undefined ? String(title).trim() : row.title,
    color || row.color,
    evergreen === undefined ? row.evergreen : evergreen ? 1 : 0,
    recycleDays === undefined ? row.recycle_days : Number(recycleDays) || 60,
    id
  );
  return listCategories(row.project_id).find((c) => c.id === id);
}

export function removeCategory(id) {
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

/** Первый запуск проекта: сетка из ходовых рубрик, дальше правит жизнь. */
export function seedCategories(projectId) {
  if (db.prepare('SELECT COUNT(*) n FROM categories WHERE project_id = ?').get(projectId).n) return;
  const seed = [
    { title: 'Работа ученика', evergreen: true },
    { title: 'Мем', evergreen: false },
    { title: 'Набор в группу', evergreen: false },
    { title: 'Разбор/полезное', evergreen: true },
    { title: 'Отзыв', evergreen: true },
    { title: 'Закулисье', evergreen: false },
  ];
  for (const c of seed) createCategory(projectId, c);
}

/* --------------------------------- слоты --------------------------------- */

export function listSlots(projectId) {
  return db
    .prepare(
      `SELECT s.*, c.title AS category_title, c.color AS category_color
       FROM slots s LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.project_id = ? ORDER BY s.weekday, s.time`
    )
    .all(projectId)
    .map((row) => ({
      id: row.id,
      weekday: row.weekday,
      weekdayTitle: WEEKDAYS[row.weekday - 1],
      time: row.time,
      categoryId: row.category_id,
      categoryTitle: row.category_title,
      categoryColor: row.category_color,
      active: Boolean(row.active),
    }));
}

export function addSlot(projectId, { weekday, time, categoryId = null }) {
  const day = Number(weekday);
  if (!(day >= 1 && day <= 7)) throw new Error('День недели указан неверно');
  const clean = String(time || '').trim();
  if (!/^\d{2}:\d{2}$/.test(clean)) throw new Error('Время нужно в виде ЧЧ:ММ');
  try {
    db.prepare('INSERT INTO slots (project_id, weekday, time, category_id) VALUES (?, ?, ?, ?)').run(
      projectId,
      day,
      clean,
      categoryId || null
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error('Такой слот уже есть');
    throw err;
  }
  return listSlots(projectId);
}

export function removeSlot(id) {
  db.prepare('DELETE FROM slots WHERE id = ?').run(id);
}

export function toggleSlot(id, active) {
  db.prepare('UPDATE slots SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

/* --------------------------- ближайший свободный --------------------------- */

/**
 * Ближайший слот, на который ещё ничего не назначено.
 *
 * Занятым считается слот, где уже стоит пост этого проекта — иначе два поста
 * улягутся на одно время и выйдут подряд, чего слоты как раз и избегают.
 *
 * @param {number} projectId
 * @param {{categoryId?: number|null, after?: Date, horizonDays?: number, excludePostId?: number}} opts
 * @returns {string|null} время в формате базы или null, если сетка пуста
 */
export function nextFreeSlot(projectId, { categoryId = null, after = new Date(), horizonDays = 60, excludePostId = null } = {}) {
  const slots = listSlots(projectId).filter((s) => s.active);
  if (!slots.length) return null;

  // Слот без рубрики принимает что угодно; слот с рубрикой — только её.
  const usable = categoryId
    ? slots.filter((s) => !s.categoryId || s.categoryId === categoryId)
    : slots.filter((s) => !s.categoryId);
  if (!usable.length) return null;

  const taken = new Set(
    db
      .prepare(
        `SELECT scheduled_at FROM posts
         WHERE project_id = ? AND deleted_at IS NULL AND scheduled_at IS NOT NULL
           AND status IN ('scheduled', 'review', 'publishing', 'published', 'partial')
           AND (? IS NULL OR id != ?)`
      )
      .all(projectId, excludePostId, excludePostId)
      .map((r) => r.scheduled_at)
  );

  const cursor = new Date(after);
  cursor.setSeconds(0, 0);

  for (let day = 0; day <= horizonDays; day++) {
    const date = new Date(cursor);
    date.setDate(date.getDate() + day);
    const weekday = isoWeekday(date);

    const todays = usable
      .filter((s) => s.weekday === weekday)
      .sort((a, b) => a.time.localeCompare(b.time));

    for (const slot of todays) {
      const [h, m] = slot.time.split(':').map(Number);
      const when = new Date(date);
      when.setHours(h, m, 0, 0);
      if (when <= after) continue;
      const value = stamp(when);
      if (!taken.has(value)) return value;
    }
  }
  return null;
}

/**
 * Вечнозелёный повтор: после публикации пост возвращается в конец очереди
 * своей рубрики отдельной копией.
 *
 * Копией, а не переносом исходного: опубликованное должно остаться в истории
 * с датой и внешними id, иначе панель забудет, что уже выходило — а именно
 * это владелец и просил помнить.
 */
export function requeueEvergreen(postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post || !post.recycle || !post.category_id) return null;

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(post.category_id);
  if (!category || !category.evergreen) return null;

  const after = new Date();
  after.setDate(after.getDate() + (category.recycle_days || 60));
  const when = nextFreeSlot(post.project_id, { categoryId: post.category_id, after });
  if (!when) {
    log('warn', `нет свободного слота для повтора поста #${postId}`, { postId });
    return null;
  }

  const info = db
    .prepare(
      `INSERT INTO posts (title, body, status, scheduled_at, project_id, category_id, recycle, recycled_from, author_id)
       VALUES (?, ?, 'scheduled', ?, ?, ?, 1, ?, ?)`
    )
    .run(post.title, post.body, when, post.project_id, post.category_id, post.id, post.author_id);
  const copyId = Number(info.lastInsertRowid);

  const targets = db.prepare('SELECT platform, format_id, text_override FROM post_targets WHERE post_id = ?').all(postId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO post_targets (post_id, platform, format_id, text_override) VALUES (?, ?, ?, ?)'
  );
  for (const t of targets) insert.run(copyId, t.platform, t.format_id, t.text_override);

  const media = db.prepare('SELECT * FROM media WHERE post_id = ? ORDER BY position').all(postId);
  // Копия ссылается на те же файлы — и оригинал, и миниатюру. Снимать их с
  // диска можно только через retention.js, который считает все ссылки.
  const copyMedia = db.prepare(
    `INSERT INTO media (post_id, kind, original_name, stored_name, mime, bytes, width, height, duration, focus_x, focus_y, position, thumb_name, thumb_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const m of media) {
    copyMedia.run(copyId, m.kind, m.original_name, m.stored_name, m.mime, m.bytes, m.width, m.height, m.duration, m.focus_x, m.focus_y, m.position, m.thumb_name, m.thumb_bytes);
  }

  log('info', `вечнозелёный повтор: пост #${postId} вернулся копией #${copyId} на ${when}`, { postId: copyId });
  return { postId: copyId, scheduledAt: when };
}
