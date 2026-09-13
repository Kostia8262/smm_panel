/**
 * Письмо в формате RFC 5322 — без зависимостей.
 *
 * Gmail API принимает письмо целиком, строкой (`raw`), и всё, что в нём не так,
 * видит получатель: тема «=?UTF-8?B?…» вместо текста, кракозябры вместо
 * кириллицы, строка длиннее 998 знаков, которую почтовый сервер режет посреди
 * слова. Поэтому кодирование здесь строгое и проверено тестами.
 *
 * Главная защита — от подстановки заголовков: имя, тема или адрес с переводом
 * строки внутри позволили бы дописать в письмо свои заголовки (скрытую копию,
 * другой адрес ответа). Любой CR и LF из значения заголовка вырезается.
 */

import { randomBytes } from 'node:crypto';

const CRLF = '\r\n';

/** Перевод строки внутри значения заголовка — это новый заголовок. Не пускаем. */
export function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function isPlainAscii(text) {
  return /^[\x20-\x7e]*$/.test(text);
}

/**
 * Значение заголовка с не-ASCII: encoded-word UTF-8, кусками не длиннее 75
 * знаков (RFC 2047). Многобайтовая буква не разрезается между кусками —
 * иначе на стыке получится «�».
 */
export function encodeWord(value) {
  const text = headerSafe(value);
  if (isPlainAscii(text)) return text;
  const words = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > 45 && chunk) {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += size;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

/** `Имя <адрес>` с проверкой адреса: в нём не бывает пробелов, скобок и переводов строки. */
export function formatAddress({ name = '', email }) {
  const address = headerSafe(email);
  if (!/^[^\s<>@",;]+@[^\s<>@",;]+$/.test(address)) throw new Error(`Некорректный адрес для письма: ${address}`);
  const cleanName = headerSafe(name);
  if (!cleanName) return address;
  if (isPlainAscii(cleanName)) {
    const quoted = /[()<>@,;:\\".[\]]/.test(cleanName) ? `"${cleanName.replace(/(["\\])/g, '\\$1')}"` : cleanName;
    return `${quoted} <${address}>`;
  }
  return `${encodeWord(cleanName)} <${address}>`;
}

/**
 * Quoted-printable (RFC 2045): строки до 76 знаков с мягким переносом «=»,
 * переводы строк — CRLF, пробел в конце строки кодируется (иначе серверы его
 * срезают и склеивают слова).
 */
export function quotedPrintable(text) {
  const lines = String(text ?? '').replace(/\r\n|\r|\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf8');
    let encoded = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const printable = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      encoded += printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    // Мягкие переносы: не рвать последовательность «=XX».
    let rest = encoded;
    while (rest.length > 76) {
      let cut = 75;
      const tail = rest.slice(cut - 2, cut);
      if (tail[0] === '=') cut -= 2;
      else if (tail[1] === '=') cut -= 1;
      out.push(`${rest.slice(0, cut)}=`);
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return out.join(CRLF);
}

function base64Lines(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/.{1,76}/g, (m) => `${m}${CRLF}`).trimEnd();
}

function boundary() {
  return `mc_${randomBytes(12).toString('hex')}`;
}

function textPart(type, body) {
  return [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(body)].join(CRLF);
}

function multipart(type, parts) {
  const b = boundary();
  const body = parts.map((p) => `--${b}${CRLF}${p}`).join(CRLF) + `${CRLF}--${b}--`;
  return `Content-Type: ${type}; boundary="${b}"${CRLF}${CRLF}${body}`;
}

function inlinePart({ cid, mime, content, filename = 'image' }) {
  const safeCid = headerSafe(cid).replace(/[<>]/g, '');
  return [
    `Content-Type: ${headerSafe(mime)}; name="${headerSafe(filename).replace(/"/g, '')}"`,
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${safeCid}>`,
    `Content-Disposition: inline; filename="${headerSafe(filename).replace(/"/g, '')}"`,
    '',
    base64Lines(content),
  ].join(CRLF);
}

/**
 * @param {{from: {name?: string, email: string}, to: {name?: string, email: string}, subject: string,
 *   text: string, html?: string, replyTo?: string, headers?: Record<string, string>,
 *   inline?: {cid: string, mime: string, content: Buffer, filename?: string}[], date?: Date}} message
 * @returns {string} письмо целиком, строки через CRLF
 */
export function buildMessage({ from, to, subject, text, html = '', replyTo = '', headers = {}, inline = [], date = new Date() }) {
  const head = [
    `From: ${formatAddress(from)}`,
    `To: ${formatAddress(to)}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  if (replyTo) head.push(`Reply-To: ${formatAddress({ email: replyTo })}`);
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`Недопустимое имя заголовка: ${name}`);
    head.push(`${name}: ${headerSafe(value)}`);
  }

  let body;
  if (!html) {
    body = textPart('text/plain', text);
  } else {
    const htmlPart = textPart('text/html', html);
    const rich = inline.length ? multipart('multipart/related', [htmlPart, ...inline.map(inlinePart)]) : htmlPart;
    body = multipart('multipart/alternative', [textPart('text/plain', text), rich]);
  }
  return `${head.join(CRLF)}${CRLF}${body}${CRLF}`;
}

/** Для поля `raw` Gmail API. */
export function toBase64Url(message) {
  return Buffer.from(message, 'utf8').toString('base64url');
}
