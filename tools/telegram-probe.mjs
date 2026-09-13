#!/usr/bin/env node
/**
 * Разбор отказа Telegram: дело в токене, в поле канала или в том, как мы зовём API.
 *
 * Появился 13.09.2026: у академии заполнили карточку Telegram, а проверка связи
 * падала на самом первом шаге (`getMe`) с голым «400» без описания. Инструмент
 * смотрит форму токена (не печатая его), зовёт `getMe` двумя способами и
 * проверяет, в каком виде записан канал. Ничего не публикует.
 *
 *   node tools/telegram-probe.mjs --project 1
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { credentialsFor } = await import('../src/projects.js');

const args = process.argv.slice(2);
const i = args.indexOf('--project');
const projectId = Number(i === -1 ? 1 : args[i + 1]);
const { botToken = '', chatId = '' } = credentialsFor(projectId, 'telegram');

console.log('=== Токен (сам не печатается) ===');
console.log(`  длина: ${botToken.length}`);
console.log(`  вид «цифры:ключ»: ${/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken) ? 'да' : 'НЕТ'}`);
console.log(`  пробелы или переносы внутри/по краям: ${/\s/.test(botToken) ? 'ДА' : 'нет'}`);
console.log(`  начинается с «bot»: ${/^bot/i.test(botToken) ? 'ДА — префикс лишний' : 'нет'}`);

async function show(label, init) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, init);
    const text = await res.text();
    let desc = text.slice(0, 160).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(text);
      desc = j.ok ? `ok, бот @${j.result?.username}` : `${j.error_code}: ${j.description}`;
    } catch {
      // не JSON — показываем начало как есть
    }
    console.log(`  ${label}: HTTP ${res.status} — ${desc}`);
  } catch (err) {
    console.log(`  ${label}: сеть — ${err.message}`);
  }
}

console.log('\n=== getMe ===');
await show('GET', {});
await show('POST пустой формой (как делает адаптер)', { method: 'POST', body: new FormData() });

console.log('\n=== Канал ===');
console.log(`  записано: ${chatId || '— пусто —'}`);
const looksUrl = /^https?:\/\/|t\.me\//i.test(chatId);
console.log(`  вид: ${looksUrl ? 'ССЫЛКА — Bot API ждёт @имя или числовой id' : /^@|^-?\d+$/.test(chatId) ? 'годный' : 'непонятный'}`);
