/**
 * Картинки писем (docs/рассылка.md, §9.3).
 *
 * Свой каталог `data/mail-media`, без публичной раздачи: получателю картинка
 * приходит внутри письма (`Content-ID`), редактору — маршрутом только для
 * вошедших. Живёт, пока нужна незавершённой рассылке; снятие файлов после
 * рассылки — в фазе 4, в воркере.
 *
 * Только JPEG и PNG: WebP и SVG половина почтовых программ не показывает
 * (Outlook, старые Apple Mail, Gmail — SVG), а письмо с дырой вместо главной
 * картинки хуже письма без неё.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, log } from '../../db.js';
import { imageSize } from '../../media.js';
import { quotaCheck } from '../../retention.js';
import { MailError } from '../store.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MAIL_MEDIA_DIR = process.env.MAIL_MEDIA_DIR || resolve(here, '../../../data/mail-media');

export const MAIL_IMAGE_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxWidth: 2400,
  // Больше — уже не про качество, а про вес каждой копии в «Отправленных».
  warnBytes: 400 * 1024,
};

const TYPES = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.toString('ascii', 1, 4) === 'PNG' },
};

function typeOf(buffer) {
  return Object.values(TYPES).find((t) => t.test(buffer)) || null;
}

/** Сколько занимают картинки писем, ещё лежащие на диске: для общей квоты. */
export function mailMediaBytes() {
  return db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM mail_media WHERE purged_at IS NULL').get().n;
}

/**
 * Принять картинку. Тип — по содержимому, а не по имени и заголовку формы.
 * @returns {object} строка mail_media
 */
export function saveImage(campaignId, { buffer, originalName = '' }) {
  if (!buffer?.length) throw new MailError('Файл пустой');
  if (buffer.length > MAIL_IMAGE_LIMITS.maxBytes) throw new MailError('Картинка больше 2 МБ — для письма это слишком тяжело');
  const type = typeOf(buffer);
  if (!type) throw new MailError('Для письма нужна картинка JPEG или PNG: WebP и SVG многие почтовые программы не показывают');

  const quota = quotaCheck(buffer.length + mailMediaBytes());
  if (!quota.ok) throw new MailError('На сервере кончилось место под файлы — освободите его, прежде чем загружать картинки', 507);

  mkdirSync(MAIL_MEDIA_DIR, { recursive: true });
  const stored = `${randomBytes(12).toString('hex')}.${type.ext}`;
  const path = resolve(MAIL_MEDIA_DIR, stored);
  writeFileSync(path, buffer);
  const { width, height } = imageSize(path);
  if (!width || !height) {
    unlinkSync(path);
    throw new MailError('Картинка не читается — сохраните её заново как JPEG или PNG');
  }
  if (width > MAIL_IMAGE_LIMITS.maxWidth) {
    unlinkSync(path);
    throw new MailError(`Картинка шире ${MAIL_IMAGE_LIMITS.maxWidth} px — панель сама уменьшает её при загрузке, обновите страницу`);
  }
  const info = db
    .prepare('INSERT INTO mail_media (campaign_id, stored_name, original_name, mime, bytes, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Number(campaignId), stored, String(originalName).slice(0, 200), type.mime, buffer.length, width, height);
  return getMedia(info.lastInsertRowid);
}

export function getMedia(id) {
  return db.prepare('SELECT * FROM mail_media WHERE id = ?').get(Number(id)) || null;
}

/** Картинки письма по номеру — для сборки: блок ссылается на `mediaId`. */
export function mediaMap(campaignId) {
  const map = new Map();
  for (const row of db.prepare('SELECT * FROM mail_media WHERE campaign_id = ?').all(Number(campaignId))) map.set(row.id, row);
  return map;
}

export function readMedia(row) {
  if (!row || row.purged_at) return null;
  const path = resolve(MAIL_MEDIA_DIR, basename(row.stored_name));
  return existsSync(path) ? readFileSync(path) : null;
}

/** Путь к файлу для раздачи редактору. Имя — только из базы, без путей из запроса. */
export function mediaPath(storedName) {
  const row = db.prepare('SELECT * FROM mail_media WHERE stored_name = ? AND purged_at IS NULL').get(basename(String(storedName)));
  if (!row) return null;
  const path = resolve(MAIL_MEDIA_DIR, row.stored_name);
  return existsSync(path) ? { path, row } : null;
}

/** Копия письма ссылается на те же файлы — строки копируются, файлы нет. */
export function copyMedia(fromCampaignId, toCampaignId) {
  const ids = new Map();
  for (const row of db.prepare('SELECT * FROM mail_media WHERE campaign_id = ? AND purged_at IS NULL').all(Number(fromCampaignId))) {
    const info = db
      .prepare('INSERT INTO mail_media (campaign_id, stored_name, original_name, mime, bytes, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Number(toCampaignId), row.stored_name, row.original_name, row.mime, row.bytes, row.width, row.height);
    ids.set(row.id, Number(info.lastInsertRowid));
  }
  return ids;
}

export function logRemovedImage(campaignId, row) {
  log('info', `рассылка: из письма #${campaignId} убрана картинка «${row.original_name || row.stored_name}»`);
}
