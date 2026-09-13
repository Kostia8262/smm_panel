/**
 * Адреса из текста без структуры: письмо, переписка, список через запятую,
 * выгрузка чата. Имя берётся из привычного вида `Имя Фамилия <адрес>`.
 */

/**
 * Кандидат в адрес. Буквы любого алфавита — намеренно: адрес с русской «а»
 * вместо латинской (`gmаil.com`) должен попасть в предпросмотр с подсказкой,
 * а не молча потеряться, потому что регулярка знала только латиницу.
 */
const EMAIL_SOURCE = String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}`;

// Без флага g: у глобальной регулярки `test()` сдвигает lastIndex, а
// `matchAll` этот lastIndex копирует — и поиск в следующей, более короткой
// ячейке начинался с её середины. Адрес «пропадал» из файла в зависимости от
// того, какую ячейку проверяли перед ним.
const HAS_EMAIL = new RegExp(EMAIL_SOURCE, 'u');

// Имя — от начала строки или после «,», «;», «:» до угловой скобки:
// «Кому: Ірина Коваль <ira@…>» даёт «Ірина Коваль», а не «Кому: Ірина Коваль».
const NAMED = /(?:^|[\n,;:])\s*"?([^"<>\n,;:@]{1,80}?)"?\s*<\s*([^<>\s]+@[^<>\s]+)\s*>/gu;

/** «Имя <адрес>» в ячейке или строке — признак текста, а не таблицы. */
export const NAMED_ADDRESS = /<\s*[^<>\s]+@[^<>\s]+\s*>/u;

export function hasEmail(value) {
  return HAS_EMAIL.test(String(value || ''));
}

export function emailsIn(value) {
  return [...String(value || '').matchAll(new RegExp(EMAIL_SOURCE, 'gu'))].map((m) => m[0]);
}

/**
 * @param {string} text
 * @returns {{header: string[], rows: string[][]}}
 */
export function extractFromText(text) {
  const names = new Map();
  for (const m of text.matchAll(NAMED)) {
    const name = m[1].trim();
    if (name) names.set(m[2].toLowerCase(), name);
  }

  const rows = [];
  for (const email of emailsIn(text)) {
    rows.push([names.get(email.toLowerCase()) || '', email]);
  }
  return { header: ['Имя', 'Email'], rows };
}
