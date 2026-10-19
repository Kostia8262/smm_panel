/**
 * Раздел «Бот»: две вкладки одной работы.
 *
 * **Ответы** — то, что уходит клиенту дословно. **Материалы** — то, на что
 * бот опирается: курсы, цены, вопросы и контакты, собранные с сайта школы
 * плюс написанное владельцем. Из материала ответ делается одной кнопкой.
 *
 * Настройки живут отдельным экраном: туда заходят раз, а сюда — каждый день.
 */

import { el } from '../../ui.js';
import { knowledgeView } from './knowledge.js';
import { materialsView } from './materials.js';
import { botSettingsView } from './settings.js';

const TABS = [
  { id: 'answers', hash: '#/bot', title: 'Ответы' },
  { id: 'materials', hash: '#/bot/materials', title: 'Материалы' },
];

export function botView(ctx) {
  const hash = location.hash;
  if (hash.startsWith('#/bot/settings')) return botSettingsView(ctx);
  if (hash.startsWith('#/bot/materials')) return materialsView(ctx, { tabs: tabsRow('materials') });
  return knowledgeView(ctx, { tabs: tabsRow('answers') });
}

function tabsRow(active) {
  const row = el('div', 'chips bot-tabs');
  for (const tab of TABS) {
    const link = el('a', 'chip', tab.title);
    link.href = tab.hash;
    if (tab.id === active) link.setAttribute('aria-pressed', 'true');
    row.append(link);
  }
  return row;
}
