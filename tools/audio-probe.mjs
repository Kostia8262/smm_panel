#!/usr/bin/env node
/**
 * Проба Instagram Audio API: какие звуки видит аккаунт и прикрепляются ли они.
 *
 * API появился у Meta 1 июня 2026 и описан скупо: в документации токен назван
 * «User access token», а панель хранит только токен страницы; про регион
 * трендов, петлю короткого трека и то, куда ведёт `download_url`, там ни слова.
 * Скрипт отвечает на это живым аккаунтом, прежде чем строить на API панель.
 *
 *   node tools/audio-probe.mjs --project 1                  # трендовые music и original_sound
 *   node tools/audio-probe.mjs --project 1 --q "lofi"       # поиск по слову
 *   node tools/audio-probe.mjs --project 1 --meta AUDIO_ID  # карточка одного звука
 *   node tools/audio-probe.mjs --project 1 --publish https://…/ролик.mp4 --audio AUDIO_ID
 *
 * Ключи публикации:
 *   --audio-volume N   громкость трека, 0–100 (по умолчанию 100)
 *   --video-volume N   громкость звука ролика, 0–100 (по умолчанию 0)
 *   --wait N           сколько секунд Reels повисит перед удалением (по умолчанию 45)
 *   --version vXX.0    версия Graph API (по умолчанию v21.0, как у адаптеров)
 *
 * Публикация, как и smoke-post, снимает пост за собой. След пишется в
 * `data/smoke-audio-<время>.json` и стирается, когда удаление прошло: остаётся
 * он только тогда, когда пост висит и его надо снимать руками.
 */

import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
const project = listProjects().find((p) => p.id === projectId);
if (!project) {
  console.error('Проект не найден');
  process.exit(1);
}

const creds = credentialsFor(projectId, 'instagram');
if (!creds.pageToken || !creds.userId) {
  console.error('У проекта не заполнен Instagram');
  process.exit(1);
}

const version = flag('version', 'v21.0');
const api = (v = version) => `https://graph.facebook.com/${v}`;

console.log(`Проект: ${project.title} · Instagram ${creds.userId}\n`);

async function get(path, params, v) {
  const qs = new URLSearchParams({ ...params, access_token: creds.pageToken });
  const res = await fetch(`${api(v)}/${path}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`${e.message || res.status}${e.code ? ` (код ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}`);
  }
  return data;
}

/** Адрес без подписи: полная ссылка длинная и подписана CDN, нужен только хост. */
function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ? '?' : '—';
  }
}

function printAudio(a) {
  const who = a.display_artist || (a.ig_username ? `@${a.ig_username}` : '—');
  const secs = a.duration_in_ms ? `${Math.round(a.duration_in_ms / 1000)} с` : '? с';
  console.log(`  ${a.audio_id || a.id} · ${a.audio_type} · ${secs} · ${a.title || '(без названия)'} — ${who}`);
  console.log(
    `      скачать: ${host(a.download_url)} · прослушка: ${host(a.on_platform_audio_preview_link)} · обложка: ${host(a.cover_artwork_thumbnail_uri || a.profile_picture_url)} · реклама: ${a.is_ads_eligible ?? '—'}`
  );
}

const metaId = flag('meta');
const publishUrl = flag('publish');

if (metaId) {
  const data = await get(metaId, { user_id: creds.userId });
  console.log('Поля, которые вернула площадка:', Object.keys(data).join(', '));
  printAudio(data);
  process.exit(0);
}

if (publishUrl) {
  await publishProbe();
  process.exit(0);
}

// Поиск. Версия API проверяется двумя: адаптеры сидят на v21.0, а Audio API
// вышел в июне 2026 — не исключено, что старой версии он не отвечает вовсе.
const q = flag('q');
for (const v of [...new Set([version, 'v25.0'])]) {
  for (const type of ['music', 'original_sound']) {
    const title = `${v} · ${type}${q ? ` · «${q}»` : ' · тренды'}`;
    try {
      const data = await get('ig_audio', { audio_type: type, user_id: creds.userId, ...(q ? { search_query: q } : {}) }, v);
      const rows = data.data || [];
      console.log(`=== ${title}: ${rows.length} шт.${data.paging?.cursors?.after ? ', есть следующая страница' : ''}`);
      rows.slice(0, 8).forEach(printAudio);
      if (rows[0]) console.log('  поля:', Object.keys(rows[0]).join(', '));
    } catch (err) {
      console.log(`=== ${title}: ОТКАЗ — ${err.message}`);
    }
    console.log('');
  }
}

async function publishProbe() {
  const audioId = flag('audio');
  if (!audioId) {
    console.error('Нужен --audio AUDIO_ID');
    process.exit(1);
  }
  const audioVolume = Number(flag('audio-volume', 100));
  const videoVolume = Number(flag('video-volume', 0));
  const waitSec = Number(flag('wait', 45));

  const call = async (path, params) => {
    const body = new URLSearchParams({ ...params, access_token: creds.pageToken });
    const res = await fetch(`${api()}/${path}`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`${path}: ${data.error?.message || res.status}`);
    return data;
  };

  const audio_configuration = JSON.stringify({ audio_id: audioId, audio_volume: audioVolume, video_volume: videoVolume });
  console.log(`Ролик: ${publishUrl}`);
  console.log(`audio_configuration: ${audio_configuration}\n`);

  const { id: containerId } = await call(`${creds.userId}/media`, {
    media_type: 'REELS',
    video_url: publishUrl,
    caption: `Технічна перевірка звуку, ${new Date().toLocaleString('uk-UA')}. Пост буде видалено автоматично.`,
    audio_configuration,
  });
  console.log(`контейнер: ${containerId}`);

  const started = Date.now();
  for (let i = 0; ; i++) {
    const s = await get(containerId, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error(`контейнер не собрался: ${s.status}`);
    if (i > 40) throw new Error('контейнер не дошёл до готовности');
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`готов через ${Math.round((Date.now() - started) / 1000)} с`);

  const { id: mediaId } = await call(`${creds.userId}/media_publish`, { creation_id: containerId });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dataDir = resolve(here, '../data');
  mkdirSync(dataDir, { recursive: true });
  const logPath = resolve(dataDir, `smoke-audio-${stamp}.json`);
  writeFileSync(logPath, JSON.stringify({ project: project.title, instagram: mediaId }, null, 2), 'utf8');
  console.log(`опубликовано: ${mediaId}`);

  try {
    const m = await get(mediaId, { fields: 'media_type,media_product_type,media_audio_type,permalink' });
    console.log(`площадка о посте: ${JSON.stringify(m)}`);
  } catch (err) {
    console.log(`поля поста прочитать не удалось: ${err.message}`);
  }

  console.log(`\nЖду ${waitSec} с — можно открыть пост и послушать...`);
  await new Promise((r) => setTimeout(r, waitSec * 1000));

  const res = await fetch(`${api()}/${mediaId}?access_token=${creds.pageToken}`, { method: 'DELETE' });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) {
    console.log(`\nНЕ УДАЛЕНО — снять руками: ${mediaId} (${out.error?.message || res.status})`);
    console.log(`след оставлен: ${logPath}`);
    process.exit(2);
  }
  rmSync(logPath, { force: true });
  console.log('удалено, след стёрт');
}
