/**
 * Как длинный текст делится на сообщения Telegram — без зависимостей.
 *
 * Общий для сервера и браузера (отдаётся как /js/shared/text-split.js): по нему
 * режет адаптер при отправке и рисует превью композер. Разойдись они — превью
 * показало бы одно деление, а в канал ушло бы другое.
 */

export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

/**
 * Разрезать текст на части не длиннее лимита.
 *
 * Режем по абзацу, строке, концу предложения или пробелу — не посреди слова и
 * не посреди ссылки: разрезанная короткая ссылка в канале просто не открывается.
 * До 13.09.2026 резали ровно по 1024-му символу. Место разреза ищем не дальше
 * середины части: иначе одно длинное предложение даст крошечный первый кусок.
 */
export function splitText(text, firstLimit, restLimit = TEXT_LIMIT) {
  const parts = [];
  let rest = String(text ?? '');
  let limit = firstLimit;
  while (rest.length > limit) {
    const cut = cutPoint(rest, limit);
    const head = rest.slice(0, cut).trimEnd();
    if (head) parts.push(head);
    rest = rest.slice(cut).trimStart();
    limit = restLimit;
  }
  if (rest) parts.push(rest);
  return parts;
}

function cutPoint(text, limit) {
  // Символ сразу за пределом тоже смотрим: пробел там — законное место разреза.
  const window = text.slice(0, limit + 1);
  const floor = Math.floor(limit / 2);
  const rules = [
    { re: /\n[ \t]*\n/g, after: false },
    { re: /\n/g, after: false },
    { re: /[.!?…](?=\s)/g, after: true },
    { re: /\s/g, after: false },
  ];
  for (const { re, after } of rules) {
    let best = -1;
    for (const m of window.matchAll(re)) {
      const at = after ? m.index + m[0].length : m.index;
      if (at >= floor && at <= limit) best = at;
    }
    if (best > 0) return best;
  }
  // Сплошной текст без пробелов — режем по лимиту, но не пополам эмодзи.
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}
