/**
 * TikTok — Content Posting API (сверено с developers.tiktok.com 14.09.2026).
 *
 * Два режима, оба выбраны владельцем:
 *   direct — пост сразу в ленту (`video.publish`);
 *   draft  — ролик ложится в черновики TikTok (`video.upload`), публикует
 *            человек в приложении. Так к нему добавляется трендовый звук:
 *            звук через API TikTok не выбирается вовсе.
 *
 * Правила площадки, из-за которых код устроен именно так:
 *   — приватность, комментарии, дуэты, стичи и отметку рекламы выбирает
 *     человек у каждого поста, без значений по умолчанию (правило аудита).
 *     Поэтому их здесь нет в доступах — они приходят в настройках цели;
 *   — пока приложение не прошло аудит, TikTok публикует только «Только я»;
 *   — загрузка файлом — кусками от 5 до 64 МБ, файл меньше 5 МБ — целиком;
 *   — фото-посты и загрузка по ссылке — только с подтверждённого в кабинете
 *     адреса (у нас — префикс /media/ панели);
 *   — публикация асинхронная: итог узнаётся опросом статуса.
 *
 * Токен доступа живёт сутки и обновляется перед запросом в src/live-creds.js —
 * сюда доступы приходят уже свежими.
 */

import { openSync, readSync, closeSync } from 'node:fs';
import { refreshTokens } from '../oauth/tiktok.js';
import { parseOptions } from '../target-options.js';

const API = 'https://open.tiktokapis.com/v2';
const MB = 1024 * 1024;

export const id = 'tiktok';

export function isConfigured(creds = {}) {
  return Boolean(creds.clientKey && creds.clientSecret && creds.accessToken && creds.refreshToken);
}

export function missingConfig(creds = {}) {
  const missing = [];
  if (!creds.clientKey) missing.push('client key');
  if (!creds.clientSecret) missing.push('client secret');
  if (!creds.accessToken || !creds.refreshToken) missing.push('подключение кнопкой «Подключить через TikTok»');
  return missing;
}

/** Отказы площадки — словами, по которым понятно, что делать. */
const HUMAN = {
  spam_risk_too_many_posts: 'аккаунт исчерпал суточный лимит публикаций через API — повторите завтра',
  spam_risk_user_banned_from_posting: 'TikTok запретил этому аккаунту публиковать',
  reached_active_user_cap: 'приложение исчерпало суточный лимит публикующих аккаунтов',
  unaudited_client_can_only_post_to_private_accounts: 'пока приложение не прошло аудит, TikTok публикует только с видимостью «Только я»',
  privacy_level_option_mismatch: 'такая видимость этому аккаунту недоступна — выберите другую',
  url_ownership_unverified: 'адрес панели не подтверждён в кабинете TikTok — фото-посты и загрузка по ссылке недоступны',
  access_token_invalid: 'токен TikTok не действует — подключите TikTok кнопкой заново',
  scope_not_authorized: 'у токена нет нужного права — подключите TikTok кнопкой заново',
  scope_permission_missed: 'у токена нет нужного права — подключите TikTok кнопкой заново',
  rate_limit_exceeded: 'TikTok притормозил запросы — повторим позже',
  file_format_check_failed: 'TikTok не принял формат файла',
  duration_check_failed: 'ролик длиннее или короче, чем разрешено аккаунту',
  frame_rate_check_failed: 'TikTok не принял частоту кадров ролика',
  picture_size_check_failed: 'TikTok не принял размер картинки',
  video_pull_failed: 'TikTok не смог скачать ролик по ссылке панели',
  photo_pull_failed: 'TikTok не смог скачать фото по ссылке панели',
  publish_cancelled: 'публикацию отменили в TikTok',
  auth_removed: 'доступ панели к аккаунту отозван в TikTok — подключите заново',
  spam_risk_text: 'TikTok счёл текст поста спамом',
  spam_risk: 'TikTok заподозрил спам',
};

export class TikTokError extends Error {
  constructor(code, message) {
    super(`TikTok: ${HUMAN[code] || message || code}`);
    this.code = code;
  }
}

async function call(path, payload, creds, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${API}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new TikTokError('network', `площадка не отвечает (${err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  const code = data.error?.code;
  if (!res.ok || (code && code !== 'ok')) throw new TikTokError(code || `http_${res.status}`, data.error?.message || `ошибка ${res.status}`);
  return data.data || {};
}

/**
 * Данные автора. По правилам аудита интерфейс обязан показывать, в чей аккаунт
 * уйдёт пост, и брать это свежим при каждом показе — отсюда отдельный вызов.
 */
export async function creatorInfo(creds, { fetchImpl = fetch } = {}) {
  const d = await call('post/publish/creator_info/query/', {}, creds, fetchImpl);
  return {
    username: d.creator_username || '',
    nickname: d.creator_nickname || '',
    avatarUrl: d.creator_avatar_url || null,
    privacyOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [],
    commentDisabled: Boolean(d.comment_disabled),
    duetDisabled: Boolean(d.duet_disabled),
    stitchDisabled: Boolean(d.stitch_disabled),
    maxVideoSeconds: Number(d.max_video_post_duration_sec) || null,
  };
}

export async function check(creds) {
  const info = await creatorInfo(creds);
  return { ok: true, account: info.username ? `@${info.username}` : info.nickname };
}

/** Для сторожа и кнопки «Продлить токен»: обновить токены и отдать новые значения. */
export async function renew(creds) {
  const values = await refreshTokens(creds);
  const until = Date.parse(values.refreshExpiresAt || '');
  return { values, expiresIn: Number.isFinite(until) ? Math.round((until - Date.now()) / 1000) : null };
}

/**
 * Как резать файл.
 *
 * Правила TikTok: кусок 5–64 МБ, последний — до 128 МБ, файл меньше 5 МБ —
 * целиком, `total_chunk_count = floor(size / chunk_size)`. Отсюда ловушка:
 * файл 6 МБ с заявленным куском 10 МБ дал бы ноль кусков. Поэтому до 20 МБ —
 * одним куском размером с файл, крупнее — по 10 МБ, остаток уходит в
 * последний кусок (он выходит меньше 20 МБ — в пределах разрешённых 128).
 */
export function chunkPlan(size, chunk = 10 * MB) {
  if (!(size > 0)) throw new Error('TikTok: пустой файл');
  if (size <= 2 * chunk) return { chunkSize: size, total: 1, ranges: [[0, size - 1]] };
  const chunkSize = Math.min(Math.max(chunk, 5 * MB), 64 * MB);
  const total = Math.floor(size / chunkSize);
  const ranges = [];
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = i === total - 1 ? size - 1 : start + chunkSize - 1;
    ranges.push([start, end]);
  }
  return { chunkSize, total, ranges };
}

async function uploadFile(uploadUrl, file, plan, fetchImpl) {
  const fd = openSync(file.path, 'r');
  try {
    for (const [start, end] of plan.ranges) {
      const length = end - start + 1;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      const res = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.mime || 'video/mp4',
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${file.bytes}`,
        },
        body: buf,
      });
      if (!res.ok) throw new TikTokError('upload', `заливка файла не прошла (кусок ${start}–${end}, ответ ${res.status})`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Дождаться итога. Прямая публикация готова на PUBLISH_COMPLETE, черновик —
 * на SEND_TO_USER_INBOX. Если TikTok всё ещё обрабатывает, повторять нельзя —
 * вышел бы дубль; возвращаем «в обработке» с предупреждением.
 */
async function waitStatus(publishId, creds, { draft, tries = 40, pauseMs = 15000, fetchImpl }) {
  let last = {};
  for (let i = 0; i < tries; i++) {
    last = await call('post/publish/status/fetch/', { publish_id: publishId }, creds, fetchImpl);
    if (last.status === 'FAILED') throw new TikTokError(last.fail_reason || 'failed', `публикация не прошла (${last.fail_reason || 'без объяснения'})`);
    if (last.status === 'PUBLISH_COMPLETE' || (draft && last.status === 'SEND_TO_USER_INBOX')) return last;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { ...last, stillProcessing: true };
}

function postInfo(text, o, info, { photo = false } = {}) {
  const base = {
    privacy_level: o.privacy,
    disable_comment: info.commentDisabled || !o.allowComment,
    brand_content_toggle: Boolean(o.commercial && o.brandedContent),
    brand_organic_toggle: Boolean(o.commercial && o.yourBrand),
  };
  if (photo) {
    const firstLine = String(text || '').split('\n')[0].trim();
    return { ...base, title: firstLine.slice(0, 90), description: String(text || '').slice(0, 4000), auto_add_music: Boolean(o.autoMusic) };
  }
  return {
    ...base,
    title: String(text || '').slice(0, 2200),
    disable_duet: info.duetDisabled || !o.allowDuet,
    disable_stitch: info.stitchDisabled || !o.allowStitch,
  };
}

/**
 * Проверки до init: то, что TikTok отверг бы уже после загрузки файла, а
 * человеку объяснить нечем — видимость, недоступная аккаунту, длина ролика.
 */
function precheck(o, info, creds, video) {
  if (!o.privacy) throw new Error('TikTok: не выбрано, кто увидит пост');
  if (!info.privacyOptions.includes(o.privacy)) throw new TikTokError('privacy_level_option_mismatch');
  if (String(creds.audited) !== 'true' && o.privacy !== 'SELF_ONLY') {
    throw new TikTokError('unaudited_client_can_only_post_to_private_accounts');
  }
  if (video?.duration && info.maxVideoSeconds && video.duration > info.maxVideoSeconds + 0.5) {
    throw new Error(`TikTok: ролик ${Math.round(video.duration)} с, а этому аккаунту через API можно до ${info.maxVideoSeconds} с`);
  }
}

/**
 * @param {object} args
 * @param {object} [args.options] — настройки цели TikTok (src/target-options.js)
 * @param {{tries?: number, pauseMs?: number}} [args.wait] — подмена ожидания в тестах
 */
export async function publish({ text, media = [], formatId = 'video', publicUrl, creds, options, wait = {}, fetchImpl = fetch }) {
  const o = parseOptions(options);
  const draft = o.mode === 'draft';
  const verified = String(creds.domainVerified) === 'true';

  if (formatId === 'photo') return publishPhotos({ text, media, publicUrl, creds, o, draft, verified, wait, fetchImpl });

  const video = media.length === 1 && media[0].kind === 'video' ? media[0] : null;
  if (!video) throw new Error('TikTok: для видео-поста нужен ровно один ролик');

  const info = draft ? null : await creatorInfo(creds, { fetchImpl });
  if (!draft) precheck(o, info, creds, video);

  const plan = verified ? null : chunkPlan(video.bytes);
  const sourceInfo = verified
    ? { source: 'PULL_FROM_URL', video_url: publicUrl(video) }
    : { source: 'FILE_UPLOAD', video_size: video.bytes, chunk_size: plan.chunkSize, total_chunk_count: plan.total };

  const init = draft
    ? await call('post/publish/inbox/video/init/', { source_info: sourceInfo }, creds, fetchImpl)
    : await call('post/publish/video/init/', { post_info: postInfo(text, o, info), source_info: sourceInfo }, creds, fetchImpl);

  if (!verified) await uploadFile(init.upload_url, video, plan, fetchImpl);
  return finish(init.publish_id, creds, { draft, info, wait, fetchImpl });
}

async function publishPhotos({ text, media, publicUrl, creds, o, draft, verified, wait, fetchImpl }) {
  const photos = media.filter((m) => m.kind === 'image');
  if (!photos.length || photos.length !== media.length) throw new Error('TikTok: в фото-посте только фото, без роликов');
  if (!verified) throw new TikTokError('url_ownership_unverified');

  const info = draft ? null : await creatorInfo(creds, { fetchImpl });
  if (!draft) precheck(o, info, creds, null);

  const body = {
    media_type: 'PHOTO',
    post_mode: draft ? 'MEDIA_UPLOAD' : 'DIRECT_POST',
    post_info: draft
      ? { title: String(text || '').split('\n')[0].trim().slice(0, 90), description: String(text || '').slice(0, 4000) }
      : postInfo(text, o, info, { photo: true }),
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: photos.slice(0, 35).map((m) => publicUrl(m)) },
  };
  const init = await call('post/publish/content/init/', body, creds, fetchImpl);
  return finish(init.publish_id, creds, { draft, info, wait, fetchImpl });
}

async function finish(publishId, creds, { draft, info, wait, fetchImpl }) {
  const status = await waitStatus(publishId, creds, { draft, ...wait, fetchImpl });
  const postId = Array.isArray(status.publicaly_available_post_id) ? status.publicaly_available_post_id[0] : null;
  const out = {
    externalId: postId ? String(postId) : publishId,
    url: postId && info?.username ? `https://www.tiktok.com/@${info.username}/video/${postId}` : null,
    publishId,
    draft,
  };
  if (status.stillProcessing) {
    out.warning = 'TikTok ещё обрабатывает публикацию — проверьте пост в приложении через несколько минут';
  } else if (draft) {
    out.warning = 'ролик в черновиках TikTok — опубликуйте его в приложении';
  }
  return out;
}
