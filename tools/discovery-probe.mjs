#!/usr/bin/env node
/**
 * Проба Instagram Business Discovery: что панель видит у чужого аккаунта.
 *
 * Прежде чем строить на доске трендов «аккаунты, за которыми следим», нужно
 * знать, что площадка отдаёт на нашем токене страницы: подписчиков, посты и
 * их цифры — и отдаёт ли просмотры Reels. Документация перечисляет поля
 * скупо; проба смотрит на живой ответ. Только чтение, в сетях ничего не
 * появляется.
 *
 *   node tools/discovery-probe.mjs --project 1 --username instagram
 *   node tools/discovery-probe.mjs --project 1 --username itstep --limit 12
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_API } from '../src/platforms/graph.js';

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
const username = String(flag('username', '')).replace(/^@/, '').trim();
const limit = Math.min(50, Number(flag('limit', 10)) || 10);
if (!/^[\w.]{1,30}$/.test(username)) {
  console.error('Нужен --username аккаунта Instagram (латиница, цифры, точка, подчёркивание)');
  process.exit(1);
}

const creds = credentialsFor(projectId, 'instagram');
if (!creds.userId || !creds.pageToken) {
  console.error('У проекта не заполнен Instagram');
  process.exit(1);
}

// Сначала просим всё, что может пригодиться, — если площадка отвергнет поле,
// повторяем без спорных, чтобы увидеть, какое именно не прошло.
const MEDIA_FULL = 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,view_count';
const MEDIA_SAFE = 'id,caption,media_type,timestamp,permalink,like_count,comments_count';

async function discover(mediaFields) {
  const fields = `business_discovery.username(${username}){username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website,media.limit(${limit}){${mediaFields}}}`;
  const qs = new URLSearchParams({ fields, access_token: creds.pageToken });
  const res = await fetch(`${GRAPH_API}/${creds.userId}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`${e.message || res.status}${e.code ? ` (код ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}`);
  }
  return data.business_discovery;
}

let bd;
try {
  bd = await discover(MEDIA_FULL);
  console.log('Полный набор полей принят.');
} catch (err) {
  console.log(`Полный набор отвергнут: ${err.message}`);
  try {
    bd = await discover(MEDIA_SAFE);
    console.log('Принят набор без media_product_type и view_count.');
  } catch (err2) {
    console.log(`И безопасный набор отвергнут: ${err2.message}`);
    process.exit(2);
  }
}

console.log(`\n@${bd.username} · ${bd.name || '—'}`);
console.log(`подписчиков ${bd.followers_count ?? '?'} · подписок ${bd.follows_count ?? '?'} · постов ${bd.media_count ?? '?'}`);
console.log(`поля профиля: ${Object.keys(bd).join(', ')}`);

const media = bd.media?.data || [];
console.log(`\nпостов в ответе: ${media.length}${bd.media?.paging?.cursors?.after ? ', есть следующая страница' : ''}`);
if (media[0]) console.log(`поля поста: ${Object.keys(media[0]).join(', ')}`);
for (const m of media) {
  const text = String(m.caption || '').replace(/\s+/g, ' ').slice(0, 60);
  console.log(
    `  ${String(m.timestamp).slice(0, 10)} · ${m.media_product_type || m.media_type} · ♥ ${m.like_count ?? '—'} · 💬 ${m.comments_count ?? '—'} · 👁 ${m.view_count ?? '—'} · ${text}`
  );
}
