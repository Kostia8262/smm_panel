#!/usr/bin/env node
/**
 * Ссылка на опубликованный пост по его id.
 *
 * Нужна, когда пост надо снять руками: Threads не возвращает ссылку при
 * публикации, а без неё найти в ленте конкретный пост — отдельная морока.
 * Так было 12.09.2026: проба опубликовалась, а удалить Threads не дал —
 * у токена не оказалось threads_delete.
 *
 *   node tools/post-link.mjs --project 1 --platform threads --id 18109280204332009
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_API } from '../src/platforms/graph.js';

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
const platform = flag('platform') || 'threads';
const id = flag('id');
if (!id) {
  console.error('Нужен --id опубликованного поста');
  process.exit(1);
}

const creds = credentialsFor(projectId, platform);

const HOSTS = {
  threads: { api: 'https://graph.threads.net/v1.0', token: creds.accessToken, fields: 'permalink,text,timestamp' },
  instagram: { api: GRAPH_API, token: creds.pageToken, fields: 'permalink,caption,timestamp' },
  facebook: { api: GRAPH_API, token: creds.pageToken, fields: 'permalink_url,message,created_time' },
};

const cfg = HOSTS[platform];
if (!cfg?.token) {
  console.error(`Нет токена для ${platform}`);
  process.exit(1);
}

const res = await fetch(`${cfg.api}/${id}?fields=${cfg.fields}&access_token=${cfg.token}`);
const data = await res.json().catch(() => ({}));
if (!res.ok || data.error) {
  console.error(`Не удалось спросить: ${data.error?.message || res.status}`);
  process.exit(1);
}

const link = data.permalink || (data.permalink_url ? `https://facebook.com${data.permalink_url}` : null);
console.log(`id:    ${id}`);
console.log(`ссылка: ${link || '— площадка не отдала —'}`);
if (data.text || data.caption || data.message) console.log(`текст: ${data.text || data.caption || data.message}`);
if (data.timestamp || data.created_time) console.log(`когда: ${data.timestamp || data.created_time}`);
