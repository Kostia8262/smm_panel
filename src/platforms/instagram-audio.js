/**
 * Звук Instagram: поиск в библиотеке, проверка трека, прикрепление к Reels.
 *
 * Instagram Audio API появился у Meta 1 июня 2026 и работает только у
 * подключения «входом через Facebook» — у нас ровно оно. Проба 13.09.2026
 * (`tools/audio-probe.mjs`) показала то, чего нет в документации:
 *
 *   — токен страницы подходит, хотя в документации написан токен пользователя;
 *   — список приходит в поле `audio`, а не `data`;
 *   — у `music` (бесплатная Meta Sound Collection) есть `download_url` —
 *     файл для прослушки, живёт около полутора суток; у `original_sound`
 *     (чужие оригинальные звуки из Reels) файла нет, есть только ссылка на
 *     страницу звука в Instagram;
 *   — пропавший из библиотеки звук контейнер не принимает («Invalid
 *     parameter») — молча без звука Reels не выходит, но и причину площадка
 *     не называет. Отсюда проверка трека до публикации.
 *
 * Звук прикрепляется только к Reels: к фото, карусели и сторис API его не даёт.
 */

const API = 'https://graph.facebook.com/v21.0';

export const AUDIO_TYPES = ['music', 'original_sound'];

/** Ошибка Graph API с кодом: по нему «звука больше нет» отличается от сбоя сети. */
export class GraphError extends Error {
  constructor(message, { code = null, subcode = null, status = null } = {}) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.status = status;
  }
}

async function get(path, params, creds) {
  const qs = new URLSearchParams({ ...params, access_token: creds.pageToken });
  let res;
  try {
    res = await fetch(`${API}/${path}?${qs}`);
  } catch (err) {
    throw new GraphError(`Instagram не отвечает: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new GraphError(e.message || `ошибка ${res.status}`, {
      code: e.code ?? null,
      subcode: e.error_subcode ?? null,
      status: res.status,
    });
  }
  return data;
}

/**
 * «Такого объекта нет» у Graph API — код 100 с подкодом 33. Им же площадка
 * отвечает и на нехватку прав, но звук мы уже однажды нашли этим же токеном:
 * если токен жив, пропал именно звук.
 */
export function isGone(err) {
  return err instanceof GraphError && err.code === 100;
}

/** Адрес картинки или файла — только с CDN Meta: панель пускает к себе лишь его. */
function metaCdn(url) {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)fbcdn\.net$/.test(u.hostname) ? url : null;
  } catch {
    return null;
  }
}

function instagramLink(url) {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)instagram\.com$/.test(u.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** Ответ площадки → то, что нужно панели. Лишнего наружу не отдаём. */
export function normalizeAudio(raw = {}) {
  return {
    id: String(raw.audio_id ?? raw.id ?? ''),
    type: AUDIO_TYPES.includes(raw.audio_type) ? raw.audio_type : 'music',
    title: String(raw.title || '').slice(0, 200),
    artist: raw.display_artist ? String(raw.display_artist).slice(0, 100) : null,
    username: raw.ig_username ? String(raw.ig_username).slice(0, 100) : null,
    durationMs: Number.isFinite(Number(raw.duration_in_ms)) ? Math.round(Number(raw.duration_in_ms)) : null,
    cover: metaCdn(raw.cover_artwork_thumbnail_uri || raw.profile_picture_url),
    previewUrl: metaCdn(raw.download_url),
    pageUrl: instagramLink(raw.on_platform_audio_preview_link),
  };
}

/**
 * Поиск. Без запроса площадка отдаёт трендовые звуки выбранного типа —
 * это и есть витрина «в тренде».
 */
export async function searchAudio(creds, { type = 'music', q = '', after = '' } = {}) {
  if (!AUDIO_TYPES.includes(type)) throw new GraphError('Неизвестный тип звука');
  const params = { audio_type: type, user_id: creds.userId };
  if (q) params.search_query = String(q).slice(0, 100);
  if (after) params.after = String(after).slice(0, 200);
  const data = await get('ig_audio', params, creds);
  const rows = data.audio || data.data || [];
  return {
    items: rows.map(normalizeAudio).filter((a) => a.id),
    after: data.paging?.cursors?.after || null,
  };
}

/** Карточка одного звука — со свежей ссылкой на прослушку. */
export async function audioInfo(id, creds) {
  if (!/^\d{3,30}$/.test(String(id))) throw new GraphError('Неверный id звука', { code: 100 });
  const data = await get(String(id), { user_id: creds.userId }, creds);
  return normalizeAudio(data);
}

/**
 * Поля контейнера Reels под выбранный звук.
 *
 * `audio_configuration` — JSON-строкой в той же форме, что и остальные поля.
 * `audio_name` — название собственного звука ролика; менять его площадка
 * разрешает один раз, поэтому шлём только когда трека из библиотеки нет.
 */
export function reelAudioParams(audio) {
  if (!audio) return {};
  if (audio.id) {
    return {
      audio_configuration: JSON.stringify({
        audio_id: String(audio.id),
        audio_volume: volume(audio.audioVolume),
        video_volume: volume(audio.videoVolume),
      }),
    };
  }
  if (audio.ownName) return { audio_name: String(audio.ownName).slice(0, 100) };
  return {};
}

function volume(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100;
}

/**
 * Трек ещё в библиотеке? Проверяется прямо перед контейнером: пропавший звук
 * площадка отвергает безымянным «Invalid parameter», и человек не понял бы,
 * что чинить.
 */
export async function assertAudioAvailable(audio, creds) {
  if (!audio?.id) return;
  try {
    await audioInfo(audio.id, creds);
  } catch (err) {
    if (isGone(err)) {
      throw new Error(`Звук ${audioLabel(audio)} больше недоступен в Instagram — выберите другой`);
    }
    throw err;
  }
}

/** Что площадка сама говорит о звуке вышедшего поста: MUSIC, ORIGINAL_SOUND или ничего. */
export async function publishedAudioType(mediaId, creds) {
  try {
    const data = await get(String(mediaId), { fields: 'media_audio_type' }, creds);
    return data.media_audio_type || null;
  } catch {
    return undefined; // не узнали — это не то же самое, что «звука нет»
  }
}

export function audioLabel(audio) {
  if (!audio) return '';
  const who = audio.artist || (audio.username ? `@${audio.username}` : '');
  return `«${audio.title || audio.id}»${who ? ` — ${who}` : ''}`;
}
