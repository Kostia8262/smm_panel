/**
 * XLSX без зависимостей.
 *
 * Пакет `xlsx` в npm застыл на версии с известной уязвимостью (свежие версии
 * лежат только на сайте автора), `exceljs` тянет десятки пакетов ради одной
 * таблицы. А нужно нам немного: XLSX — это zip, внутри XML со строками и
 * листами. Читаем центральный каталог архива, распаковываем встроенным zlib и
 * вынимаем значения ячеек. Формулы, стили и даты как даты не нужны — нужны
 * адреса и имена.
 */

import { inflateRawSync } from 'node:zlib';
import { IMPORT_LIMITS } from '../specs.js';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Старый двоичный .xls (OLE-контейнер). Его не читаем — просим пересохранить. */
export function isLegacyXls(bytes) {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Map<string, {method: number, compressed: number, size: number, offset: number}>}
 */
function readCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minStart = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Файл повреждён: это не таблица Excel');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const names = new TextDecoder('utf-8');

  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error('Файл повреждён: оглавление таблицы не читается');
    }
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compressed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(bytes, entry, budget) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== SIG_LOCAL) throw new Error('Файл повреждён: часть таблицы не читается');
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.compressed);

  if (entry.size > budget.left) throw new Error('Таблица раскрывается в слишком большой объём — сохраните её как CSV');
  let out;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    // maxOutputLength — вторая защита: размер в оглавлении можно подделать.
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(budget.left, 1) });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error('Таблица раскрывается в слишком большой объём — сохраните её как CSV');
      }
      throw new Error('Файл повреждён: часть таблицы не распаковывается');
    }
  } else throw new Error('Таблица сжата неизвестным способом — сохраните её как CSV');
  budget.left -= out.length;
  return new TextDecoder('utf-8').decode(out);
}

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code) => {
    const c = code.toLowerCase();
    if (c === 'amp') return '&';
    if (c === 'lt') return '<';
    if (c === 'gt') return '>';
    if (c === 'quot') return '"';
    if (c === 'apos') return "'";
    const n = c.startsWith('#x') ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
  });
}

/** Текст узла строки: простой `<t>` или набор фрагментов `<r><t>` с разным оформлением. */
function textOf(xml) {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return unescapeXml(out);
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function resolveTarget(target) {
  const clean = target.replace(/^\/+/, '');
  return clean.startsWith('xl/') ? clean : `xl/${clean}`;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{sheets: string[], read: (index: number) => string[][]}}
 */
export function openXlsx(bytes) {
  const entries = readCentralDirectory(bytes);
  const budget = { left: IMPORT_LIMITS.maxUnpackedBytes };
  const get = (name) => (entries.has(name) ? readEntry(bytes, entries.get(name), budget) : null);

  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new Error('В архиве нет книги Excel — это точно .xlsx?');

  const rels = new Map();
  for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, resolveTarget(target));
  }

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] || `Лист ${sheets.length + 1}`);
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, path });
  }
  if (!sheets.length) throw new Error('В книге Excel нет листов');

  let shared = null;
  const sharedStrings = () => {
    if (shared) return shared;
    shared = [];
    for (const m of (get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
    return shared;
  };

  return {
    sheets: sheets.map((s) => s.name),
    read(index = 0) {
      const sheet = sheets[index] || sheets[0];
      const xml = get(sheet.path);
      if (!xml) throw new Error(`Лист «${sheet.name}» не читается`);
      const strings = sharedStrings();
      const rows = [];
      for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const body = rowMatch[1];
        if (!body) continue;
        const cells = [];
        for (const c of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const inner = c[2] || '';
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
          const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
          const idx = ref ? columnIndex(ref) : cells.length;
          let value = '';
          if (type === 'inlineStr') value = textOf(inner);
          else {
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
            if (v !== undefined) value = type === 's' ? strings[Number(v)] ?? '' : unescapeXml(v);
          }
          cells[idx] = value;
        }
        rows.push(Array.from(cells, (v) => v ?? ''));
        if (rows.length >= IMPORT_LIMITS.maxRows + 1) break;
      }
      return rows;
    },
  };
}
