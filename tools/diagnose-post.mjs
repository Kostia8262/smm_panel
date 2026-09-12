#!/usr/bin/env node
/**
 * Разбор «почему не публикуется», без единого поста в живом аккаунте.
 *
 * Появился после первой боевой пробы 12.09.2026: Facebook опубликовался, а
 * Threads и Instagram отказали — и отказали по-разному, причём сообщения
 * площадок про причину молчат.
 *
 * Что делает:
 *   — Threads: спрашивает у площадки **настоящий** id аккаунта и сверяет с
 *     тем, что вписан в панель. Потом создаёт контейнер поста и НЕ публикует
 *     его. Так различаются два похожих отказа: «не тот id» и «нет разрешения
 *     на публикацию». Непубликованный контейнер истекает сам.
 *   — Instagram: создаёт контейнер с картинкой и опрашивает его состояние,
 *     показывая `status` целиком. Там текстом написано, чего площадке не
 *     хватило — чаще всего она не смогла скачать файл по нашему адресу.
 *
 *   node tools/diagnose-post.mjs --project 1 --image https://…/test.jpg
 *
 * Ни одного поста не появляется: нигде не вызывается публикация контейнера.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { listProjects, credentialsFor } = await import('../src/projects.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const projectId = Number(flag('project')) || listProjects()[0]?.id;
const image = flag('image');
const project = listProjects().find((p) => p.id === projectId);
if (!project) {
  console.error('Проект не найден');
  process.exit(1);
}

console.log(`Проект: ${project.title}\n`);

await diagnoseThreads();
await diagnoseInstagram();

/* -------------------------------- Threads -------------------------------- */

async function diagnoseThreads() {
  const creds = credentialsFor(projectId, 'threads');
  console.log('=== Threads ===');
  if (!creds.accessToken) {
    console.log('  токена нет\n');
    return;
  }

  const API = 'https://graph.threads.net/v1.0';

  // Настоящий id аккаунта. `me` работает всегда: площадка сама понимает, чей
  // токен ей дали, и именно поэтому «Проверить связь» проходила, пока
  // публикация падала — она ходит на `me`, а публикация на вписанный id.
  let real;
  try {
    const res = await fetch(`${API}/me?fields=id,username&access_token=${creds.accessToken}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    real = data;
    console.log(`  площадка говорит: id ${data.id}, аккаунт @${data.username}`);
  } catch (err) {
    console.log(`  не удалось спросить: ${err.message}\n`);
    return;
  }

  console.log(`  в панели вписано: id ${creds.userId || '— пусто —'}`);
  if (String(creds.userId) !== String(real.id)) {
    console.log('  >>> ID НЕ СОВПАДАЕТ. Впишите в карточку проекта тот, что говорит площадка.');
  } else {
    console.log('  id совпадает');
  }

  // Контейнер — ещё не пост. Если он создаётся, разрешение на публикацию
  // есть, и дело было в чём-то другом. Если отказ — дело в разрешении.
  try {
    const body = new URLSearchParams({
      media_type: 'TEXT',
      text: 'Технічна перевірка. Цей запис не публікується.',
      access_token: creds.accessToken,
    });
    const res = await fetch(`${API}/${real.id}/threads`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error?.message || res.status);
    console.log(`  черновик поста создан (${data.id}) — публиковать разрешено, публикацию не вызываем`);
  } catch (err) {
    console.log(`  черновик создать НЕ удалось: ${err.message}`);
    console.log('     похоже на отсутствие threads_content_publish у токена');
  }
  console.log('');
}

/* ------------------------------- Instagram ------------------------------- */

async function diagnoseInstagram() {
  const creds = credentialsFor(projectId, 'instagram');
  console.log('=== Instagram ===');
  if (!creds.pageToken) {
    console.log('  токена нет\n');
    return;
  }
  if (!image) {
    console.log('  нужен --image с публичным адресом JPEG: текстом Instagram не умеет вовсе\n');
    return;
  }

  const API = 'https://graph.facebook.com/v21.0';

  let containerId;
  try {
    const body = new URLSearchParams({
      image_url: image,
      caption: 'Технічна перевірка. Цей запис не публікується.',
      access_token: creds.pageToken,
    });
    const res = await fetch(`${API}/${creds.userId}/media`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error?.message || res.status);
    containerId = data.id;
    console.log(`  контейнер создан: ${containerId}`);
  } catch (err) {
    console.log(`  контейнер создать НЕ удалось: ${err.message}\n`);
    return;
  }

  // Вот это и есть ответ на «Media ID is not available»: публиковать можно
  // только FINISHED. Показываем, сколько времени уходит на готовность.
  const started = Date.now();
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${API}/${containerId}?fields=status_code,status&access_token=${creds.pageToken}`);
    const data = await res.json().catch(() => ({}));
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`  через ${secs} с: ${data.status_code || 'нет ответа'}${data.status ? ` — ${data.status}` : ''}`);

    if (data.status_code === 'FINISHED') {
      console.log('  контейнер готов: публикация прошла бы. Сам пост не публикуем.');
      break;
    }
    if (data.status_code === 'ERROR') {
      console.log('  >>> контейнер не собрался. Причина выше — как правило, площадка не смогла скачать файл.');
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('');
}
