/**
 * Поиск наших ссылок в тексте — без базы.
 *
 * Отдельно от links.js, потому что нужен двоим: отправке (там ссылка
 * подменяется короткой и заводится строка в базе) и проверке поста (там надо
 * лишь знать, какой длины текст станет). До 13.09.2026 проверка считала текст
 * до подмены, а короткая ссылка обычно длиннее исходной — пост, прошедший
 * проверку, упирался в лимит площадки уже при отправке.
 */

export const URL_RE = /https?:\/\/[^\s<>"')]+/g;

/** Длина кода короткой ссылки: randomBytes(5) в base64url. */
export const CODE_LENGTH = 7;

/**
 * Заменить наши ссылки тем, что вернёт `replace(cleanUrl)`. Чужие не трогаем;
 * `null` от replace — оставить ссылку как есть.
 */
export function replaceOwnLinks(text, ownDomains, replace) {
  if (!text) return text;
  return text.replace(URL_RE, (match) => {
    // Хвостовая пунктуация в текст не входит: «…сайт: https://x.ua.» — точка
    // принадлежит предложению, а не адресу.
    const trailing = match.match(/[.,;:!?)]+$/)?.[0] || '';
    const clean = trailing ? match.slice(0, -trailing.length) : match;

    let host;
    try {
      host = new URL(clean).hostname.replace(/^www\./, '');
    } catch {
      return match;
    }
    if (!ownDomains.some((d) => host === d || host.endsWith(`.${d}`))) return match;

    const out = replace(clean);
    return out ? `${out}${trailing}` : match;
  });
}

/** Текст таким, каким он уйдёт после подмены ссылок, — для подсчёта длины. */
export function withShortLinks(text, { baseUrl, ownDomains }) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  return replaceOwnLinks(text, ownDomains || [], () => `${base}/r/${'x'.repeat(CODE_LENGTH)}`);
}

/** Список наших доменов из настройки «через запятую». */
export function parseOwnDomains(raw) {
  return String(raw || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
}
