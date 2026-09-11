/**
 * TikTok. Код написан по документации и НЕ проверен живым токеном.
 *
 * Единственная площадка, которую нельзя обойти режимом разработки: пока
 * приложение не прошло аудит, публикация принудительно приватная (SELF_ONLY)
 * и не более чем для пяти пользователей в сутки. Поэтому privacy ниже берётся
 * из окружения и по умолчанию приватная — чтобы после аудита это был один
 * правленый параметр, а не поиск по коду.
 *
 * Загрузка по ссылке (PULL_FROM_URL) требует верификации домена в кабинете
 * разработчика. Пока домен не подтверждён — работает только FILE_UPLOAD.
 */

import { openAsBlob } from 'node:fs';

const API = 'https://open.tiktokapis.com/v2';

export const id = 'tiktok';

export function isConfigured(creds = {}) {
  return Boolean(creds.accessToken && creds.clientKey);
}

export function missingConfig(creds = {}) {
  const missing = [];
  if (!creds.accessToken) missing.push('токен доступа');
  if (!creds.clientKey) missing.push('client key');
  if (!creds.clientSecret) missing.push('client secret');
  return missing;
}

async function call(path, payload, creds) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error?.code !== 'ok') {
    throw new Error(`TikTok ${path}: ${data.error?.message || res.status}`);
  }
  return data.data;
}

/**
 * Данные автора. Аудит требует показать имя и аватар в интерфейсе ПЕРЕД
 * публикацией — композер обязан их выводить, иначе заявку отклонят.
 */
export async function creatorInfo(creds) {
  return call('post/publish/creator_info/query/', {}, creds);
}

export async function check(creds) {
  const info = await creatorInfo(creds);
  return { ok: true, account: info.creator_nickname };
}

export async function publish({ text, media = [], publicUrl, creds }) {
  const video = media.find((m) => m.kind === 'video');
  if (!video) throw new Error('TikTok ждёт видео (фото-посты — отдельный порядок)');

  const privacy = creds.privacy || 'SELF_ONLY';
  const useUrl = String(creds.domainVerified) === 'true';

  const init = await call('post/publish/video/init/', {
    post_info: {
      title: (text || '').slice(0, 2200),
      privacy_level: privacy,
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
    },
    source_info: useUrl
      ? { source: 'PULL_FROM_URL', video_url: publicUrl(video) }
      : {
          source: 'FILE_UPLOAD',
          video_size: video.bytes,
          chunk_size: video.bytes,
          total_chunk_count: 1,
        },
  }, creds);

  if (!useUrl) {
    const blob = await openAsBlob(video.path);
    const put = await fetch(init.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': video.mime,
        'Content-Range': `bytes 0-${video.bytes - 1}/${video.bytes}`,
      },
      body: blob,
    });
    if (!put.ok) throw new Error(`TikTok: заливка файла не прошла (${put.status})`);
  }

  return { externalId: init.publish_id, url: null, pending: true };
}

/** Публикация асинхронная: результат узнаём отдельным опросом. */
export async function status(publishId, creds) {
  return call('post/publish/status/fetch/', { publish_id: publishId }, creds);
}
