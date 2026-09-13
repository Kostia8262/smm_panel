#!/usr/bin/env node
/**
 * Какие разрешения на самом деле есть у наших токенов.
 *
 * Вопрос не праздный: токен, выпущенный «чтобы публиковать», публикует, но
 * не удаляет — за удаление отвечают отдельные разрешения, и узнать об этом
 * лучше до того, как тестовый пост повиснет в живом аккаунте школы.
 *
 * Разрешения нельзя выпросить у Graph API Explorer напрямую: пока они не
 * добавлены в сценарий использования приложения, их просто нет в списке.
 *
 *   node tools/token-scopes.mjs            # все проекты
 *   node tools/token-scopes.mjs --project 1
 *
 * Сами токены не печатаются ни при каком раскладе.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_API } from '../src/platforms/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { listProjects, credentialsFor } = await import('../src/projects.js');

/** Что нужно площадке, чтобы панель могла и публиковать, и убирать за собой. */
const NEEDED = {
  facebook: {
    publish: ['pages_manage_posts'],
    remove: ['pages_manage_posts'],
    note: 'удаление документировано с оговоркой «only select developers» — отказ возможен и с верным разрешением',
  },
  instagram: {
    publish: ['instagram_basic', 'instagram_content_publish'],
    remove: ['instagram_manage_contents'],
    note: 'текстовый пост Instagram не принимает вовсе — нужна картинка JPEG',
  },
  threads: {
    publish: ['threads_basic', 'threads_content_publish'],
    remove: ['threads_delete'],
    note: 'удалений не больше ста в сутки на аккаунт',
  },
};

const args = process.argv.slice(2);
const only = Number(args[args.indexOf('--project') + 1]) || null;

const projects = listProjects().filter((p) => !only || p.id === only);
if (!projects.length) {
  console.error('Таких проектов нет');
  process.exit(1);
}

for (const project of projects) {
  console.log(`\n=== ${project.title} ===`);

  for (const [platform, need] of Object.entries(NEEDED)) {
    const creds = credentialsFor(project.id, platform);
    const token = creds.accessToken || creds.pageToken;
    if (!token) {
      console.log(`  ${platform}: доступы не заполнены`);
      continue;
    }

    let scopes;
    let info = null;
    try {
      info = await readDebug(platform, token, project.id);
      scopes = info === 'unknown' ? 'unknown' : info.scopes || [];
    } catch (err) {
      console.log(`  ${platform}: не удалось спросить — ${err.message}`);
      continue;
    }

    if (scopes === 'unknown') {
      console.log(`  ${platform}: список разрешений площадка не отдаёт — проверяется только пробой`);
      console.log(`     важно: ${need.note}`);
      continue;
    }
    if (!scopes) {
      console.log(`  ${platform}: площадка не отдала список разрешений`);
      continue;
    }

    const missPublish = need.publish.filter((s) => !scopes.includes(s));
    const missRemove = need.remove.filter((s) => !scopes.includes(s));

    console.log(`  ${platform}: ${scopes.join(', ') || '— пусто —'}`);
    console.log(`     публикация: ${missPublish.length ? `НЕ ХВАТАЕТ ${missPublish.join(', ')}` : 'ок'}`);
    console.log(`     удаление:   ${missRemove.length ? `НЕ ХВАТАЕТ ${missRemove.join(', ')}` : 'ок'}`);
    console.log(`     ${lifetime(info)}`);
    if (need.note) console.log(`     важно: ${need.note}`);
  }
}

/**
 * Какой это токен и сколько проживёт.
 *
 * Нужно, чтобы не сломать бессрочные токены при подключении кнопкой: токен
 * системного пользователя и токен страницы, полученный через личный вход,
 * живут одинаково долго, но ломаются по-разному — первый не зависит от
 * пароля владельца, второй сбрасывается его сменой.
 *
 * `expires_at: 0` — бессрочный. `data_access_expires_at` — правило 90 дней
 * без входа в приложение: у прав страниц оно по документации не действует.
 */
function lifetime(info) {
  if (!info || info === 'unknown') return 'срок: неизвестен';
  const when = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const expires = info.expires_at === 0 ? 'бессрочный' : info.expires_at ? `до ${when(info.expires_at)}` : 'срок не отдан';
  const access = info.data_access_expires_at ? `, доступ к данным до ${when(info.data_access_expires_at)}` : '';
  return `тип: ${info.type || '—'}, ${expires}${access}`;
}

/**
 * Список разрешений токена.
 *
 * У Facebook и Instagram его отдаёт `debug_token`, и спрашивать надо токеном
 * приложения — отсюда appId и appSecret из карточки Facebook того же проекта.
 *
 * У Threads `debug_token` тоже есть, хотя в документации его нет, — выяснено
 * 13.09.2026, когда три токена подряд не умели удалять. Спрашивать можно самим
 * токеном. Именно он показал, что «Генератор маркеров» выдаёт фиксированный
 * набор прав и не берёт добавленные в сценарий `threads_delete` и
 * `threads_keyword_search`.
 */
async function readDebug(platform, token, projectId) {
  if (platform === 'threads') {
    const res = await fetch(`https://graph.threads.net/v1.0/debug_token?input_token=${token}&access_token=${token}`);
    const data = await res.json().catch(() => ({}));
    // Не ответил — честное «неизвестно», а не выдуманный список.
    if (data.error || !Array.isArray(data.data?.scopes)) return 'unknown';
    return data.data;
  }

  const fb = credentialsFor(projectId, 'facebook');
  if (!fb.appId || !fb.appSecret) throw new Error('не заполнены ID и секрет приложения в карточке Facebook');

  const appToken = `${fb.appId}|${fb.appSecret}`;
  const url = `${GRAPH_API}/debug_token?input_token=${token}&access_token=${appToken}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message);
  return data.data || {};
}
