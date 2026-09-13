#!/usr/bin/env node
/**
 * Что лежит в незавершённых входах Facebook — без токенов.
 *
 * Появился 13.09.2026: владелец вошёл через Facebook, результат лёг ждать выбора
 * страницы, но экран выбора в браузере не открылся (старая страница в кэше).
 * Отсюда видно, что вход выдал бы — бессрочный ли токен, проходит ли замену, —
 * не заставляя человека повторять вход ради ответа.
 *
 *   node tools/oauth-pending.mjs --project 1
 *
 * Токены не печатаются. Сравнение — тем же checkReplacement, что и в панели.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db } = await import('../src/db.js');
const { decrypt } = await import('../src/secrets.js');
const { credentialsFor } = await import('../src/projects.js');
const facebook = await import('../src/oauth/facebook.js');

const args = process.argv.slice(2);
const i = args.indexOf('--project');
const projectId = Number(i === -1 ? 1 : args[i + 1]);

const rows = db
  .prepare("SELECT id, created_at FROM oauth_pending WHERE project_id = ? AND platform = 'facebook' ORDER BY created_at DESC")
  .all(projectId);
if (!rows.length) {
  console.log('Незавершённых входов Facebook нет (результат живёт 15 минут и чистится при следующем входе).');
  process.exit(0);
}

const creds = credentialsFor(projectId, 'facebook');
let current = { pageId: creds.pageId || null, token: null };
try {
  current.token = await facebook.inspectToken(creds.pageToken, { appId: creds.appId, appSecret: creds.appSecret });
} catch {
  // Нынешний не проверился — сравнение покажет это как «нерабочий».
}

for (const row of rows) {
  const { pages } = JSON.parse(decrypt(db.prepare('SELECT payload FROM oauth_pending WHERE id = ?').get(row.id).payload));
  console.log(`\nВход от ${row.created_at} UTC, страниц: ${pages.length}`);
  for (const p of pages) {
    const v = facebook.checkReplacement(current, p);
    console.log(`  ${p.name} (${p.pageId})${String(p.pageId) === String(current.pageId) ? ' — сейчас подключена' : ''}`);
    console.log(`     токен: ${p.valid ? 'валиден' : 'НЕ валиден'}, ${p.expiresAt === 0 ? 'бессрочный' : 'срочный'}, Instagram: ${p.instagram ? `@${p.instagram.username || p.instagram.id}` : 'нет'}`);
    console.log(`     замена: ${v.ok ? 'разрешена' : `ОТКАЗ — ${v.problems.join('; ')}`}${v.needsConfirm ? ' (нужно подтверждение смены страницы)' : ''}`);
  }
}
