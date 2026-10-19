/**
 * База знаний бота и его настройки: чтение, правка, проверка.
 *
 * Два правила держат остальное:
 *   1. **Удаление — пометка** (`archived_at`). Выброшенный ответ часто нужен
 *      обратно, а на отправленные сообщения он ссылается из журнала.
 *   2. **Ответ не длиннее предела площадки.** Direct режет на 1000 символов,
 *      и узнать об этом при отправке — значит узнать слишком поздно.
 */

import { db, log } from '../db.js';
import { CHANNELS, LANGS, LIMITS } from './specs.js';
import { decide, triggerList } from './match.js';

export class BotError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/* -------------------------------- настройки -------------------------------- */

const SETTINGS_DEFAULTS = {
  enabled: false,
  autoReply: true,
  channels: ['direct', 'messenger', 'comments'],
  fallbackText: '',
  stopExtra: '',
};

/**
 * Настройки проекта. Строка создаётся при первом обращении: заводить её в
 * миграции значило бы забыть про проект, добавленный позже.
 */
export function settings(projectId) {
  db.prepare('INSERT OR IGNORE INTO bot_settings (project_id) VALUES (?)').run(projectId);
  const row = db.prepare('SELECT * FROM bot_settings WHERE project_id = ?').get(projectId);
  let channels;
  try {
    channels = JSON.parse(row.channels);
  } catch {
    channels = SETTINGS_DEFAULTS.channels;
  }
  return {
    projectId,
    enabled: Boolean(row.enabled),
    autoReply: Boolean(row.auto_reply),
    channels: Array.isArray(channels) ? channels.filter((c) => CHANNELS[c]) : SETTINGS_DEFAULTS.channels,
    fallbackText: row.fallback_text || '',
    stopExtra: row.stop_extra || '',
    siteUrl: row.site_url || '',
    updatedAt: row.updated_at,
  };
}

export function saveSettings(projectId, patch = {}) {
  const current = settings(projectId);
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
    autoReply: patch.autoReply === undefined ? current.autoReply : Boolean(patch.autoReply),
    channels: patch.channels === undefined ? current.channels : [...new Set(patch.channels)].filter((c) => CHANNELS[c]),
    fallbackText: patch.fallbackText === undefined ? current.fallbackText : String(patch.fallbackText).trim(),
    stopExtra: patch.stopExtra === undefined ? current.stopExtra : String(patch.stopExtra).trim(),
    siteUrl: patch.siteUrl === undefined ? current.siteUrl : String(patch.siteUrl).trim(),
  };
  if (next.siteUrl && !/^https?:\/\//.test(next.siteUrl)) {
    throw new BotError('Адрес сайта — вместе с https://, иначе сбор материалов не поймёт, куда идти');
  }
  if (next.fallbackText.length > LIMITS.answerMax) {
    throw new BotError(`Ответ «не знаю» длиннее ${LIMITS.answerMax} символов — в переписке столько не читают`);
  }
  db.prepare(
    `UPDATE bot_settings
        SET enabled = ?, auto_reply = ?, channels = ?, fallback_text = ?, stop_extra = ?, site_url = ?, updated_at = ?
      WHERE project_id = ?`
  ).run(
    next.enabled ? 1 : 0,
    next.autoReply ? 1 : 0,
    JSON.stringify(next.channels),
    next.fallbackText,
    next.stopExtra,
    next.siteUrl,
    nowIso(),
    projectId
  );
  return settings(projectId);
}

/* ------------------------------- база знаний ------------------------------- */

function fromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    topic: row.topic,
    question: row.question,
    answer: row.answer,
    triggers: row.triggers,
    triggerCount: triggerList(row).length,
    lang: row.lang,
    channel: row.channel,
    priority: row.priority,
    active: Boolean(row.active),
    hits: row.hits,
    lastUsedAt: row.last_used_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function list(projectId, { archived = false, topic = '', search = '' } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM bot_knowledge
        WHERE project_id = ?
          AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
        ORDER BY topic, priority DESC, id`
    )
    .all(projectId);
  const needle = String(search || '').trim().toLowerCase();
  return rows
    .filter((r) => !topic || r.topic === topic)
    .filter((r) =>
      !needle ||
      `${r.question} ${r.answer} ${r.triggers} ${r.topic}`.toLowerCase().includes(needle)
    )
    .map(fromRow);
}

/** Записи, которыми бот отвечает: живые, не в архиве. */
export function liveEntries(projectId) {
  return db
    .prepare('SELECT * FROM bot_knowledge WHERE project_id = ? AND active = 1 AND archived_at IS NULL ORDER BY priority DESC, id')
    .all(projectId)
    .map(fromRow);
}

export function get(id) {
  const row = db.prepare('SELECT * FROM bot_knowledge WHERE id = ?').get(id);
  return row ? fromRow(row) : null;
}

/** Рубрики со счётчиками — левая колонка списка. */
export function topics(projectId) {
  return db
    .prepare(
      `SELECT topic, COUNT(*) AS total, SUM(active) AS live
         FROM bot_knowledge
        WHERE project_id = ? AND archived_at IS NULL
        GROUP BY topic
        ORDER BY topic`
    )
    .all(projectId)
    .map((r) => ({ topic: r.topic, total: r.total, live: r.live }));
}

function clean(data, current = {}) {
  const out = {
    topic: String(data.topic ?? current.topic ?? '').trim(),
    question: String(data.question ?? current.question ?? '').trim(),
    answer: String(data.answer ?? current.answer ?? '').trim(),
    triggers: String(data.triggers ?? current.triggers ?? '')
      .split(/[\n;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n'),
    lang: String(data.lang ?? current.lang ?? 'any'),
    channel: String(data.channel ?? current.channel ?? 'any'),
    priority: Number(data.priority ?? current.priority ?? 0) || 0,
    active: data.active === undefined ? (current.active ?? true) : Boolean(data.active),
  };

  if (!out.question) throw new BotError('Без вопроса запись не найти в списке');
  if (!out.answer) throw new BotError('Без ответа запись бесполезна: бот промолчит');
  if (out.answer.length > LIMITS.answerMax) {
    throw new BotError(`Ответ длиннее ${LIMITS.answerMax} символов — Direct его обрежет. Разделите на две записи`);
  }
  if (!LANGS[out.lang]) throw new BotError('Неизвестный язык записи');
  if (out.channel !== 'any' && !CHANNELS[out.channel]) throw new BotError('Неизвестный канал записи');

  const triggers = out.triggers ? out.triggers.split('\n') : [];
  if (triggers.length > LIMITS.triggersPerEntry) {
    throw new BotError(`Больше ${LIMITS.triggersPerEntry} зацепок на запись — признак того, что в ней смешаны два вопроса`);
  }
  const tooLong = triggers.find((t) => t.length > LIMITS.triggerMax);
  if (tooLong) throw new BotError(`Зацепка «${tooLong.slice(0, 30)}…» слишком длинная: это уже не формулировка, а текст`);

  return out;
}

export function create(projectId, data) {
  const v = clean(data);
  const info = db
    .prepare(
      `INSERT INTO bot_knowledge (project_id, topic, question, answer, triggers, lang, channel, priority, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, v.topic, v.question, v.answer, v.triggers, v.lang, v.channel, v.priority, v.active ? 1 : 0);
  log('info', `бот: добавлен ответ «${v.question}»`);
  return get(Number(info.lastInsertRowid));
}

export function update(id, data) {
  const current = get(id);
  if (!current) throw new BotError('Запись не найдена', 404);
  const v = clean(data, current);
  db.prepare(
    `UPDATE bot_knowledge
        SET topic = ?, question = ?, answer = ?, triggers = ?, lang = ?, channel = ?, priority = ?, active = ?, updated_at = ?
      WHERE id = ?`
  ).run(v.topic, v.question, v.answer, v.triggers, v.lang, v.channel, v.priority, v.active ? 1 : 0, nowIso(), id);
  return get(id);
}

/** «Удалить» — в архив; оттуда можно вернуть. Настоящего DELETE здесь нет. */
export function setArchived(id, archived) {
  const current = get(id);
  if (!current) throw new BotError('Запись не найдена', 404);
  db.prepare('UPDATE bot_knowledge SET archived_at = ?, updated_at = ? WHERE id = ?').run(
    archived ? nowIso() : null,
    nowIso(),
    id
  );
  log('info', `бот: ответ «${current.question}» ${archived ? 'убран в архив' : 'возвращён из архива'}`);
  return get(id);
}

/** Отметка использования: показывает, чем бот живёт, а что лежит мёртвым. */
export function bump(id) {
  db.prepare('UPDATE bot_knowledge SET hits = hits + 1, last_used_at = ? WHERE id = ?').run(nowIso(), id);
}

/**
 * Что бот ответит на такой вопрос.
 *
 * Отдельная функция ради экрана проверки: наполнять базу вслепую нельзя —
 * «записал ответ» и «бот его находит» разные вещи, и первая без второй
 * бесполезна.
 */
export function tryQuestion(projectId, text, { channel = 'direct' } = {}) {
  const cfg = settings(projectId);
  const entries = liveEntries(projectId);
  const result = decide(text, entries, { channel, stopExtra: cfg.stopExtra });
  return {
    ...result,
    entry: result.entry ? { id: result.entry.id, question: result.entry.question, answer: result.entry.answer, topic: result.entry.topic } : null,
    willSend: willSend(result, cfg),
    settings: { enabled: cfg.enabled, autoReply: cfg.autoReply },
  };
}

/**
 * Что уйдёт клиенту при таком решении.
 *
 * Стоп-тема — всегда молчание: «я передам человеку» в ответ на жалобу
 * читается как отписка (docs/бот.md, §5). Непонятный вопрос отдаёт текст
 * «не знаю», если владелец его задал, иначе тоже молчание.
 */
export function willSend(result, cfg) {
  if (!cfg.enabled) return null;
  if (result.decision === 'stop') return null;
  if (result.decision === 'answer') return cfg.autoReply ? result.entry.answer : null;
  if (result.decision === 'draft') return null;
  return cfg.fallbackText || null;
}
