#!/usr/bin/env node
/**
 * Сверка двух версий Graph API на боевых доступах — перед сменой версии.
 *
 * Появился 13.09.2026 при переезде с v21.0 (умирает 21.01.2027) на v26.0.
 * Списки изменений Meta пишут про рекламу и статистику, а про наши вызовы
 * молчат — «молчат» не значит «не изменилось». Поэтому каждый запрос, которым
 * пользуется панель, задаётся обеими версиями, и сравнивается форма ответа:
 * статус, ошибка, набор полей и совпадение значений.
 *
 * Только чтение: ничего не публикует и не меняет. Токены и значения полей не
 * печатаются — лишь «совпало / разошлось» и имена полей.
 *
 *   node tools/graph-version-probe.mjs --project 1 --from v21.0 --to v26.0
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
const from = flag('from', 'v21.0');
const to = flag('to', 'v26.0');

const fb = credentialsFor(projectId, 'facebook');
const ig = credentialsFor(projectId, 'instagram');
const appToken = fb.appId && fb.appSecret ? `${fb.appId}|${fb.appSecret}` : null;

// Поля, которые меняются сами по себе между двумя запросами подряд.
const VOLATILE = /(^|\.)(fan_count|followers_count|quota_usage|download_url|expires_at|data_access_expires_at|issued_at)$/;

/** Пути полей до третьего уровня: `data.scopes`, `config.quota_total`… */
function paths(value, prefix = '', depth = 0, out = new Map()) {
  if (value && typeof value === 'object' && depth < 3) {
    const entries = Array.isArray(value) ? (value.length ? [['[]', value[0]]] : []) : Object.entries(value);
    for (const [k, v] of entries) paths(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    if (!entries.length) out.set(prefix, JSON.stringify(value));
  } else {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

async function ask(url) {
  try {
    const res = await fetch(url);
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json().catch(() => ({})) : null;
    return { status: res.status, body };
  } catch (err) {
    return { status: 'сеть', body: { error: { message: err.message } } };
  }
}

let problems = 0;

async function compare(label, build) {
  const [a, b] = await Promise.all([ask(build(from)), ask(build(to))]);
  const errA = a.body?.error;
  const errB = b.body?.error;
  const lines = [];

  if (a.status !== b.status) lines.push(`статус ${a.status} → ${b.status}`);
  if (Boolean(errA) !== Boolean(errB) || (errA && errB && errA.code !== errB.code)) {
    lines.push(`ошибка: ${errA ? `${errA.code} ${errA.message}` : 'нет'} → ${errB ? `${errB.code} ${errB.message}` : 'нет'}`);
  }

  if (a.body && b.body && !errA && !errB) {
    const pa = paths(a.body);
    const pb = paths(b.body);
    const gone = [...pa.keys()].filter((k) => !pb.has(k));
    const added = [...pb.keys()].filter((k) => !pa.has(k));
    const changed = [...pa.keys()].filter((k) => pb.has(k) && !VOLATILE.test(k) && pa.get(k) !== pb.get(k));
    if (gone.length) lines.push(`пропали поля: ${gone.join(', ')}`);
    if (added.length) lines.push(`новые поля: ${added.join(', ')}`);
    if (changed.length) lines.push(`другие значения: ${changed.join(', ')}`);
  }

  const same = !lines.length;
  if (!same) problems += 1;
  const tail = errA && same ? ` (обе версии отвечают ошибкой ${errA.code}: ${errA.message})` : '';
  console.log(`${same ? 'совпало ' : 'РАЗОШЛОСЬ'}  ${label}${tail}`);
  for (const line of lines) console.log(`           ${line}`);
}

const graph = (v) => `https://graph.facebook.com/${v}`;
const qs = (params) => new URLSearchParams(params).toString();

console.log(`Сверка ${from} → ${to}, проект ${projectId}\n`);

if (fb.pageId && fb.pageToken) {
  const token = fb.pageToken;
  await compare('страница: name,fan_count (проверка связи)', (v) =>
    `${graph(v)}/${fb.pageId}?${qs({ fields: 'name,fan_count', access_token: token })}`);
  await compare('me токеном страницы', (v) => `${graph(v)}/me?${qs({ fields: 'id,name', access_token: token })}`);
  if (appToken) {
    await compare('debug_token токена страницы (сторож, кнопка входа)', (v) =>
      `${graph(v)}/debug_token?${qs({ input_token: token, access_token: appToken })}`);
  }
  await compare('последнее видео страницы: status (ожидание Reels)', (v) =>
    `${graph(v)}/${fb.pageId}/videos?${qs({ fields: 'id,status', limit: '1', access_token: token })}`);
} else {
  console.log('Facebook не заполнен — пропуск');
}

if (ig.userId && ig.pageToken) {
  const token = ig.pageToken;
  await compare('Instagram: username,followers_count (проверка связи)', (v) =>
    `${graph(v)}/${ig.userId}?${qs({ fields: 'username,followers_count', access_token: token })}`);
  await compare('Instagram: content_publishing_limit', (v) =>
    `${graph(v)}/${ig.userId}/content_publishing_limit?${qs({ fields: 'config,quota_usage', access_token: token })}`);
  await compare('Instagram: последний пост, media_type и media_audio_type', (v) =>
    `${graph(v)}/${ig.userId}/media?${qs({ fields: 'id,media_type,media_audio_type', limit: '1', access_token: token })}`);
  await compare('Instagram Audio: поиск music', (v) =>
    `${graph(v)}/ig_audio?${qs({ audio_type: 'music', user_id: ig.userId, access_token: token })}`);
} else {
  console.log('Instagram не заполнен — пропуск');
}

if (fb.appId) {
  // Окно входа — HTML, сравнивается только статус: 200 значит, что путь жив.
  await compare('окно входа Facebook (dialog/oauth)', (v) =>
    `https://www.facebook.com/${v}/dialog/oauth?${qs({ client_id: fb.appId, redirect_uri: 'https://smm.mycomputer.education/oauth/facebook', response_type: 'code' })}`);
}

console.log(`\n${problems ? `Расхождений: ${problems} — разобрать до смены версии` : 'Расхождений нет'}`);
