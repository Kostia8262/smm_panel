#!/usr/bin/env node
/**
 * Что лежит в медиатеке страницы Facebook за последние минуты.
 *
 * Только чтение. Нужен после пробы форматов: пост-карусель собирается из фото,
 * загруженных на страницу отдельно и неопубликованными, и удаление самого поста
 * вовсе не обязано снимать эти фото. Проверять это глазами в Business Suite
 * долго, а оставлять мусор в медиатеке школы — нельзя.
 *
 *   node tools/page-media.mjs --project 1 --minutes 30
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { credentialsFor } = await import('../src/projects.js');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const projectId = Number(flag('project', 1));
const minutes = Number(flag('minutes', 30));
const since = Date.now() - minutes * 60000;
const creds = credentialsFor(projectId, 'facebook');
if (!creds.pageToken) {
  console.error('Нет токена страницы Facebook');
  process.exit(1);
}

const API = 'https://graph.facebook.com/v21.0';

async function list(edge, fields) {
  const res = await fetch(`${API}/${creds.pageId}/${edge}&fields=${fields}&limit=50&access_token=${creds.pageToken}`);
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message);
  return (data.data || []).filter((x) => new Date(x.created_time).getTime() >= since);
}

const sections = [
  ['Фото, загруженные на страницу', 'photos?type=uploaded', 'id,created_time,name,link'],
  ['Видео страницы', 'videos?type=uploaded', 'id,created_time,description,permalink_url'],
  ['Посты ленты', 'feed?', 'id,created_time,message,permalink_url'],
];

for (const [title, edge, fields] of sections) {
  console.log(`\n=== ${title} за ${minutes} мин ===`);
  try {
    const items = await list(edge, fields);
    if (!items.length) console.log('  пусто');
    for (const x of items) {
      const text = (x.name || x.description || x.message || '').replace(/\s+/g, ' ').slice(0, 60);
      console.log(`  ${x.id} · ${x.created_time}${text ? ` · ${text}` : ''}`);
    }
  } catch (err) {
    console.log(`  не удалось прочитать: ${err.message}`);
  }
}
