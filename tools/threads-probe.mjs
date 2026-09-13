#!/usr/bin/env node
/**
 * Разбор отказа Threads в удалении: какой хост пускает и что знает площадка о токене.
 *
 * Появился 13.09.2026: три токена подряд публиковали, но удаление отбивалось
 * «Application does not have permission for this action», хотя `threads_delete`
 * в сценарии приложения стоит «Готово к тестированию». Наш код ходит на
 * `graph.threads.net`, документация Meta описывает удаление на
 * `graph.threads.com` — проверяем оба, на своём же тестовом посте.
 *
 *   node tools/threads-probe.mjs --project 1 --delete <id поста>
 *
 * Удаляет только пост, id которого передан явно. Токен не печатается.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { credentialsFor } = await import('../src/projects.js');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const projectId = Number(flag('project')) || 1;
const postId = flag('delete');
const { accessToken } = credentialsFor(projectId, 'threads');
if (!accessToken) {
  console.error('Нет токена Threads');
  process.exit(1);
}

const HOSTS = ['https://graph.threads.net/v1.0', 'https://graph.threads.com/v1.0'];

async function show(label, url, init) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    console.log(`  ${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return { status: res.status, text };
  } catch (err) {
    console.log(`  ${label}: сеть — ${err.message}`);
    return null;
  }
}

console.log('=== Что площадка знает о токене ===');
for (const host of HOSTS) {
  await show(`${host} me`, `${host}/me?fields=id,username&access_token=${accessToken}`);
}
// debug_token у Threads не документирован — пробуем, вдруг отдаст права.
for (const host of HOSTS) {
  await show(`${host} debug_token`, `${host}/debug_token?input_token=${accessToken}&access_token=${accessToken}`);
}

if (postId) {
  console.log(`\n=== Удаление поста ${postId} ===`);
  for (const host of HOSTS) {
    const r = await show(`DELETE ${host}`, `${host}/${postId}?access_token=${accessToken}`, { method: 'DELETE' });
    if (r?.status === 200 && /"success"\s*:\s*true/.test(r.text)) {
      console.log(`  >>> удалено через ${host}`);
      break;
    }
  }
}
