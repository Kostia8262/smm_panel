/**
 * Настройки цели, которые есть только у своей площадки (`post_targets.options`).
 *
 * Сейчас их понимает только Telegram (13.09.2026):
 *   pin       — закрепить пост в канале после выхода;
 *   noPreview — не рисовать под текстом карточку ссылки;
 *   button    — {text, url}: кнопка-ссылка под последним сообщением поста.
 *
 * Без базы — нужен и серверу, и очереди, и проверке, и тестам.
 */

/** Какие настройки принимает площадка. */
export const OPTION_KEYS = { telegram: ['pin', 'noPreview', 'button'] };

export const BUTTON_TEXT_MAX = 64;

/** Из базы или из запроса — всегда объект. */
export function parseOptions(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Что пришло от интерфейса — в строку для базы. Лишнее отбрасываем.
 * Включённую кнопку храним и пустой: сказать «не хватает ссылки» — дело
 * проверки поста. Иначе включённая, но ещё не заполненная кнопка пропадала
 * при первом же сохранении поста.
 */
export function storeOptions(platform, value) {
  const keys = OPTION_KEYS[platform];
  if (!keys) return null;
  const src = parseOptions(value);
  const out = {};
  if (keys.includes('pin') && src.pin) out.pin = true;
  if (keys.includes('noPreview') && src.noPreview) out.noPreview = true;
  if (keys.includes('button') && src.button && typeof src.button === 'object') {
    out.button = {
      text: String(src.button.text ?? '').trim().slice(0, BUTTON_TEXT_MAX),
      url: String(src.button.url ?? '').trim().slice(0, 2000),
    };
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** Замечания к настройкам цели — в формате проверки поста. */
export function optionIssues(platform, options, { mediaCount = 0 } = {}) {
  const blockers = [];
  const button = parseOptions(options).button;
  if (platform !== 'telegram' || !button) return { blockers, warnings: [] };

  if (!button.text) blockers.push('У кнопки нет текста — впишите, что на ней написано, или уберите кнопку');
  if (!button.url) {
    blockers.push('У кнопки нет ссылки');
  } else if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(button.url)) {
    blockers.push(`Ссылка кнопки «${button.url}» — не адрес сайта: нужна вида https://…`);
  }
  if (mediaCount > 1) {
    blockers.push('К альбому Telegram кнопку не прикрепляет — оставьте один файл или уберите кнопку');
  }
  return { blockers, warnings: [] };
}
