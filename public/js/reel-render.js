/**
 * Reels из фото — ролик собирает браузер.
 *
 * Прикрепить музыку к фотопосту или карусели Instagram через API не даёт
 * никак: звук из библиотеки ложится только на Reels. Значит, чтобы у поста с
 * фотографиями был звук, из фотографий нужно сделать ролик.
 *
 * Почему в браузере, а не на сервере: у VPS одно ядро на шестнадцать сайтов
 * сети, и ffmpeg на нём положил бы их все. Браузер кодирует через WebCodecs —
 * чаще всего видеокартой — за секунды и никого не задевает. Тот же подход,
 * что у миниатюр (thumbs.js).
 *
 * Ролик немой намеренно: звук накладывает сам Instagram из своей библиотеки
 * (audio_configuration). Проба 13.09.2026: ролик вовсе без аудиодорожки
 * площадка приняла и выпустила с треком (`media_audio_type: MUSIC`), так что
 * дорожка тишины не нужна.
 *
 * Требования Reels, под которые собрано: H.264, 1080×1920, 30 кадров, ключевой
 * кадр раз в две секунды, `moov` в начале файла (fast start), 3 с — 15 мин.
 */

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.js';

const W = 1080;
const H = 1920;
const FPS = 30;
const FADE_SEC = 0.45;
const ZOOM = 0.07; // насколько кадр приближается за показ: движение без укачивания

// High → Main → Baseline, уровень 4.0: 1080×1920 при 30 кадрах в него влезает
// (8100 макроблоков на кадр при пределе 8192).
const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];

export const SECONDS_PER_SLIDE = { min: 2, max: 8, default: 3 };

/** Умеет ли этот браузер собрать ролик. Проверка честная — через сам кодек. */
export async function reelSupport() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return { ok: false, why: 'Браузер не умеет кодировать видео (нужен свежий Chrome, Edge или Safari)' };
  }
  for (const codec of CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported(encoderConfig(codec));
      if (supported) return { ok: true, codec };
    } catch {
      // следующий профиль
    }
  }
  return { ok: false, why: 'Браузер не кодирует H.264 в 1080×1920' };
}

function encoderConfig(codec) {
  return {
    codec,
    width: W,
    height: H,
    bitrate: 8_000_000,
    framerate: FPS,
    latencyMode: 'quality',
    avc: { format: 'avc' },
  };
}

/** Длительность ролика: Instagram не принимает Reels короче трёх секунд. */
export function reelDuration(slides, secondsPerSlide) {
  const sps = clampSeconds(secondsPerSlide);
  return Math.max(3, slides * sps);
}

function clampSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return SECONDS_PER_SLIDE.default;
  return Math.min(SECONDS_PER_SLIDE.max, Math.max(SECONDS_PER_SLIDE.min, n));
}

/**
 * @param {object} opts
 * @param {Array<{url: string, focusX?: number, focusY?: number}>} opts.slides
 * @param {number} [opts.secondsPerSlide]
 * @param {(share: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{blob: Blob, seconds: number, codec: string}>}
 */
export async function renderReel({ slides, secondsPerSlide, onProgress, signal }) {
  if (!slides?.length) throw new Error('Нет кадров для ролика');
  const support = await reelSupport();
  if (!support.ok) throw new Error(support.why);

  const bitmaps = [];
  try {
    for (const s of slides) bitmaps.push(await loadBitmap(s.url, signal));

    const sps = slides.length === 1 ? Math.max(3, clampSeconds(secondsPerSlide)) : clampSeconds(secondsPerSlide);
    const seconds = reelDuration(slides.length, sps);
    const totalFrames = Math.round(seconds * FPS);

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H, frameRate: FPS },
      fastStart: 'in-memory',
    });

    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => {
        failure = err;
      },
    });
    encoder.configure(encoderConfig(support.codec));

    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('Сборка ролика отменена', 'AbortError');
      if (failure) throw failure;

      drawFrame(ctx, bitmaps, slides, i / FPS, sps);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();

      // Не копить сотни несжатых кадров в памяти: 1080×1920 — 8 МБ каждый.
      if (encoder.encodeQueueSize > 8) {
        await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
      }
      if (i % 10 === 0) onProgress?.(i / totalFrames);
    }

    await encoder.flush();
    encoder.close();
    if (failure) throw failure;

    muxer.finalize();
    onProgress?.(1);
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), seconds, codec: support.codec };
  } finally {
    for (const b of bitmaps) b.close?.();
  }
}

async function loadBitmap(url, signal) {
  const res = await fetch(url, { signal, cache: 'force-cache' });
  if (!res.ok) throw new Error(`Кадр не загрузился (${res.status})`);
  const blob = await res.blob();
  // Поворот по EXIF: телефонный кадр иначе ляжет боком.
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

/**
 * Кадр в момент `t`. Фото кадрируется «по заполнению» вокруг точки фокуса,
 * которую СММщик уже выставил в композере, и медленно приближается; последние
 * доли секунды показа поверх проступает следующее фото.
 */
function drawFrame(ctx, bitmaps, slides, t, sps) {
  const n = bitmaps.length;
  const index = Math.min(n - 1, Math.floor(t / sps));
  const local = t - index * sps;
  // Одиночное фото показывается весь ролик, а не sps секунд.
  const span = n === 1 ? Math.max(sps, t + 1 / FPS) : sps;

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawCover(ctx, bitmaps[index], slides[index], 1 + ZOOM * ease(Math.min(1, local / span)));

  const fadeStart = sps - FADE_SEC;
  if (index + 1 < n && local > fadeStart) {
    ctx.globalAlpha = ease((local - fadeStart) / FADE_SEC);
    drawCover(ctx, bitmaps[index + 1], slides[index + 1], 1);
    ctx.globalAlpha = 1;
  }
}

function drawCover(ctx, bitmap, slide, zoom) {
  const scale = Math.max(W / bitmap.width, H / bitmap.height) * zoom;
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  const fx = Number.isFinite(slide.focusX) ? slide.focusX : 0.5;
  const fy = Number.isFinite(slide.focusY) ? slide.focusY : 0.5;
  // Точка фокуса стремится в центр кадра, но край фото не отходит от края ролика.
  const x = Math.min(0, Math.max(W - dw, W / 2 - fx * dw));
  const y = Math.min(0, Math.max(H - dh, H / 2 - fy * dh));
  ctx.drawImage(bitmap, x, y, dw, dh);
}

function ease(p) {
  return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
}
