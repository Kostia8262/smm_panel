/**
 * Шифрование токенов площадок.
 *
 * Токены переезжают из `.env` в базу: владелец вписывает их в карточке
 * проекта, без похода на сервер. Но база — это файл, который попадает в
 * бэкапы и копируется на ноутбук «посмотреть», а каждый такой токен даёт
 * право публиковать от имени школы. Поэтому в базе лежит шифротекст.
 *
 * Ключ — отдельным файлом рядом с базой (`data/secret.key`, права 600,
 * в git не попадает). Разделение простое и честное: утёкшая база без файла
 * ключа бесполезна. От того, кто получил доступ к самому серверу, это не
 * спасает — и не должно: там он и так может всё.
 *
 * AES-256-GCM: шифрует и одновременно заверяет — подменённый шифротекст
 * не расшифруется молча, а честно упадёт.
 */

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = process.env.SECRET_KEY_PATH || resolve(here, '../data/secret.key');

let key = null;

function loadKey() {
  if (key) return key;
  mkdirSync(dirname(KEY_PATH), { recursive: true });

  if (existsSync(KEY_PATH)) {
    const raw = readFileSync(KEY_PATH, 'utf8').trim();
    key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(`Файл ключа ${KEY_PATH} повреждён: ожидалось 32 байта в base64`);
    }
    return key;
  }

  key = randomBytes(32);
  writeFileSync(KEY_PATH, `${key.toString('base64')}\n`, { mode: 0o600 });
  try {
    chmodSync(KEY_PATH, 0o600);
  } catch {
    // На Windows прав в юникс-смысле нет — не повод падать при разработке.
  }
  console.log(`[secrets] создан ключ шифрования: ${KEY_PATH} — не терять и не коммитить`);
  return key;
}

/** @returns {string} «v1:<iv>:<tag>:<данные>», всё в base64url */
export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(':');
}

export function decrypt(payload) {
  if (!payload) return '';
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('Непонятный формат шифротекста');
  }
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** Объект целиком: значения шифруются, имена полей остаются читаемыми. */
export function encryptFields(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v ? encrypt(v) : '';
  return out;
}

export function decryptFields(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!v) {
      out[k] = '';
      continue;
    }
    try {
      out[k] = decrypt(v);
    } catch {
      // Ключ сменили или запись из другой установки — поле мёртвое.
      // Рушить всю карточку проекта из-за одного поля нельзя.
      out[k] = '';
    }
  }
  return out;
}

/** Хвост для показа в интерфейсе: «…a41f» вместо самого секрета. */
export function tail(value, keep = 4) {
  const s = String(value || '');
  return s ? `…${s.slice(-keep)}` : '';
}

/**
 * Отдельный ключ под отдельную задачу, выведенный из ключа панели (HKDF).
 *
 * Ссылка отписки в письме подписывается HMAC, а не шифруется: её прочтёт
 * почтовый сканер, и в ней нечего прятать, но подделать нельзя. Подписывать
 * самим ключом шифрования токенов значило бы использовать один ключ для двух
 * разных целей — утечка подписей в тысячах писем не должна давать ни шага к
 * ключу, которым зашифрованы доступы площадок.
 *
 * @param {string} label — назначение ключа, например 'mail-unsubscribe'
 * @returns {Buffer} 32 байта
 */
export function deriveKey(label) {
  return Buffer.from(hkdfSync('sha256', loadKey(), Buffer.from('smm-panel'), Buffer.from(String(label)), 32));
}
