/**
 * Ограничитель попыток для дверей, открытых наружу.
 *
 * Их две, и обе принимают секрет строкой: вход по токену сотрудника и приём
 * замеров от расширения по ключу. Считать попытки нужно одинаково, а жил
 * счётчик только у входа — второй эндпоинт можно было долбить бесконечно,
 * и не столько ради подбора ключа, сколько ради записей в базу.
 *
 * Память, а не база: перезапуск сбрасывает счётчики, и это правильно —
 * писать в базу на каждую неудачную попытку значит дать способ её раздуть.
 */

const buckets = new Map();

/**
 * @param {string} key — обычно адрес обращающегося
 * @param {{limit?: number, windowMs?: number, blockMs?: number, now?: number}} opts
 * @returns {boolean} true — дверь закрыта, обслуживать не надо
 */
export function tooManyAttempts(key, { limit = 10, windowMs = 15 * 60 * 1000, blockMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const id = String(key || 'неизвестно');
  const rec = buckets.get(id) || { count: 0, until: 0, at: 0 };

  if (rec.until > now) return true;
  if (now - rec.at > windowMs) rec.count = 0;
  rec.count += 1;
  rec.at = now;
  buckets.set(id, rec);
  if (rec.count > limit) {
    // Прежний счётчик у входа выставлял запрет, но текущую попытку всё равно
    // пропускал — лишний бесплатный выстрел на каждом круге блокировки.
    rec.until = now + blockMs;
    rec.count = 0;
    return true;
  }

  // Забытые адреса не копим: иначе счётчик растёт вместе с чужим перебором
  // и превращается в способ съесть память процесса.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.until < now && now - v.at > windowMs) buckets.delete(k);
    }
  }
  return false;
}

/** Снять счётчик после успеха: честному человеку промахи не копятся. */
export function clearAttempts(key) {
  buckets.delete(String(key || 'неизвестно'));
}

/** Только для тестов. */
export function resetAll() {
  buckets.clear();
}
