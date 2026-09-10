/**
 * Работа с мастер-медиа: хранение и размеры кадра.
 *
 * Размеры читаются из заголовков файла вручную — JPEG, PNG и WebP.
 * Библиотеку сюда не тянем: sharp требует нативной сборки, а весь смысл
 * этого сервиса в том, что выкатка сводится к `git pull` без компиляции.
 *
 * Длительность видео без ffprobe не узнать — оставляем пустой и предупреждаем
 * в валидаторе. Появится вторая машина с ffmpeg — заполнится там.
 */

import { randomBytes } from 'node:crypto';
import { openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = process.env.UPLOAD_DIR || resolve(here, '../data/uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

export function storedName(originalName) {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}${extname(originalName).toLowerCase()}`;
}

export function kindOf(mime) {
  if (String(mime).startsWith('video/')) return 'video';
  if (String(mime).startsWith('image/')) return 'image';
  return 'other';
}

/** @returns {{width: number|null, height: number|null}} */
export function imageSize(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(65536);
    const read = readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);

    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return webpSize(buf);
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      return jpegSize(buf);
    }
    return { width: null, height: null };
  } catch {
    return { width: null, height: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0..SOF15, кроме маркеров без размеров кадра (DHT, JPG, DAC)
    const isSOF = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSOF) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: null, height: null };
}

function webpSize(buf) {
  const format = buf.toString('ascii', 12, 16);
  if (format === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (format === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') {
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return { width: null, height: null };
}

/**
 * Кроп мастер-кадра под раскладку с учётом точки фокуса.
 * Считается на стороне сервера, чтобы превью в браузере и будущая нарезка
 * ffmpeg исходили из одной формулы, а не расходились на пару процентов.
 */
export function cropFor({ width, height, focusX = 0.5, focusY = 0.5 }, format) {
  if (!width || !height) return null;
  const target = format.w / format.h;
  const source = width / height;

  let cropW = width;
  let cropH = height;
  if (source > target) cropW = Math.round(height * target);
  else cropH = Math.round(width / target);

  const x = clamp(Math.round(width * focusX - cropW / 2), 0, width - cropW);
  const y = clamp(Math.round(height * focusY - cropH / 2), 0, height - cropH);
  return { x, y, w: cropW, h: cropH, scale: format.w / cropW };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
