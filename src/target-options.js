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

/**
 * Какие настройки принимает площадка.
 *
 * TikTok (14.09.2026) — всё, что правила аудита Direct Post требуют выбирать
 * человеку у каждого поста, без значений по умолчанию:
 *   mode           — 'direct' (сразу в ленту) или 'draft' (в черновики TikTok);
 *   privacy        — уровень из privacy_level_options автора; пусто = не выбран;
 *   allowComment, allowDuet, allowStitch — по умолчанию выключены;
 *   commercial     — пост что-то рекламирует; тогда yourBrand и/или brandedContent;
 *   autoMusic      — фото-пост: TikTok сам подложит музыку.
 */
export const OPTION_KEYS = {
  telegram: ['pin', 'noPreview', 'button'],
  tiktok: ['mode', 'privacy', 'allowComment', 'allowDuet', 'allowStitch', 'commercial', 'yourBrand', 'brandedContent', 'autoMusic'],
};

export const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

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
  if (platform === 'tiktok') {
    out.mode = src.mode === 'draft' ? 'draft' : 'direct';
    if (TIKTOK_PRIVACY.includes(src.privacy)) out.privacy = src.privacy;
    for (const key of ['allowComment', 'allowDuet', 'allowStitch', 'commercial', 'yourBrand', 'brandedContent', 'autoMusic']) {
      if (src[key] === true) out[key] = true;
    }
    // Без «рекламы» отметки бренда не храним: иначе снятый переключатель
    // оставлял бы метку «Paid partnership» на посте.
    if (!out.commercial) {
      delete out.yourBrand;
      delete out.brandedContent;
    }
    return JSON.stringify(out);
  }
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
  if (platform === 'tiktok') return tiktokIssues(parseOptions(options));
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

/**
 * Правила TikTok, которые проверяются до очереди. Черновик публикует человек в
 * приложении — там он сам выберет приватность и рекламу, панель их не шлёт.
 */
function tiktokIssues(o) {
  const blockers = [];
  const warnings = [];
  if (o.mode === 'draft') {
    warnings.push('TikTok: ролик ляжет в черновики — опубликовать его нужно в приложении TikTok, там же добавить звук');
    return { blockers, warnings };
  }
  if (!TIKTOK_PRIVACY.includes(o.privacy)) {
    blockers.push('TikTok: выберите, кто увидит пост — по правилам TikTok панель не выбирает это за вас');
  }
  if (o.commercial && !o.yourBrand && !o.brandedContent) {
    blockers.push('TikTok: отмечено «рекламирует» — укажите, что именно: свой бренд или чужой (платное партнёрство)');
  }
  if (o.brandedContent && o.privacy === 'SELF_ONLY') {
    blockers.push('TikTok: платное партнёрство нельзя публиковать с видимостью «Только я»');
  }
  return { blockers, warnings };
}
