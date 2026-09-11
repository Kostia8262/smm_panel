/**
 * Обязательная подпись к постам.
 *
 * Одна функция на всю панель намеренно: текст, который посчитал счётчик
 * символов, который показало превью и который ушёл в сеть, обязан быть
 * одним и тем же. Разойдись они хоть на строку — и пост, прошедший проверку
 * в композере, отвалится у Threads с его 500 знаками.
 */

const SEPARATOR = '\n\n—\n';

/**
 * Собрать итоговый текст поста.
 *
 * @param {string} text текст автора (общий или переопределённый для площадки)
 * @param {string|null} signature подпись проекта, уже с учётом выключателей
 * @returns {string}
 */
export function withSignature(text, signature) {
  const body = String(text || '').trimEnd();
  const sign = String(signature || '').trim();
  if (!sign) return body;

  // Автор мог вписать подпись руками — второй раз не добавляем. Сравниваем
  // по «скелету» без пробелов: перенос строки или лишний отступ не должен
  // превращаться в дубль подписи под постом.
  const skeleton = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  if (skeleton(body).includes(skeleton(sign))) return body;

  return body ? `${body}${SEPARATOR}${sign}` : sign;
}

/**
 * Какая подпись действует для поста.
 * Возвращает пустую строку, если подпись выключена у проекта или снята у поста.
 */
export function signatureFor(post, project) {
  if (!project || !project.signatureEnabled) return '';
  if (post?.skip_signature) return '';
  return project.signature || '';
}
