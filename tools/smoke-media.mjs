#!/usr/bin/env node
/**
 * Тестовые файлы для боевой пробы форматов — показать и убрать.
 *
 * Проба идёт мимо базы: файлы кладутся прямо в каталог загрузок, чтобы площадка
 * скачала их по публичному адресу панели. Строк в `media` у них нет, значит
 * уборка сирот сняла бы их сама через три часа — но на общем с сайтами диске
 * мусору незачем лежать и эти три часа. Отсюда явная уборка сразу после пробы.
 *
 * Трогает только файлы с приставкой `smoke-` и только те, на которые не
 * ссылается ни один пост: живой кадр под тестовое имя не попадёт, но проверка
 * стоит дешевле, чем объяснение, куда делся кадр из календаря.
 *
 *   node tools/smoke-media.mjs          # что лежит и по каким адресам
 *   node tools/smoke-media.mjs --clean  # убрать
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db } = await import('../src/db.js');
const { UPLOAD_DIR, removeStored } = await import('../src/media.js');

const PREFIX = 'smoke-';
const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');
const clean = process.argv.includes('--clean');

const files = readdirSync(UPLOAD_DIR).filter((n) => n.startsWith(PREFIX));
if (!files.length) {
  console.log('Тестовых файлов нет.');
  process.exit(0);
}

const referenced = db.prepare('SELECT 1 FROM media WHERE stored_name = ? LIMIT 1');
let removed = 0;

for (const name of files) {
  const size = statSync(join(UPLOAD_DIR, name)).size;
  if (referenced.get(name)) {
    console.log(`  ${name} — на него ссылается пост, не трогаю`);
    continue;
  }
  if (clean) {
    if (removeStored(name)) removed += 1;
    console.log(`  убран: ${name} (${Math.round(size / 1024)} КБ)`);
  } else {
    console.log(`  ${base}/media/${name}  (${Math.round(size / 1024)} КБ)`);
  }
}

if (clean) console.log(`Убрано файлов: ${removed}`);
