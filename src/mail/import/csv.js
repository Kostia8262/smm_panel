/**
 * CSV и таблица, вставленная из буфера.
 *
 * Разделитель не спрашиваем, а угадываем: Excel с запятой в дробях (русская и
 * украинская локаль) пишет `;`, Google Таблицы — `,`, скопированные ячейки
 * приходят через табуляцию. Верный разделитель — тот, при котором число колонок
 * устойчиво от строки к строке.
 */

export const DELIMITERS = {
  ';': 'точка с запятой',
  ',': 'запятая',
  '\t': 'табуляция',
  '|': 'вертикальная черта',
};

/**
 * Разбор по RFC 4180 с поблажками: кавычки, удвоенная кавычка внутри,
 * переносы строки внутри ячейки, любые окончания строк.
 *
 * @param {string} text
 * @param {string} delimiter
 * @param {{maxRows?: number}} opts
 * @returns {string[][]}
 */
export function parseCsv(text, delimiter, { maxRows = Infinity } = {}) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const n = text.length;

  const endRow = () => {
    row.push(cell);
    cell = '';
    // Пустые строки между записями — не записи.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    if (ch === '"' && cell.trim() === '') {
      // Кавычка открывает ячейку только в её начале: «Иван "Ваня" Петров» —
      // обычный текст, а не начало кавычек.
      quoted = true;
      cell = '';
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      if (rows.length >= maxRows) return rows;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

/**
 * Угадать разделитель по первым строкам.
 *
 * Счёт — сколько строк выборки имеют самое частое число колонок, при условии
 * что колонок больше одной. Ничья решается в пользу табуляции (её не бывает в
 * тексте случайно), затем `;` — в именах запятая встречается, точка с запятой нет.
 *
 * @returns {string|null} null — колонка одна
 */
export function sniffDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  let best = null;
  let bestScore = 0;
  for (const delimiter of ['\t', ';', ',', '|']) {
    const rows = parseCsv(sample, delimiter, { maxRows: 50 });
    if (rows.length === 0) continue;
    const counts = new Map();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) || 0) + 1);
    let modeWidth = 1;
    let modeCount = 0;
    for (const [width, count] of counts) {
      if (count > modeCount || (count === modeCount && width > modeWidth)) {
        modeWidth = width;
        modeCount = count;
      }
    }
    if (modeWidth < 2) continue;
    const score = modeCount / rows.length;
    if (score > bestScore + 0.001) {
      best = delimiter;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}
