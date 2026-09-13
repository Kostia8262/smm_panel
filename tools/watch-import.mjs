#!/usr/bin/env node
/**
 * Список аккаунтов для наблюдения — пачкой, из JSON-файла.
 *
 * Руками по одному в панели — двадцать заходов в форму. Здесь список
 * сначала проверяется (что это за аккаунт на самом деле: имя, описание,
 * подписчики, когда был последний пост), и только потом, отдельным запуском
 * с `--apply`, ложится в панель. Найденные поиском аккаунты часто оказываются
 * региональным клоном сети, заброшенной страницей или однофамильцем из
 * другой страны — вслепую их добавлять нельзя.
 *
 *   node tools/watch-import.mjs --project 1 --file data/watch-import.json            # проверка
 *   node tools/watch-import.mjs --project 1 --file data/watch-import.json --apply    # добавить
 *
 * Формат файла: [{ "platform": "instagram", "username": "goiteens",
 *                  "kind": "competitor", "note": "…" }, …]
 *
 * Файл лежит в data/ (не в репозитории) и после `--apply` стирается сам:
 * список конкурентов в публичный репозиторий не попадает.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_API } from '../src/platforms/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db } = await import('../src/db.js');
const { listProjects, credentialsFor } = await import('../src/projects.js');
const watch = await import('../src/trends/accounts.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const apply = args.includes('--apply');

const project = listProjects().find((p) => p.id === (Number(flag('project')) || listProjects()[0]?.id));
if (!project) {
  console.error('Проект не найден');
  process.exit(1);
}

// Только из data/: чужой путь скрипт не читает и тем более не стирает.
const dataDir = resolve(here, '../data');
const file = resolve(here, '..', String(flag('file', '')));
if (!flag('file') || relative(dataDir, file).startsWith('..') || !existsSync(file)) {
  console.error('Нужен --file с JSON-списком внутри data/');
  process.exit(1);
}
const list = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(list) || !list.length) {
  console.error('В файле нет списка аккаунтов');
  process.exit(1);
}

const creds = credentialsFor(project.id, 'instagram');
console.log(`Проект: ${project.title} · аккаунтов в файле: ${list.length} · ${apply ? 'ДОБАВЛЯЮ' : 'только проверка'}\n`);

async function lookInstagram(username) {
  const fields =
    `business_discovery.username(${username}){username,name,biography,followers_count,media_count,` +
    `media.limit(12){timestamp,media_product_type,like_count,comments_count,view_count}}`;
  const qs = new URLSearchParams({ fields, access_token: creds.pageToken });
  const res = await fetch(`${GRAPH_API}/${creds.userId}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `ошибка ${res.status}`);
  return data.business_discovery;
}

const existing = db.prepare('SELECT 1 FROM watched_accounts WHERE project_id = ? AND platform = ? AND username = ?');
let added = 0;
let failed = 0;

for (const item of list) {
  let username;
  try {
    username = watch.parseAccount(item.platform, item.username);
  } catch (err) {
    console.log(`✗ ${item.platform} ${item.username}: ${err.message}`);
    failed += 1;
    continue;
  }
  const tag = `${item.platform} @${username}`;

  if (item.platform === 'instagram') {
    if (!creds.userId || !creds.pageToken) {
      console.log(`✗ ${tag}: у проекта не подключён Instagram`);
      failed += 1;
      continue;
    }
    try {
      const bd = await lookInstagram(username);
      const posts = bd.media?.data || [];
      const last = posts[0]?.timestamp ? String(posts[0].timestamp).slice(0, 10) : '—';
      const reels = posts.filter((p) => p.media_product_type === 'REELS');
      const views = reels.map((p) => p.view_count).filter(Number.isFinite).sort((a, b) => a - b);
      const medianViews = views.length ? views[Math.floor(views.length / 2)] : null;
      const bio = String(bd.biography || '').replace(/\s+/g, ' ').slice(0, 110);
      console.log(
        `✓ ${tag} · ${bd.name || '—'} · подписчиков ${bd.followers_count} · постов ${bd.media_count} · последний ${last} · Reels ${reels.length}/${posts.length}${medianViews !== null ? `, медиана просмотров ${medianViews}` : ''}`
      );
      if (bio) console.log(`    ${bio}`);
    } catch (err) {
      console.log(`✗ ${tag}: ${err.message}`);
      failed += 1;
      continue;
    }
  } else {
    console.log(`· ${tag} — ссылкой, цифр площадка не отдаёт`);
  }

  if (!apply) continue;
  if (existing.get(project.id, item.platform, username)) {
    console.log('    уже в списке — пропускаю');
    continue;
  }
  const id = watch.addAccount(project.id, { platform: item.platform, username, kind: item.kind, note: item.note });
  added += 1;
  if (item.platform === 'instagram') {
    try {
      const signals = await watch.collectInstagram(db.prepare('SELECT * FROM watched_accounts WHERE id = ?').get(id), creds);
      if (signals) console.log(`    сигналов на доску трендов: ${signals}`);
    } catch (err) {
      console.log(`    добавлен, но цифры не собрались: ${err.message}`);
    }
  }
}

console.log(`\nИтог: ${apply ? `добавлено ${added}, ` : ''}не прошли ${failed} из ${list.length}`);
if (apply) {
  rmSync(file, { force: true });
  console.log('Файл списка стёрт.');
}
