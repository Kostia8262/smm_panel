/**
 * Разбор чисел и времени из вёрстки соцсетей.
 *
 * Вынесено отдельно и без обращений к DOM, потому что это единственная
 * часть парсера, которую можно проверить тестом. Вёрстка Threads меняется
 * и ломает селекторы, а «1,2 тис.» остаётся «1,2 тис.» — и именно здесь
 * прячутся тихие ошибки: спутать 1.2K с 1.2 значит занизить пост в тысячу раз.
 */

/**
 * Счётчик под постом: «1 234», «1.2K», «1,2 тис.», «3,4 тыс.», «2M».
 * @returns {number|null} null, если это вообще не число
 */
export function parseCount(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase().replace(/ /g, ' ');
  if (!text) return null;

  // Сокращения: у каждого языка свои, но множитель один.
  const suffixes = [
    { re: /(млн|mln|m)\b/, factor: 1e6 },
    { re: /(тис|тыс|k|k\b)/, factor: 1e3 },
  ];

  const numberPart = text.match(/-?\d[\d\s.,]*/);
  if (!numberPart) return null;

  let digits = numberPart[0].replace(/\s/g, '');

  // Разделители: «1,234» в английском — тысячи, «1,2» в украинском — дробь.
  // Отличаем по числу знаков после последнего разделителя.
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);
  if (lastSep >= 0) {
    const tail = digits.slice(lastSep + 1);
    if (tail.length === 3 && !/[а-яa-z]/.test(text.slice(numberPart.index + numberPart[0].length).trim()[0] || '')) {
      // Три знака после разделителя и нет суффикса — это разряды: 1,234 = 1234
      digits = digits.replace(/[.,]/g, '');
    } else {
      digits = digits.replace(/[.,]/g, (m, i) => (i === lastSep ? '.' : ''));
    }
  }

  let value = Number(digits);
  if (!Number.isFinite(value)) return null;

  for (const { re, factor } of suffixes) {
    if (re.test(text)) {
      value *= factor;
      break;
    }
  }
  return Math.round(value);
}

/**
 * Возраст поста из подписи времени: «3 ч», «2 год», «45 хв», «1 д», «2h».
 * Абсолютные даты сюда не попадают — для них есть атрибут datetime.
 * @returns {number|null} часы
 */
export function parseRelativeAge(raw) {
  if (!raw) return null;
  const text = String(raw).trim().toLowerCase();
  const m = text.match(/(\d+)\s*([a-zа-яіїє]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];

  if (/^(с|s|сек|сек\w*)$/.test(unit)) return n / 3600;
  if (/^(хв|мин|м|min|m)$/.test(unit)) return n / 60;
  if (/^(год|ч|h|hr|hour\w*)$/.test(unit)) return n;
  if (/^(д|дн\w*|d|day\w*)$/.test(unit)) return n * 24;
  if (/^(тиж|нед\w*|w|week\w*)$/.test(unit)) return n * 24 * 7;
  return null;
}

/** Возраст по точной метке времени, если она есть в разметке. */
export function ageFromDatetime(datetime, now = new Date()) {
  if (!datetime) return null;
  const at = new Date(datetime);
  if (Number.isNaN(at.getTime())) return null;
  return (now - at) / 3600000;
}

/** Имя автора из ссылки вида `/@username`. */
export function usernameFromHref(href) {
  if (!href) return null;
  const m = String(href).match(/\/@([\w.]+)/);
  return m ? m[1] : null;
}
