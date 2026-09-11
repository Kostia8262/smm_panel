#!/usr/bin/env node
/**
 * Занос трендов в панель из файла.
 *
 * Так работает та часть, которую нельзя автоматизировать: у Instagram,
 * Facebook и TikTok публичного API трендов нет, и сигналы туда попадают
 * разбором. Разобрали — сложили в JSON — прогнали этим скриптом.
 *
 *   node tools/trends-import.mjs тренды.json
 *   node tools/trends-import.mjs тренды.json --url https://smm.mycomputer.education
 *
 * Ключ берётся из TRENDS_INGEST_KEY (в .env на сервере). Без него панель
 * примет запрос только от вошедшего владельца.
 *
 * Формат файла — массив объектов:
 *   [{ "platform": "tiktok", "title": "…", "summary": "…",
 *      "metric": "+340% за неделю", "url": "…", "source": "research",
 *      "relevance": 5, "expiresAt": "2026-10-01" }]
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const urlArg = args.indexOf('--url');
const base = (urlArg >= 0 ? args[urlArg + 1] : process.env.PUBLIC_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');

if (!file) {
  console.error('Укажите файл: node tools/trends-import.mjs тренды.json');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(readFileSync(resolve(file), 'utf8'));
} catch (err) {
  console.error(`Не читается файл: ${err.message}`);
  process.exit(1);
}

const trends = Array.isArray(payload) ? payload : [payload];

// Проверяем до отправки: половина занесённого мусора хуже, чем отказ целиком.
const problems = [];
trends.forEach((t, i) => {
  if (!t.platform) problems.push(`#${i + 1}: нет площадки`);
  if (!t.title) problems.push(`#${i + 1}: нет названия`);
});
if (problems.length) {
  console.error('Файл неполон:\n' + problems.join('\n'));
  process.exit(1);
}

const key = process.env.TRENDS_INGEST_KEY;
if (!key) {
  console.error('Нет TRENDS_INGEST_KEY в .env — панель отклонит запрос.');
  process.exit(1);
}

const res = await fetch(`${base}/api/trends`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-ingest-key': key },
  body: JSON.stringify({ trends }),
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Панель отказала (${res.status}): ${data.error || 'без объяснения'}`);
  process.exit(1);
}

console.log(`Занесено сигналов: ${data.trends.length}`);
for (const t of data.trends) console.log(`  ${t.platform} · ${t.title}`);
