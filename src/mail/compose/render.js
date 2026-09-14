/**
 * Письмо из блоков → HTML для почтовых программ и текстовая версия
 * (docs/рассылка.md, §9.1–9.2).
 *
 * Вёрстка — по правилам почты, а не веба: таблицы шириной 600, стили в
 * атрибутах (часть программ вырезает `<style>`), шрифты только системные
 * (веб-шрифты Gmail и Outlook не грузят), картинки PNG/JPEG. `<style>` в
 * голове — только для телефона: где его поддерживают, письмо сужается
 * аккуратнее, где нет — остаётся читаемым и так.
 *
 * Всё, что приходит из редактора, экранируется. Разметка текста — только
 * **жирный**, _курсив_ и [ссылка](https://…): произвольный HTML в письмо не
 * попадает никогда.
 */

import { IMAGE_SLOTS } from './brand.js';

const FONT = "-apple-system, 'Segoe UI', Arial, Helvetica, sans-serif";

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Ссылка из редактора: только http(s), mailto и tel. Остальное — не ссылка. */
export function safeUrl(url) {
  const value = String(url ?? '').trim();
  return /^(https?:\/\/|mailto:|tel:)/i.test(value) && !/[\s"<>]/.test(value) ? value : '';
}

/** Подстановки `{{name|Дорогий підписнику}}`: имя получателя или запасное слово. */
export function personalize(text, vars = {}) {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback = '') => {
    const value = String(vars[key] ?? '').trim();
    return value || fallback.trim();
  });
}

/**
 * Разметка текста в HTML. Сначала экранирование, потом ссылки (их адреса
 * прячутся от разбора курсива: подчёркивания в адресах не должны становиться
 * `<em>`), потом жирный и курсив.
 */
export function inlineMarkup(text, brand) {
  const links = [];
  let html = escapeHtml(text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    if (!href) return label;
    links.push(`<a href="${escapeHtml(href)}" style="color:${brand.primary};text-decoration:underline;font-weight:600">${label}</a>`);
    // Метка из управляющего символа: в тексте его не бывает, а метка на
    // пробелах превратила бы «у 2 групах» в ссылку.
    return `\u0000${links.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${brand.ink};font-weight:700">$1</strong>`)
    .replace(/(^|[\s(«])_(.+?)_(?=$|[\s.,!?:;)»])/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

function plainMarkup(text) {
  return String(text ?? '')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => (safeUrl(url) ? `${label} (${url})` : label))
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[\s(«])_(.+?)_(?=$|[\s.,!?:;)»])/g, '$1$2');
}

/* ------------------------------- блоки ------------------------------- */

const row = (inner, style = '') => `<tr><td class="mc-pad" style="padding:0 40px;${style}">${inner}</td></tr>`;

function imageSlot(block, slot, brand, width) {
  const size = IMAGE_SLOTS[slot];
  if (!block.src) {
    // Пустое место под картинку — в образце и в черновике: видно, куда она
    // встанет и какого размера её рисовать.
    const height = slot === 'hero' ? 300 : 293;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" valign="middle" height="${height}" style="height:${height}px;background:${slot === 'hero' ? '#1C1840' : brand.soft};border:2px dashed ${slot === 'hero' ? '#4B3FA0' : brand.line};font-family:${FONT};">
<div style="font-size:13px;line-height:18px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${slot === 'hero' ? brand.darkText : brand.muted}">${escapeHtml(size.title)}</div>
<div style="font-size:30px;line-height:40px;font-weight:800;color:${slot === 'hero' ? '#FFFFFF' : brand.ink};padding-top:6px">${size.width} × ${size.height} px</div>
<div style="font-size:13px;line-height:18px;color:${slot === 'hero' ? brand.darkText : brand.muted};padding-top:4px">у листі займе ${escapeHtml(size.shown)}</div>
</td></tr></table>`;
  }
  const img = `<img src="${escapeHtml(block.src)}" width="${width}" alt="${escapeHtml(block.alt || '')}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;${slot === 'inline' ? 'border-radius:14px;' : ''}">`;
  const href = safeUrl(block.href);
  return href ? `<a href="${escapeHtml(href)}" style="display:block">${img}</a>` : img;
}

const RENDERERS = {
  hero(block, brand) {
    return `<tr><td style="padding:0;background:${brand.dark}">${imageSlot(block, 'hero', brand, 600)}</td></tr>`;
  },

  eyebrow(block, brand) {
    return row(
      `<div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${brand.primary}">${escapeHtml(block.text)}</div>`,
      'padding-top:36px'
    );
  },

  heading(block, brand) {
    return row(
      `<h1 class="mc-h1" style="margin:0;font-family:${FONT};font-size:30px;line-height:38px;font-weight:800;letter-spacing:-.01em;color:${brand.ink}">${escapeHtml(block.text)}</h1>`,
      'padding-top:10px'
    );
  },

  subheading(block, brand) {
    return row(
      `<h2 style="margin:0;font-family:${FONT};font-size:20px;line-height:28px;font-weight:700;color:${brand.ink}">${escapeHtml(block.text)}</h2>`,
      'padding-top:28px'
    );
  },

  text(block, brand) {
    const paragraphs = String(block.text ?? '')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:26px;color:${brand.text}">${inlineMarkup(p, brand)}</p>`)
      .join('');
    return row(paragraphs, 'padding-top:18px');
  },

  bullets(block, brand) {
    const items = (block.items || [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .map(
        (item) => `<tr>
<td width="32" valign="top" style="padding:0 0 14px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="22" height="22" align="center" valign="middle" style="width:22px;height:22px;border-radius:11px;background:${brand.pale};font-family:${FONT};font-size:12px;line-height:22px;font-weight:700;color:${brand.primary}">&#10003;</td></tr></table></td>
<td valign="top" style="padding:0 0 14px;font-family:${FONT};font-size:16px;line-height:24px;color:${brand.text}">${inlineMarkup(item, brand)}</td>
</tr>`
      )
      .join('');
    return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>`, 'padding-top:10px');
  },

  button(block, brand) {
    const href = safeUrl(block.href);
    if (!href) return '';
    return row(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="mc-btn"><tr>
<td align="center" style="border-radius:12px;background:${brand.primary}">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:16px 34px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px">${escapeHtml(block.text || 'Детальніше')}</a>
</td></tr></table>${block.note ? `<div style="padding-top:12px;font-family:${FONT};font-size:13px;line-height:20px;color:${brand.muted}">${inlineMarkup(block.note, brand)}</div>` : ''}`,
      'padding-top:12px'
    );
  },

  image(block, brand) {
    return row(imageSlot(block, 'inline', brand, 520), 'padding-top:24px');
  },

  callout(block, brand) {
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${brand.soft};border:1px solid ${brand.line};border-radius:16px;padding:22px 24px;font-family:${FONT}">
${block.title ? `<div style="font-size:16px;line-height:24px;font-weight:700;color:${brand.ink}">${escapeHtml(block.title)}</div>` : ''}
<div style="padding-top:${block.title ? '6px' : '0'};font-size:15px;line-height:24px;color:${brand.text}">${inlineMarkup(block.text, brand)}</div>
</td></tr></table>`,
      'padding-top:28px'
    );
  },

  divider(_block, brand) {
    return row(`<div style="height:1px;line-height:1px;font-size:1px;background:${brand.line}">&nbsp;</div>`, 'padding-top:32px');
  },
};

const PLAIN = {
  hero: () => '',
  eyebrow: (b) => String(b.text || '').toUpperCase(),
  heading: (b) => String(b.text || ''),
  subheading: (b) => String(b.text || ''),
  text: (b) => plainMarkup(b.text),
  bullets: (b) => (b.items || []).filter(Boolean).map((i) => `— ${plainMarkup(i)}`).join('\n'),
  button: (b) => (safeUrl(b.href) ? `${b.text || 'Детальніше'}: ${b.href}` : ''),
  image: () => '',
  callout: (b) => [b.title, plainMarkup(b.text)].filter(Boolean).join('\n'),
  divider: () => '———',
};

export const BLOCK_TYPES = Object.keys(RENDERERS);

/* ------------------------------ шапка и подвал ------------------------------ */

function header(brand) {
  const logo = brand.logo
    ? `<td width="44" valign="middle" style="width:44px"><img src="${escapeHtml(brand.logo)}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border:0;border-radius:22px"></td>`
    : '';
  const site = brand.site
    ? `<td align="right" valign="middle" class="mc-hide" style="font-family:${FONT};font-size:13px;line-height:18px"><a href="${escapeHtml(brand.site)}" style="color:${brand.darkText};text-decoration:none">${escapeHtml(brand.site.replace(/^https?:\/\//, ''))}</a></td>`
    : '';
  return `<tr><td class="mc-pad" style="background:${brand.dark};padding:22px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${logo}
<td valign="middle" style="padding-left:${brand.logo ? '12px' : '0'};font-family:${FONT}">
<div style="font-size:16px;line-height:20px;font-weight:700;color:#FFFFFF">${escapeHtml(brand.title)}</div>
${brand.tagline ? `<div style="font-size:13px;line-height:18px;color:${brand.darkText}">${escapeHtml(brand.tagline)}</div>` : ''}
</td>
${site}
</tr></table>
</td></tr>`;
}

function linkify(line, brand) {
  return escapeHtml(line).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:${brand.muted};text-decoration:underline">${url.replace(/^https?:\/\//, '')}</a>`);
}

function footer(brand, { signature = '', reason = '', unsubscribeUrl = '' }) {
  const lines = String(signature || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Подпись проекта обычно сама начинается с названия школы — тогда первая её
  // строка и есть заголовок подвала, без повтора.
  const titleLine = lines[0]?.includes(brand.title) ? lines.shift() : brand.title;
  return `<tr><td class="mc-pad" style="padding:40px 40px 0"></td></tr>
<tr><td class="mc-pad" style="background:${brand.soft};border-top:1px solid ${brand.line};padding:28px 40px 32px;font-family:${FONT}">
<div style="font-size:14px;line-height:20px;font-weight:700;color:${brand.ink}">${escapeHtml(titleLine)}</div>
${lines.map((l) => `<div style="font-size:13px;line-height:20px;color:${brand.muted}">${linkify(l, brand)}</div>`).join('')}
<div style="padding-top:18px;font-size:12px;line-height:18px;color:${brand.faint}">${reason ? `Ви отримали цей лист, бо ${escapeHtml(reason)}. ` : ''}${
    unsubscribeUrl ? `Не хочете отримувати листи — <a href="${escapeHtml(unsubscribeUrl)}" style="color:${brand.faint};text-decoration:underline">відпишіться</a>.` : ''
  }</div>
</td></tr>`;
}

/* ---------------------------------- письмо ---------------------------------- */

/**
 * @param {{brand: object, subject: string, preheader?: string, blocks: object[], vars?: object,
 *   signature?: string, reason?: string, unsubscribeUrl?: string}} letter
 * @returns {{html: string, text: string}}
 */
export function renderLetter({ brand, subject, preheader = '', blocks = [], vars = {}, signature = '', reason = '', unsubscribeUrl = '' }) {
  const personal = blocks.map((b) => ({
    ...b,
    text: b.text === undefined ? undefined : personalize(b.text, vars),
    title: b.title === undefined ? undefined : personalize(b.title, vars),
    items: b.items === undefined ? undefined : b.items.map((i) => personalize(i, vars)),
  }));

  const body = personal.map((b) => (RENDERERS[b.type] ? RENDERERS[b.type](b, brand) : '')).join('\n');
  const pre = personalize(preheader, vars);

  // Прехедер — строка рядом с темой во «Входящих». Пустые невидимые символы
  // после него не дают почте дописать туда начало письма.
  const preheaderHtml = pre
    ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${brand.page}">${escapeHtml(pre)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`
    : '';

  const html = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(subject)}</title>
<style>
@media (max-width:620px){
.mc-wrap{padding:0 !important}
.mc-card{border-radius:0 !important}
.mc-pad{padding-left:24px !important;padding-right:24px !important}
.mc-h1{font-size:25px !important;line-height:32px !important}
.mc-btn,.mc-btn td,.mc-btn a{display:block !important;width:100% !important;box-sizing:border-box}
.mc-hide{display:none !important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${brand.page};-webkit-text-size-adjust:100%">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${brand.page}">
<tr><td align="center" class="mc-wrap" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="mc-card" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:20px;overflow:hidden">
${header(brand)}
${body}
${footer(brand, { signature, reason, unsubscribeUrl })}
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    brand.title,
    '',
    ...personal.map((b) => (PLAIN[b.type] ? PLAIN[b.type](b) : '')).filter(Boolean).flatMap((t) => [t, '']),
    '—',
    brand.title,
    signature,
    reason ? `Ви отримали цей лист, бо ${reason}.` : '',
    unsubscribeUrl ? `Відписатися: ${unsubscribeUrl}` : '',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
    .trim();

  return { html, text };
}

/* --------------------------------- образец --------------------------------- */

/**
 * Образец письма: показывает вёрстку и места под картинки. Текст — пример,
 * без обещаний цен и дат: их пишет владелец в редакторе.
 */
export function sampleBlocks(project, brand) {
  const site = brand.site || 'https://mycomputer.education';
  return [
    { type: 'hero' },
    { type: 'eyebrow', text: 'Новий навчальний рік' },
    { type: 'heading', text: 'Програмування, до якого дитина повертається сама' },
    {
      type: 'text',
      // Имя — в начале фразы: в украинском обращение просится в звательный
      // падеж («Ірино»), а склонять имена автоматически мы не умеем. «Ірина,
      // доброго дня!» читается естественно, без имени — «Дорогий підписнику, доброго дня!» (звательный падеж — решение владельца 14.09; по-русски «Дорогой подписчик»).
      // Название школы в предложение не вставляем по той же причине.
      text: '{{name|Дорогий підписнику}}, доброго дня!\n\nДіти вчаться створювати власні ігри, анімації та перші програми — онлайн, разом із викладачем, який пояснює **просто і терпляче**.',
    },
    {
      type: 'bullets',
      items: ['Заняття онлайн — з дому, без дороги', 'Проєкти, які не соромно показати друзям', 'Викладач на зв’язку з батьками'],
    },
    { type: 'button', text: 'Записатися на пробне заняття', href: site, note: 'Займе хвилину — ми передзвонимо й підберемо групу.' },
    { type: 'image', alt: '' },
    { type: 'subheading', text: 'Як проходить перше заняття' },
    {
      type: 'text',
      text: 'Дитина знайомиться з викладачем, пробує зробити маленький проєкт і сама вирішує, чи цікаво їй. А ви отримуєте рекомендацію, з якого курсу почати.',
    },
    { type: 'callout', title: 'Залишились питання?', text: 'Напишіть нам або зателефонуйте — підкажемо, з чого почати саме вашій дитині.' },
  ];
}
