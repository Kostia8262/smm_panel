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

export function isConfigured() {
  return Boolean(process.env.TIKTOK_ACCESS_TOKEN);
}

export function missingConfig() {
  const missing = [];
  if (!process.env.TIKTOK_ACCESS_TOKEN) missing.push('TIKTOK_ACCESS_TOKEN');
  if (!process.env.TIKTOK_CLIENT_KEY) missing.push('TIKTOK_CLIENT_KEY');
  if (!process.env.TIKTOK_CLIENT_SECRET) missing.push('TIKTOK_CLIENT_SECRET');
  return missing;
}

async function call(path, payload) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TIKTOK_ACCESS_TOKEN}`,
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
export async function creatorInfo() {
  return call('post/publish/creator_info/query/', {});
}

export async function check() {
  const info = await creatorInfo();
  return { ok: true, account: info.creator_nickname };
}

export async function publish({ text, media = [], publicUrl }) {
  const video = media.find((m) => m.kind === 'video');
  if (!video) throw new Error('TikTok ждёт видео (фото-посты — отдельный порядок)');

  const privacy = process.env.TIKTOK_PRIVACY || 'SELF_ONLY';
  const useUrl = process.env.TIKTOK_DOMAIN_VERIFIED === 'true';

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
  });

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
export async function status(publishId) {
  return call('post/publish/status/fetch/', { publish_id: publishId });
}
