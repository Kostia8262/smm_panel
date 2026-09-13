/**
 * Фирменный вид письма для каждой школы.
 *
 * Письмо — продолжение сайта школы, а не панели: его открывает родитель,
 * который знает академию по сайту. Поэтому цвета здесь — данные бренда школы
 * (как цвет рубрики в базе), а не токены тёмной студии из `tokens.css`.
 * Цвета академии сняты с `mycomputer.education/css/style.css` 14.09.2026.
 *
 * Логотип — ссылкой на сайт школы: он постоянный, весит единицы килобайт и
 * не утяжеляет каждую копию письма в «Отправленных». Только PNG или JPEG:
 * SVG Gmail не показывает вовсе.
 */

export const BRANDS = {
  education: {
    tagline: 'Онлайн-школа програмування для дітей',
    site: 'https://mycomputer.education',
    logo: 'https://mycomputer.education/img/logo-80.png',
    primary: '#6C47FF',
    primaryDark: '#5533EE',
    ink: '#0F0E1A',
    text: '#3B3A4F',
    muted: '#6B6B80',
    faint: '#9999AA',
    dark: '#0D0C1A',
    darkText: '#B9B2E8',
    soft: '#F8F7FF',
    pale: '#EEE9FF',
    line: '#E8E8F0',
    page: '#F1EFF9',
  },
};

/** Школа без своего бренда получает ту же вёрстку в цвете проекта. */
export function brandFor(project) {
  const known = BRANDS[project?.slug];
  if (known) return { ...known, title: project.title };
  const accent = /^#[0-9a-f]{6}$/i.test(project?.accent || '') ? project.accent : '#6C47FF';
  return {
    ...BRANDS.education,
    tagline: project?.subtitle || '',
    site: '',
    logo: '',
    primary: accent,
    primaryDark: accent,
    title: project?.title || '',
  };
}

/**
 * Размеры картинок письма — их отдаём владельцу, по ним он рисует. Картинка
 * вдвое больше места в письме: на экранах телефонов и ноутбуков с плотными
 * пикселями иначе она мыльная.
 */
export const IMAGE_SLOTS = {
  hero: { width: 1200, height: 600, shown: '600 × 300', title: 'Головна картинка' },
  inline: { width: 1200, height: 675, shown: '520 × 293', title: 'Картинка в тексті' },
};
