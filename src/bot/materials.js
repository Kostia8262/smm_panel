/**
 * Материалы бота: то, на что он опирается.
 *
 * Отличие от базы ответов простое. **Ответ** уходит клиенту дословно, поэтому
 * он короткий и один на вопрос. **Материал** — справка блоком: курс целиком,
 * тариф, контакты, выдержка с сайта. Его не отправляют — из него делают
 * ответ одной кнопкой, и в нём ищут, когда вопрос попал к человеку.
 *
 * Два правила:
 *   1. Собранное с сайта обновляется по `source_key` — повторный сбор правит
 *      свой же блок, а не плодит двойники, и **не трогает написанное руками**.
 *   2. Удаления нет: блок уходит в архив и возвращается оттуда.
 */

import { db, log } from '../db.js';
import { flat, tokens } from './normalize.js';
import { SITE_BY_SLUG, collectFromSite } from './site-import.js';
import * as knowledge from './knowledge.js';

const { BotError } = knowledge;

/** Разделы материалов. Порядок — порядок показа на экране. */
export const SECTIONS = {
  courses: { title: 'Курси та програми' },
  prices: { title: 'Ціни та тарифи' },
  schedule: { title: 'Розклад і формат' },
  faq: { title: 'Часті питання' },
  contacts: { title: 'Контакти та філії' },
  rules: { title: 'Правила та документи' },
  own: { title: 'Своє' },
};

export const SECTION_LIST = Object.keys(SECTIONS);

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function fromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    section: r.section,
    sectionTitle: SECTIONS[r.section]?.title || r.section,
    title: r.title,
    body: r.body,
    sourceUrl: r.source_url,
    sourceKey: r.source_key,
    origin: r.origin,
    position: r.position,
    archivedAt: r.archived_at,
    updatedAt: r.updated_at,
  };
}

export function list(projectId, { archived = false, section = '', search = '' } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM bot_materials
        WHERE project_id = ?
          AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
        ORDER BY section, position, id`
    )
    .all(projectId);
  const needle = String(search || '').trim().toLowerCase();
  return rows
    .filter((r) => !section || r.section === section)
    .filter((r) => !needle || `${r.title} ${r.body}`.toLowerCase().includes(needle))
    .map(fromRow);
}

export function get(id) {
  const row = db.prepare('SELECT * FROM bot_materials WHERE id = ?').get(id);
  return row ? fromRow(row) : null;
}

export function sections(projectId) {
  const counts = db
    .prepare(
      `SELECT section, COUNT(*) AS total FROM bot_materials
        WHERE project_id = ? AND archived_at IS NULL GROUP BY section`
    )
    .all(projectId);
  const byId = Object.fromEntries(counts.map((c) => [c.section, c.total]));
  return SECTION_LIST.map((id) => ({ id, title: SECTIONS[id].title, total: byId[id] || 0 }));
}

function clean(data, current = {}) {
  const out = {
    section: String(data.section ?? current.section ?? 'own'),
    title: String(data.title ?? current.title ?? '').trim(),
    body: String(data.body ?? current.body ?? '').trim(),
    sourceUrl: String(data.sourceUrl ?? current.sourceUrl ?? '').trim() || null,
    position: Number(data.position ?? current.position ?? 0) || 0,
  };
  if (!SECTIONS[out.section]) throw new BotError('Неизвестный раздел материалов');
  if (!out.title) throw new BotError('У блока должно быть название — по нему его находят');
  if (!out.body) throw new BotError('Пустой блок боту не опора: напишите, что в нём');
  return out;
}

export function create(projectId, data) {
  const v = clean(data);
  const info = db
    .prepare(
      `INSERT INTO bot_materials (project_id, section, title, body, source_url, position, origin)
       VALUES (?, ?, ?, ?, ?, ?, 'own')`
    )
    .run(projectId, v.section, v.title, v.body, v.sourceUrl, v.position);
  return get(Number(info.lastInsertRowid));
}

export function update(id, data) {
  const current = get(id);
  if (!current) throw new BotError('Блок не найден', 404);
  const v = clean(data, current);
  db.prepare(
    `UPDATE bot_materials SET section = ?, title = ?, body = ?, source_url = ?, position = ?, updated_at = ?
      WHERE id = ?`
  ).run(v.section, v.title, v.body, v.sourceUrl, v.position, nowIso(), id);
  return get(id);
}

export function setArchived(id, archived) {
  const current = get(id);
  if (!current) throw new BotError('Блок не найден', 404);
  db.prepare('UPDATE bot_materials SET archived_at = ?, updated_at = ? WHERE id = ?').run(
    archived ? nowIso() : null,
    nowIso(),
    id
  );
  return get(id);
}

/* ------------------------------ сбор с сайта ------------------------------ */

/** Адрес сайта школы: заданный владельцем или известный по слагу проекта. */
export function siteUrlFor(project, settingsRow) {
  const own = String(settingsRow?.siteUrl || '').trim();
  return own || SITE_BY_SLUG[project?.slug] || '';
}

/**
 * Разложить собранное по базе.
 *
 * Блок с сайта узнаётся по `source_key`: он обновляется на месте, сохраняя
 * правки раздела и позиции. Чужого — написанного владельцем — сбор не
 * касается вовсе.
 */
export function applyCollected(projectId, collected) {
  const existing = db
    .prepare('SELECT * FROM bot_materials WHERE project_id = ? AND source_key IS NOT NULL')
    .all(projectId);
  const byKey = new Map(existing.map((r) => [r.source_key, r]));

  let added = 0;
  let updated = 0;
  let same = 0;

  const insert = db.prepare(
    `INSERT INTO bot_materials (project_id, section, title, body, source_url, source_key, origin, position)
     VALUES (?, ?, ?, ?, ?, ?, 'site', ?)`
  );
  const change = db.prepare(
    'UPDATE bot_materials SET title = ?, body = ?, source_url = ?, archived_at = NULL, updated_at = ? WHERE id = ?'
  );

  for (const [i, m] of collected.materials.entries()) {
    const row = byKey.get(m.sourceKey);
    if (!row) {
      insert.run(projectId, m.section, m.title, m.body, m.sourceUrl || null, m.sourceKey, i);
      added += 1;
      continue;
    }
    if (row.title === m.title && row.body === m.body && !row.archived_at) {
      same += 1;
      continue;
    }
    change.run(m.title, m.body, m.sourceUrl || null, nowIso(), row.id);
    updated += 1;
  }

  log('info', `бот: сбор с сайта — ${added} новых блоков, ${updated} обновлено, ${same} без изменений`);
  return { added, updated, same, total: collected.materials.length };
}

/**
 * Заготовки ответов с сайта: вопросы FAQ, которых ещё нет в базе ответов.
 *
 * Сами ответы не заводим молча — владелец решает, что из этого отдавать
 * клиентам от своего имени.
 */
export function pendingAnswers(projectId, answers) {
  const live = knowledge.list(projectId).map((e) => flat(e.question));
  const archived = knowledge.list(projectId, { archived: true }).map((e) => flat(e.question));
  const known = new Set([...live, ...archived]);
  return answers.filter((a) => !known.has(flat(a.question)));
}

export async function collect(project, settings) {
  const site = siteUrlFor(project, settings);
  if (!site) throw new BotError('Не знаю, с какого сайта собирать — впишите адрес в настройках бота');
  const collected = await collectFromSite(site);
  const stats = applyCollected(project.id, collected);
  return { site, stats, notes: collected.notes, answers: pendingAnswers(project.id, collected.answers) };
}

/* ------------------------------ связь с ботом ------------------------------ */

/**
 * Материалы, похожие на вопрос.
 *
 * Отправлять их бот не может — они длинные и писались для чтения. Но когда
 * ответа нет, человек должен сразу видеть, где смотреть, а владелец — из чего
 * сделать ответ.
 */
export function relevant(projectId, text, limit = 3) {
  const words = tokens(text);
  if (!words.length) return [];
  return list(projectId)
    .map((m) => {
      // Название весит вдвое против текста. Без этого вопрос «що вивчають на
      // Roblox» вытаскивал блок про Minecraft: слово «вивчають» нашлось в его
      // описании, а название с нужным курсом весило столько же.
      const inTitle = tokens(m.title);
      const inBody = tokens(m.body);
      // Вес текста мал намеренно: «Roblox» в названии должен перевешивать два
      // общих слова («саме», «вивчають»), найденных в описании другого курса.
      const score = words.reduce((sum, w) => sum + (inTitle.includes(w) ? 1 : inBody.includes(w) ? 0.3 : 0), 0) / words.length;
      return { material: m, score: Math.min(score, 1) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      id: r.material.id,
      title: r.material.title,
      section: r.material.section,
      sectionTitle: r.material.sectionTitle,
      score: Number(r.score.toFixed(2)),
    }));
}

/** Сделать из блока ответ бота: текст и зацепки подставляются, править — владельцу. */
export function toAnswer(id) {
  const m = get(id);
  if (!m) throw new BotError('Блок не найден', 404);
  return {
    topic: m.section === 'own' ? '' : SECTIONS[m.section]?.title || '',
    question: m.title,
    answer: m.body,
    triggers: m.title,
    materialId: m.id,
  };
}
