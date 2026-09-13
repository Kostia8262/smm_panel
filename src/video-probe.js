/**
 * Паспорт ролика: длительность, размеры, кодеки, частота кадров.
 *
 * Без ffprobe и без нативных сборок — разбором контейнера MP4/MOV (ISO BMFF)
 * на чистом JS. ffmpeg на сервер не тащим: одно ядро VPS делят шестнадцать
 * сайтов сети. А всё, что нужно проверке перед публикацией, лежит в заголовке
 * контейнера — в коробке `moov`, — и перекодировать для этого ничего не надо.
 *
 * Зачем паспорт вообще: до 13.09.2026 сервер не знал о видео ничего, кроме
 * размера файла. Проверка длительности в валидаторе не срабатывала никогда, и
 * ролик на две минуты уходил в Reels Facebook (предел 90 с), чтобы площадка
 * отказала уже после постановки в очередь — молча для человека.
 *
 * Всё «по возможности»: не разобрали — поля пустые, загрузка не падает, а
 * валидатор честно говорит «длительность не прочитана».
 */

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

/** `moov` с таблицами длинного ролика — сотни килобайт; больше — не наш случай. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

const VIDEO_CODECS = {
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  vp09: 'vp9',
  av01: 'av1',
  mp4v: 'mpeg4',
  apch: 'prores',
  apcn: 'prores',
  apcs: 'prores',
  apco: 'prores',
  ap4h: 'prores',
  ap4x: 'prores',
};

const AUDIO_CODECS = {
  'ac-3': 'ac3',
  'ec-3': 'eac3',
  Opus: 'opus',
  alac: 'alac',
  lpcm: 'pcm',
  sowt: 'pcm',
  twos: 'pcm',
  ipcm: 'pcm',
  '.mp3': 'mp3',
};

/** Пустой паспорт — то, что возвращается, когда разобрать не вышло. */
const EMPTY = Object.freeze({
  duration: null,
  width: null,
  height: null,
  videoCodec: null,
  audioCodec: null,
  fps: null,
  rotation: 0,
});

/**
 * @param {string} path
 * @returns {{duration: number|null, width: number|null, height: number|null,
 *   videoCodec: string|null, audioCodec: string|null, fps: number|null, rotation: number}}
 */
export function probeVideo(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const moov = findTopBox(fd, size, 'moov');
    if (!moov) return { ...EMPTY };
    return parseMoov(moov);
  } catch {
    return { ...EMPTY };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Разбор уже прочитанной коробки `moov` — отдельно, чтобы проверять тестом без файла. */
export function parseMoov(buf) {
  const out = { ...EMPTY };
  let movieDuration = null;
  let videoTrack = null;
  let audioTrack = null;

  for (const box of children(buf, 0, buf.length)) {
    if (box.type === 'mvhd') movieDuration = readMvhd(buf, box.start);
    if (box.type === 'trak') {
      const track = readTrack(buf, box);
      if (track.handler === 'vide' && !videoTrack) videoTrack = track;
      if (track.handler === 'soun' && !audioTrack) audioTrack = track;
    }
  }

  // Длительность ролика — по заголовку фильма; у фрагментированного MP4 она
  // бывает нулевой, тогда берём дорожку видео.
  out.duration = round(movieDuration || videoTrack?.duration || null, 3);

  if (videoTrack) {
    out.videoCodec = videoTrack.codec;
    out.rotation = videoTrack.rotation;
    let w = videoTrack.width || videoTrack.codedWidth || null;
    let h = videoTrack.height || videoTrack.codedHeight || null;
    // Телефон пишет вертикальное видео горизонтальными кадрами с пометкой
    // «повернуть на 90°». Подписчик увидит повёрнутое — его и проверяем.
    if (videoTrack.rotation === 90 || videoTrack.rotation === 270) [w, h] = [h, w];
    out.width = w ? Math.round(w) : null;
    out.height = h ? Math.round(h) : null;
    if (videoTrack.samples && videoTrack.duration) out.fps = round(videoTrack.samples / videoTrack.duration, 2);
  }
  if (audioTrack) out.audioCodec = audioTrack.codec;
  return out;
}

/* ------------------------------ коробки ------------------------------ */

/** Верхний уровень файла: ищем коробку по имени, не читая всё подряд. */
function findTopBox(fd, fileSize, wanted) {
  const head = Buffer.alloc(16);
  let offset = 0;
  let first = true;
  while (offset + 8 <= fileSize) {
    readSync(fd, head, 0, 16, offset);
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    // Первая коробка у MP4 и MOV — ftyp, реже wide/free/mdat у старых MOV.
    // Мусор вместо заголовка — не контейнер, дальше не идём.
    if (first && !/^[\x20-\x7e]{4}$/.test(type)) return null;
    first = false;
    if (size < header) return null;
    if (type === wanted) {
      const length = size - header;
      if (length > MAX_MOOV_BYTES || offset + size > fileSize) return null;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, offset + header);
      return buf;
    }
    offset += size;
  }
  return null;
}

function* children(buf, from, to) {
  let offset = from;
  while (offset + 8 <= to) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return;
      size = Number(buf.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) return;
    yield { type, start: offset + header, end: offset + size };
    offset += size;
  }
}

function find(buf, box, path) {
  let current = box;
  for (const name of path) {
    let next = null;
    for (const child of children(buf, current.start, current.end)) {
      if (child.type === name) {
        next = child;
        break;
      }
    }
    if (!next) return null;
    current = next;
  }
  return current;
}

/** mvhd: длительность фильма в секундах. */
function readMvhd(buf, p) {
  const v1 = buf[p] === 1;
  const timescale = buf.readUInt32BE(p + (v1 ? 20 : 12));
  const duration = v1 ? Number(buf.readBigUInt64BE(p + 24)) : buf.readUInt32BE(p + 16);
  return timescale ? duration / timescale : null;
}

function readTrack(buf, trak) {
  const track = {
    handler: null,
    codec: null,
    width: null,
    height: null,
    codedWidth: null,
    codedHeight: null,
    rotation: 0,
    duration: null,
    samples: null,
  };

  const tkhd = find(buf, trak, ['tkhd']);
  if (tkhd) {
    const p = tkhd.start;
    const v1 = buf[p] === 1;
    const matrix = p + (v1 ? 52 : 40);
    const a = buf.readInt32BE(matrix);
    const b = buf.readInt32BE(matrix + 4);
    track.rotation = ((Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90) % 360 + 360) % 360;
    track.width = buf.readUInt32BE(matrix + 36) / 65536;
    track.height = buf.readUInt32BE(matrix + 40) / 65536;
  }

  const hdlr = find(buf, trak, ['mdia', 'hdlr']);
  if (hdlr) track.handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);

  const mdhd = find(buf, trak, ['mdia', 'mdhd']);
  if (mdhd) {
    const p = mdhd.start;
    const v1 = buf[p] === 1;
    const timescale = buf.readUInt32BE(p + (v1 ? 20 : 12));
    const duration = v1 ? Number(buf.readBigUInt64BE(p + 24)) : buf.readUInt32BE(p + 16);
    track.duration = timescale ? duration / timescale : null;
  }

  const stsd = find(buf, trak, ['mdia', 'minf', 'stbl', 'stsd']);
  if (stsd && buf.readUInt32BE(stsd.start + 4) > 0) {
    const entry = stsd.start + 8;
    const entrySize = buf.readUInt32BE(entry);
    const fourcc = buf.toString('latin1', entry + 4, entry + 8);
    if (track.handler === 'vide') {
      track.codec = VIDEO_CODECS[fourcc] || fourcc.trim();
      if (entry + 36 <= stsd.end) {
        track.codedWidth = buf.readUInt16BE(entry + 32);
        track.codedHeight = buf.readUInt16BE(entry + 34);
      }
    } else if (track.handler === 'soun') {
      track.codec = fourcc === 'mp4a' ? mp4aCodec(buf, entry, Math.min(entry + entrySize, stsd.end)) : AUDIO_CODECS[fourcc] || fourcc.trim();
    }
  }

  const stts = find(buf, trak, ['mdia', 'minf', 'stbl', 'stts']);
  if (stts) {
    const count = buf.readUInt32BE(stts.start + 4);
    let samples = 0;
    for (let i = 0; i < count; i++) {
      const at = stts.start + 8 + i * 8;
      if (at + 8 > stts.end) break;
      samples += buf.readUInt32BE(at);
    }
    track.samples = samples || null;
  }

  return track;
}

/**
 * `mp4a` — это обёртка: внутри бывает и AAC, и MP3. Какой именно, сказано в
 * `esds`, в поле objectTypeIndication. Не разобрали — честно `mp4a`.
 */
function mp4aCodec(buf, from, to) {
  const at = buf.indexOf('esds', from, 'latin1');
  if (at < 0 || at >= to) return 'mp4a';
  let p = at + 8; // имя коробки + версия и флаги
  const readDescriptor = () => {
    const tag = buf[p++];
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const byte = buf[p++];
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return { tag, length };
  };
  try {
    let d = readDescriptor();
    if (d.tag === 0x03) {
      const flags = buf[p + 2];
      p += 3; // ES_ID и флаги
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 2;
      if (flags & 0x20) p += 2;
      d = readDescriptor();
    }
    if (d.tag !== 0x04 || p >= to) return 'mp4a';
    const object = buf[p];
    if ([0x40, 0x66, 0x67, 0x68].includes(object)) return 'aac';
    if ([0x69, 0x6b].includes(object)) return 'mp3';
    return 'mp4a';
  } catch {
    return 'mp4a';
  }
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}
