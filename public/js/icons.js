/**
 * Иконки: рисованные SVG в одном штрихе 1.6 на сетке 24.
 * Эмодзи и юникодные значки интерфейсом не используются — они разного веса
 * в разных системах и рассыпают набор.
 *
 * Знаки площадок — упрощённые монохромные глифы: цвет задаёт контекст,
 * а не сам знак, иначе пять фирменных палитр спорят с золотом.
 */

const S = (body, { fill = false } = {}) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${
    fill ? 'none' : 'currentColor'
  }" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  calendar: S('<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>'),
  queue: S('<path d="M4 7h16M4 12h16M4 17h9"/>'),
  plug: S('<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>'),
  journal: S('<path d="M5 4.5h11l3 3V19a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19V6a1.5 1.5 0 0 1 1-1.5z"/><path d="M8 12h8M8 16h5"/>'),
  // Ползунки, а не шестерёнка: зубцы на 18px превращаются в кляксу
  settings: S('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  check: S('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  x: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  chevronLeft: S('<path d="m14.5 6-6 6 6 6"/>'),
  chevronRight: S('<path d="m9.5 6 6 6-6 6"/>'),
  clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  image: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 4.5-4.5 3.5 3.5 3-3 5 5"/>'),
  video: S('<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="m16 12 5-3v9l-5-3z"/>'),
  upload: S('<path d="M12 16V5m0 0L8 9m4-4 4 4"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>'),
  alert: S('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 16.5v-5M12 8h.01"/>'),
  eye: S('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  trash: S('<path d="M4.5 7h15M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7"/><path d="M6.5 7 7.5 19a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>'),
  logout: S('<path d="M9 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h3"/><path d="M15 8l4 4-4 4M19 12H9.5"/>'),
  menu: S('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  send: S('<path d="M20.5 3.5 10 14"/><path d="M20.5 3.5 14 20.5l-4-6.5-6.5-4z"/>'),
  refresh: S('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>'),
  crop: S('<path d="M6.5 2.5v15h15"/><path d="M2.5 6.5h15v15"/>'),
  layers: S('<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>'),
  drafts: S('<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17V7A1.5 1.5 0 0 1 5 5.5z"/><path d="m4 7 8 6 8-6"/>'),
};

/** Знаки площадок — упрощённые монохромные глифы одного веса. */
export const platformIcons = {
  telegram: S('<path d="M21 4.5 2.8 11.4c-.7.3-.7 1.2 0 1.4l4.6 1.5 1.8 5.3c.2.6.9.7 1.3.3l2.5-2.4 4.6 3.4c.5.4 1.2.1 1.3-.5L21.9 5.4c.1-.7-.5-1.2-1.1-.9z"/><path d="m7.4 14.3 9.8-6.6-7.2 7.6-.2 3.8"/>'),
  threads: S('<path d="M16.6 11.4c-.2-3-1.9-4.6-4.6-4.6-2.1 0-3.6.9-4.2 2.5"/><path d="M12 21c-4.6 0-7.5-3.2-7.5-9S7.4 3 12 3s7.5 3.2 7.5 9c0 3.1-1.4 5.9-4.4 5.9-2 0-3.3-1.1-3.3-2.6 0-1.7 1.5-2.7 3.7-2.7 3 0 5 1.6 5 4.3"/>'),
  instagram: S('<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none"/>'),
  facebook: S('<path d="M14.5 21v-8h2.7l.4-3.2h-3.1V7.7c0-.9.3-1.6 1.6-1.6h1.7V3.2c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H8.4V13h2.7v8z"/>'),
  tiktok: S('<path d="M14.5 3v11.2a3.4 3.4 0 1 1-3-3.4"/><path d="M14.5 3c.4 2.6 2 4.2 4.8 4.4"/>'),
};

/** @returns {SVGElement} */
export function icon(name, { size = 18, className = '' } = {}) {
  const markup = icons[name] || platformIcons[name] || icons.info;
  const wrap = document.createElement('span');
  wrap.innerHTML = markup;
  const svg = wrap.firstElementChild;
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  if (className) svg.setAttribute('class', className);
  return svg;
}

export function iconMarkup(name, size = 18) {
  const markup = icons[name] || platformIcons[name] || icons.info;
  return markup.replace('<svg ', `<svg width="${size}" height="${size}" `);
}
