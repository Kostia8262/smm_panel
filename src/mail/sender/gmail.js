/**
 * Транспорт Gmail: единственное место, которое знает, как Google принимает
 * письма и как отказывает (docs/рассылка.md, §8.5–8.6).
 *
 * Главное здесь — отличать «не ушло» от «неизвестно». Ответ с кодом ошибки
 * значит, что письмо не отправлено, и его можно вернуть в очередь. Отсутствие
 * ответа (таймаут, обрыв после отправки тела) значит «не знаем» — и такое
 * письмо сама очередь не повторяет: дубль письма хуже пропажи.
 */

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export class GmailError extends Error {
  /**
   * @param {string} message
   * @param {{kind: 'auth'|'rate'|'daily'|'recipient'|'rejected'|'config'|'temporary'|'unknown', retryAt?: string|null, status?: number}} info
   */
  constructor(message, { kind, retryAt = null, status = 0 }) {
    super(message);
    this.kind = kind;
    this.retryAt = retryAt;
    this.status = status;
    /** Ушло ли письмо: `false` — точно нет, `null` — неизвестно. */
    this.sent = kind === 'unknown' ? null : false;
  }
}

/** Ответ Google с ошибкой → вид беды. Экспортируется ради тестов. */
export function classify(status, body = {}) {
  const error = body?.error || {};
  const reason = error.errors?.[0]?.reason || error.status || '';
  const message = String(error.message || '');
  const retryMatch = /Retry after (\S+)/i.exec(message);
  const retryAt = retryMatch ? retryMatch[1] : null;

  if (status === 401) return new GmailError('Доступ к ящику истёк или отозван', { kind: 'auth', status });
  if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(`${reason} ${message}`)) {
    return new GmailError('В проекте Google Cloud не включён Gmail API (APIs & Services → Library → Gmail API → Enable)', {
      kind: 'config',
      status,
    });
  }
  if (/dailyLimitExceeded|Daily .*limit|sending limit/i.test(`${reason} ${message}`)) {
    return new GmailError('Google: исчерпан суточный лимит отправки ящика', { kind: 'daily', retryAt, status });
  }
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reason)) {
    return new GmailError('Google просит отправлять медленнее', { kind: 'rate', retryAt, status });
  }
  if (status === 400 && /invalid.*(to|recipient|address|header)/i.test(message)) {
    return new GmailError(`Google не принял адрес получателя: ${message}`, { kind: 'recipient', status });
  }
  if (status === 403) {
    return new GmailError(`Google отказал в отправке: ${message || reason || status}`, { kind: 'rejected', status });
  }
  if (status >= 500) return new GmailError(`Google временно не отвечает (${status})`, { kind: 'temporary', status });
  return new GmailError(`Google не принял письмо (${status}): ${message || reason}`, { kind: 'rejected', status });
}

/**
 * @param {{accessToken: string, raw: string, fetchImpl?: Function, timeoutMs?: number}} opts — raw уже в base64url
 * @returns {Promise<{id: string, threadId: string}>}
 */
export async function sendRaw({ accessToken, raw, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  let res;
  try {
    res = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Запрос ушёл, ответа нет: Google мог и принять письмо.
    throw new GmailError(`Нет ответа от Google: ${err.message}`, { kind: 'unknown' });
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    if (res.ok) throw new GmailError('Google ответил без тела — неизвестно, ушло ли письмо', { kind: 'unknown', status: res.status });
  }
  if (!res.ok) throw classify(res.status, body);
  if (!body.id) throw new GmailError('Google не вернул номер письма — неизвестно, ушло ли оно', { kind: 'unknown', status: res.status });
  return { id: body.id, threadId: body.threadId };
}
