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
import { openSync, readSync, closeSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = process.env.UPLOAD_DIR || resolve(here, '../data/uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Что панель вообще берёт на хранение.
 *
 * Список закрытый, и это не формальность. Каталог загрузок раздаётся наружу
 * без входа — площадки забирают файлы сами, по ссылке. Пока расширение файла
 * бралось из имени, присланного клиентом, любой вошедший мог положить `.html`
 * или `.svg` и получить исполняемую страницу **на домене панели**: запрос
 * оттуда идёт со своего же сайта, то есть с cookie, и это уже не картинка,
 * а действия от чужого имени.
 *
 * Поэтому расширение теперь выводится из типа, а не из имени, и типов ровно
 * столько, сколько принимают сами сети.
 */
export const ALLOWED_MEDIA = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

export function isAllowedMedia(mime) {
  return Object.hasOwn(ALLOWED_MEDIA, String(mime).toLowerCase());
}

/**
 * Имя файла на диске. Неугадываемое — оно же и вся защита от подбора чужих
 * кадров, — и с расширением, выведенным из типа файла.
 */
export function storedName(mime) {
  const ext = ALLOWED_MEDIA[String(mime).toLowerCase()] || '.bin';
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}${ext}`;
}

/**
 * Удалить файл кадра с диска.
 *
 * Имя берём только из базы и сверяем с каталогом: путь, пришедший запросом,
 * до диска добираться не должен вовсе.
 */
export function removeStored(name) {
  if (!name) return false;
  const target = resolve(UPLOAD_DIR, name);
  if (dirname(target) !== resolve(UPLOAD_DIR)) return false;
  try {
    unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Файлы, на которые в базе уже никто не ссылается.
 *
 * Копятся они двумя путями: кадр сняли с поста, а файл остался, и загрузка
 * оборвалась на полпути. Диск здесь общий с шестнадцатью сайтами сети, и
 * забитый диск кладёт не панель, а всё сразу.
 *
 * Младше суток не трогаем: файл может быть частью прямо сейчас идущей
 * загрузки, для которой строка в базе ещё не создана.
 *
 * @param {Set<string>} keep — имена, живые по базе
 */
export function sweepOrphans(keep, { olderThanMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  let removed = 0;
  for (const name of readdirSync(UPLOAD_DIR)) {
    if (keep.has(name)) continue;
    try {
      if (now - statSync(join(UPLOAD_DIR, name)).mtimeMs < olderThanMs) continue;
    } catch {
      continue;
    }
    if (removeStored(name)) removed += 1;
  }
  return removed;
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
