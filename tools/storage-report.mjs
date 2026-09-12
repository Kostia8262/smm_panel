#!/usr/bin/env node
/**
 * Сколько места занимают файлы панели и сколько свободно на диске.
 *
 * Диск общий с шестнадцатью сайтами сети, поэтому смотрим обе цифры: свою
 * папку и раздел целиком. По базе видно, что панель считает живым, по диску —
 * что там лежит на самом деле; расхождение между ними и есть мусор, который
 * уборка должна была снять.
 *
 *   node tools/storage-report.mjs
 */

import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db } = await import('../src/db.js');
const { UPLOAD_DIR } = await import('../src/media.js');
const { usedBytes, QUOTA_BYTES, RETENTION, MINUTE } = await import('../src/retention.js');

const mb = (n) => `${(n / 1048576).toFixed(1)} МБ`;

let diskFiles = 0;
let diskBytes = 0;
for (const name of readdirSync(UPLOAD_DIR)) {
  try {
    const st = statSync(join(UPLOAD_DIR, name));
    if (!st.isFile()) continue;
    diskFiles += 1;
    diskBytes += st.size;
  } catch {
    // Файл могли снять между чтением каталога и stat — это нормально.
  }
}

const known = new Set(db.prepare('SELECT stored_name FROM media').all().map((r) => r.stored_name));
const orphans = readdirSync(UPLOAD_DIR).filter((n) => !known.has(n)).length;
const live = db.prepare('SELECT COUNT(DISTINCT stored_name) n FROM media WHERE purged_at IS NULL').get().n;
const purged = db.prepare('SELECT COUNT(DISTINCT stored_name) n FROM media WHERE purged_at IS NOT NULL').get().n;

console.log('=== Файлы панели ===');
console.log(`  на диске:           ${diskFiles} шт., ${mb(diskBytes)}`);
console.log(`  живых по базе:      ${live} шт., ${mb(usedBytes())} из квоты ${mb(QUOTA_BYTES)}`);
console.log(`  снято после публикации (история): ${purged} шт.`);
console.log(`  сирот без записи в базе: ${orphans} шт. (уходят сами через 3 часа)`);
console.log(`  окна: картинка ${RETENTION.image / MINUTE} мин, видео ${RETENTION.video / MINUTE} мин после публикации`);

try {
  const fs = statfsSync(UPLOAD_DIR);
  const total = fs.blocks * fs.bsize;
  const free = fs.bavail * fs.bsize;
  console.log('\n=== Раздел диска (общий с сайтами сети) ===');
  console.log(`  свободно ${mb(free)} из ${mb(total)} — ${Math.round((free / total) * 100)}%`);
} catch (err) {
  console.log(`\nРаздел диска прочитать не удалось: ${err.message}`);
}
