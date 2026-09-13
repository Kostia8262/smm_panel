#!/usr/bin/env node
/**
 * Сторис страницы Facebook: что это за объект и чем его снять.
 *
 * Появился 13.09.2026: боевая проба сторис Facebook опубликовала фото и видео,
 * а удаление по `post_id`, который отдают `/photo_stories` и `/video_stories`,
 * получило «Unsupported delete request». Инструмент показывает сторис
 * страницы (`/{page}/stories`: post_id, media_id, статус), а с `--remove`
 * пробует снять названную сторис по очереди разными id и останавливается на
 * первом, который сработал, — так видно, какой id адаптер должен сохранять.
 *
 *   node tools/fb-story-probe.mjs --project 1
 *   node tools/fb-story-probe.mjs --project 1 --remove 1052073807702955
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_API, GRAPH_VERSION } from '../src/platforms/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { credentialsFor } = await import('../src/projects.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const projectId = Number(flag('project', 1));
const target = flag('remove');
const { pageId, pageToken } = credentialsFor(projectId, 'facebook');
if (!pageId || !pageToken) {
  console.error('Facebook у проекта не заполнен');
  process.exit(1);
}

async function graph(method, path, params = {}, api = GRAPH_API) {
  const qs = new URLSearchParams({ ...params, access_token: pageToken });
  const res = await fetch(`${api}/${path}?${qs}`, { method });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const brief = (r) => (r.data.error ? `ошибка ${r.data.error.code}: ${r.data.error.message}` : JSON.stringify(r.data));

console.log(`=== Сторис страницы (${GRAPH_VERSION}) ===`);
const list = await graph('GET', `${pageId}/stories`);
const stories = list.data.data || [];
if (list.data.error) console.log(`  ${brief(list)}`);
for (const s of stories.slice(0, 10)) {
  console.log(`  post_id ${s.post_id} · media_id ${s.media_id ?? '—'} · ${s.media_type ?? '?'} · ${s.status ?? '?'} · ${s.creation_time ?? ''}`);
}
if (!list.data.error && !stories.length) console.log('  пусто');

if (target) {
  const story = stories.find((s) => String(s.post_id) === target || String(s.media_id) === target);
  console.log(`\n=== Что за объект ${target} ===`);
  for (const v of ['v21.0', GRAPH_VERSION]) {
    const api = `https://graph.facebook.com/${v}`;
    console.log(`  ${v} GET ${target}: ${brief(await graph('GET', target, {}, api))}`);
    console.log(`  ${v} GET ${pageId}_${target}: ${brief(await graph('GET', `${pageId}_${target}`, {}, api))}`);
  }

  const candidates = [...new Set([target, `${pageId}_${target}`, story?.media_id && String(story.media_id)].filter(Boolean))];
  console.log(`\n=== Снять (${GRAPH_VERSION}), по очереди: ${candidates.join(', ')} ===`);
  for (const id of candidates) {
    const r = await graph('DELETE', id);
    console.log(`  DELETE ${id}: ${brief(r)}`);
    if (!r.data.error && r.data.success !== false) {
      console.log(`\nСнято по id ${id}`);
      break;
    }
  }

  const after = await graph('GET', `${pageId}/stories`);
  const still = (after.data.data || []).find((s) => String(s.post_id) === String(story?.post_id ?? target));
  console.log(`\nВ списке сторис после попытки: ${still ? `ещё есть (статус ${still.status})` : 'нет'}`);
}
