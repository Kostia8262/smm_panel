/**
 * Маршруты бота-консультанта. Отдельным модулем: server.js и так на две
 * тысячи строк, а у бота впереди вебхуки, диалоги и «Входящие»
 * (docs/бот.md, §6).
 *
 * Права — две области из `ACCESS` (src/staff.js):
 *   bot          — база знаний: смотреть и наполнять. СММщик это делает
 *                  каждый день, он лучше владельца знает, как спрашивают;
 *   bot_settings — включение бота, автоответ и стоп-темы: это решение о том,
 *                  что уйдёт клиенту без человека, и оно за владельцем.
 */

import express from 'express';
import { log } from '../db.js';
import { CHANNELS, CHANNEL_LIST, DECISION, LANGS, LIMITS, SCORE, STOP_TOPICS, TOPIC_HINTS } from './specs.js';
import * as knowledge from './knowledge.js';

const { BotError } = knowledge;

/**
 * @param {import('express').Express} app
 * @param {{requireAccess: (area: string) => Function, currentProjectId: (req: object) => number|null,
 *   can: (role: string, area: string) => boolean}} deps
 */
export function mountBotRoutes(app, { requireAccess, currentProjectId, can }) {
  const router = express.Router();
  const view = requireAccess('bot');
  const manage = requireAccess('bot_settings');

  /** Предметная ошибка — объяснение клиенту; остальное — в журнал. */
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof BotError) return res.status(err.status).json({ error: err.message });
      log('error', `бот: сбой на ${req.method} ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Что-то пошло не так — подробности в журнале' });
    }
  };

  /* Справочник для интерфейса: каналы, языки, пределы, пороги, стоп-темы. */
  router.get('/specs', view, handle(async (_req, res) => {
    res.json({
      channels: CHANNELS,
      channelList: CHANNEL_LIST,
      langs: LANGS,
      limits: LIMITS,
      score: SCORE,
      decisions: DECISION,
      topicHints: TOPIC_HINTS,
      stopTopics: STOP_TOPICS.map((t) => ({ id: t.id, title: t.title, count: t.triggers.length })),
    });
  }));

  /* Список записей с рубриками и настройками — один запрос на открытие экрана. */
  router.get('/knowledge', view, handle(async (req, res) => {
    const projectId = currentProjectId(req);
    res.json({
      entries: knowledge.list(projectId, {
        archived: req.query.archived === '1',
        topic: req.query.topic || '',
        search: req.query.search || '',
      }),
      topics: knowledge.topics(projectId),
      settings: knowledge.settings(projectId),
      canManage: can(req.user.role, 'bot_settings'),
    });
  }));

  router.post('/knowledge', view, handle(async (req, res) => {
    const projectId = currentProjectId(req);
    res.json({ entry: knowledge.create(projectId, req.body || {}) });
  }));

  router.put('/knowledge/:id', view, handle(async (req, res) => {
    res.json({ entry: knowledge.update(Number(req.params.id), req.body || {}) });
  }));

  // «Удалить» здесь — в архив: настоящего DELETE у базы знаний нет.
  router.post('/knowledge/:id/archive', view, handle(async (req, res) => {
    res.json({ entry: knowledge.setArchived(Number(req.params.id), req.body?.archived !== false) });
  }));

  /**
   * Проверка вопроса: что бот ответит, с каким счётом и почему.
   *
   * Главный инструмент наполнения базы. Без него «ответ записан» и «бот его
   * находит» — разные вещи, и расходятся они молча.
   */
  router.post('/try', view, handle(async (req, res) => {
    const projectId = currentProjectId(req);
    const text = String(req.body?.text || '').trim();
    if (!text) throw new BotError('Напишите вопрос так, как его пишет клиент');
    const channel = String(req.body?.channel || 'direct');
    if (!CHANNELS[channel]) throw new BotError('Неизвестный канал');
    res.json(knowledge.tryQuestion(projectId, text, { channel }));
  }));

  router.get('/settings', view, handle(async (req, res) => {
    res.json({ settings: knowledge.settings(currentProjectId(req)), canManage: can(req.user.role, 'bot_settings') });
  }));

  router.put('/settings', manage, handle(async (req, res) => {
    const projectId = currentProjectId(req);
    const before = knowledge.settings(projectId);
    const after = knowledge.saveSettings(projectId, req.body || {});
    if (before.enabled !== after.enabled) {
      log('info', `бот: ${after.enabled ? 'включён' : 'выключен'} в проекте #${projectId}`);
    }
    if (before.autoReply !== after.autoReply) {
      log('info', `бот: режим — ${after.autoReply ? 'отвечает сам' : 'только черновики'} в проекте #${projectId}`);
    }
    res.json({ settings: after });
  }));

  app.use('/api/bot', router);
}
