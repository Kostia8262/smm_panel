#!/usr/bin/env node
/**
 * Служебные «закреплено» в ленте канала Telegram: показать и убрать.
 *
 * Появился 13.09.2026: боевая проба закрепа оставила в канале академии
 * служебное сообщение, хотя сам пост удалили. Панель теперь убирает его сразу
 * после закрепа, а этот скрипт — уже оставшиеся.
 *
 * Удаляет только служебные сообщения о закрепе своего канала, найденные в
 * обновлениях бота, — обычные посты не трогает никогда.
 *
 *   node tools/telegram-pin-notices.mjs --project 1          показать
 *   node tools/telegram-pin-notices.mjs --project 1 --drop   убрать
 *
 * Обновления Telegram хранит сутки: старее — уже не найти, только руками.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { listProjects, credentialsFor } = await import('../src/projects.js');
const tg = await import('../src/platforms/telegram.js');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const projectId = Number(flag('project')) || listProjects()[0]?.id;
const drop = args.includes('--drop');

const creds = credentialsFor(projectId, 'telegram');
if (!tg.isConfigured(creds)) {
  console.log('Telegram у проекта не заполнен');
  process.exit(1);
}
const chatId = tg.normalizeChatId(creds.chatId);
const mine = (chat) =>
  chatId.startsWith('@') ? String(chat?.username || '').toLowerCase() === chatId.slice(1).toLowerCase() : String(chat?.id) === chatId;

const notices = [];
let seen = 0;
await tg.readUpdates(creds, {
  rounds: 50,
  // Без --drop только смотрим и ничего не подтверждаем: иначе следующий
  // запуск с --drop уже не нашёл бы прочитанное.
  peek: !drop,
  onUpdate: (u) => {
    const post = u.channel_post || u.message;
    if (!post || !mine(post.chat)) return false;
    seen += 1;
    if (post.pinned_message) notices.push({ id: post.message_id, pinned: post.pinned_message.message_id });
    return false;
  },
});

console.log(`Канал ${chatId}: сообщений в обновлениях бота — ${seen}, служебных «закреплено» — ${notices.length}`);
for (const n of notices) console.log(`  сообщение ${n.id} — о закрепе поста ${n.pinned}`);

if (!drop || !notices.length) process.exit(0);
for (const n of notices) {
  try {
    await tg.remove(String(n.id), creds);
    console.log(`  ${n.id}: удалено`);
  } catch (err) {
    console.log(`  ${n.id}: НЕ удалено — ${err.message}`);
  }
}
