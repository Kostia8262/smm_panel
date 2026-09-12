/**
 * Instagram. Тот же двухшаговый порядок, что у Threads: контейнер → публикация.
 *
 * Код написан по документации и НЕ проверен живым токеном.
 *
 * Две вещи, на которых спотыкаются все:
 *   1. контейнер принимает только JPEG — PNG отваливается с невнятной ошибкой
 *      (проверка стоит в validate.js, до сюда такой файл не доедет);
 *   2. видео готовится асинхронно, публиковать можно лишь когда статус
 *      контейнера станет FINISHED — отсюда опрос ниже.
 */

const API = 'https://graph.facebook.com/v21.0';

export const id = 'instagram';

export function isConfigured(creds = {}) {
  return Boolean(creds.userId && creds.pageToken);
}

export function missingConfig(creds = {}) {
  const missing = [];
  if (!creds.userId) missing.push('ID аккаунта');
  if (!creds.pageToken) missing.push('токен страницы');
  return missing;
}

async function call(path, params, creds) {
  const body = new URLSearchParams({ ...params, access_token: creds.pageToken });
  const res = await fetch(`${API}/${path}`, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Instagram ${path}: ${data.error?.message || res.status}`);
  }
  return data;
}

export async function check(creds) {
  const res = await fetch(
    `${API}/${creds.userId}?fields=username,followers_count&access_token=${creds.pageToken}`
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { ok: true, account: data.username };
}

/**
 * Удалить публикацию.
 *
 * Работает только у Instagram, подключённого «входом через Facebook» — то
 * есть ровно у нашего случая. Требует `instagram_manage_contents`: это
 * отдельное разрешение, которого нет у токена, выпущенного только под
 * публикацию, и добавлять его нужно в сценарий использования приложения.
 *
 * Карусель удаляется только целиком, по id самого поста; отдельный кадр
 * внутри неё — нет.
 */
export async function remove(externalId, creds) {
  const res = await fetch(`${API}/${externalId}?access_token=${creds.pageToken}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Instagram удаление: ${data.error?.message || res.status}`);
  }
  return { ok: Boolean(data.success ?? true) };
}

/** Суточный лимит у аккаунта свой — читаем, а не гадаем по документации. */
export async function remainingQuota(creds) {
  const res = await fetch(
    `${API}/${creds.userId}/content_publishing_limit?access_token=${creds.pageToken}`
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const row = data.data?.[0] || {};
  return { used: row.quota_usage ?? null, limit: row.config?.quota_total ?? null };
}

/**
 * Дождаться, пока контейнер станет FINISHED.
 *
 * Ждать нужно **всегда**, не только у видео: картинку площадка тоже качает
 * с нашего сервера не мгновенно, и `media_publish` по неготовому контейнеру
 * отвечает «Media ID is not available». Именно на этом свалилась первая
 * боевая проба 12.09.2026 — ожидание стояло только для видео и Reels.
 *
 * Шаг опроса разный: картинка готова за секунду-две, и десятисекундная пауза
 * там означала бы десять секунд на ровном месте, а видео обрабатывается
 * минутами, и частый опрос только жёг бы лимиты.
 */
async function waitReady(containerId, creds, { tries = 30, pauseMs = 10000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(
      `${API}/${containerId}?fields=status_code,status&access_token=${creds.pageToken}`
    );
    const data = await res.json();
    if (data.status_code === 'FINISHED') return;
    // Причина отказа лежит в `status`, а не в `status_code`: там текстом
    // написано, чего площадке не хватило — чаще всего она не смогла скачать
    // файл по нашему публичному адресу.
    if (data.status_code === 'ERROR') throw new Error(`Контейнер не собрался: ${data.status || 'без объяснения'}`);
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  throw new Error('Контейнер не дошёл до готовности за отведённое время');
}

export async function publish({ text, media = [], formatId = 'feed-portrait', publicUrl, creds }) {
  const user = creds.userId;
  if (!media.length) throw new Error('Instagram не публикует посты без медиа');

  const isStory = formatId === 'story';
  const isReel = formatId === 'reels';
  let containerId;

  if (media.length === 1) {
    const m = media[0];
    const params = { caption: isStory ? undefined : text };
    if (m.kind === 'video') {
      params.video_url = publicUrl(m);
      params.media_type = isStory ? 'STORIES' : 'REELS';
    } else {
      params.image_url = publicUrl(m);
      if (isStory) params.media_type = 'STORIES';
    }
    ({ id: containerId } = await call(`${user}/media`, clean(params), creds));
  } else {
    const children = [];
    for (const m of media.slice(0, 10)) {
      const child = await call(
        `${user}/media`,
        clean({
          is_carousel_item: 'true',
          [m.kind === 'video' ? 'video_url' : 'image_url']: publicUrl(m),
          media_type: m.kind === 'video' ? 'VIDEO' : undefined,
        }),
        creds
      );
      children.push(child.id);
    }
    ({ id: containerId } = await call(
      `${user}/media`,
      clean({ media_type: 'CAROUSEL', children: children.join(','), caption: text }),
      creds
    ));
  }

  const heavy = media.some((m) => m.kind === 'video') || isReel;
  await waitReady(containerId, creds, heavy ? {} : { tries: 15, pauseMs: 2000 });

  const published = await call(`${user}/media_publish`, { creation_id: containerId }, creds);
  return { externalId: published.id, url: null };
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}
