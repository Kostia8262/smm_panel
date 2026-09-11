/**
 * Разбор строки настройки из панели.
 *
 * Вид: `smm1.<base64url от JSON>`. Одна строка вместо трёх полей —
 * переносить руками адрес, номер проекта и ключ значит трижды дать
 * ошибиться, а ошибка тихая: расширение молча ничего не отправляет.
 *
 * Разбор отдельным модулем, потому что это единственная часть popup,
 * которую можно проверить тестом без браузера.
 */

/**
 * @param {string} raw строка из панели
 * @returns {{panelUrl: string, projectId: number, ingestKey: string}|null}
 */
export function decodeSetup(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('smm1.')) return null;

  let json;
  try {
    const payload = text.slice('smm1.'.length);
    json = JSON.parse(base64urlDecode(payload));
  } catch {
    return null;
  }

  const panelUrl = String(json?.panelUrl || '').trim().replace(/\/$/, '');
  const ingestKey = String(json?.ingestKey || '').trim();
  const projectId = Number(json?.projectId) || null;

  // Полупустая настройка хуже отсутствующей: расширение будет считать себя
  // настроенным и молчать.
  if (!/^https?:\/\//.test(panelUrl) || !ingestKey || !projectId) return null;

  return { panelUrl, projectId, ingestKey };
}

function base64urlDecode(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Обратная сборка — нужна тестам и отладке. */
export function encodeSetup({ panelUrl, projectId, ingestKey }) {
  const json = JSON.stringify({ panelUrl, projectId, ingestKey });
  const bytes = new TextEncoder().encode(json);
  const binary = String.fromCharCode(...bytes);
  return `smm1.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
