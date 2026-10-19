/**
 * Раздел «Бот». Фаза 1 — база знаний и проверка подбора; «Входящие» придут
 * фазой 2, когда панель начнёт принимать переписку вебхуками (docs/бот.md).
 */

import { knowledgeView } from './knowledge.js';
import { botSettingsView } from './settings.js';

export function botView(ctx) {
  const hash = location.hash;
  if (hash.startsWith('#/bot/settings')) return botSettingsView(ctx);
  return knowledgeView(ctx);
}
