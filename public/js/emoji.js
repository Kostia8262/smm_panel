/**
 * Пикер эмодзи для полей с текстом поста.
 *
 * Системный пикер (Win + . , ⌃⌘Space) есть не у всех и не все о нём знают,
 * а посты без эмодзи в соцсетях почти не пишут — поэтому кнопка рядом с полем.
 *
 * Набор лежит у нас файлом (см. tools/build-emoji.mjs): CSP панели не пускает
 * внешние источники. Грузится при первом открытии, а не со страницей —
 * полмегабайта ради кнопки, которую жмут не в каждом посте, ни к чему.
 *
 * Знаки новее, чем умеет рисовать система, прячутся: на Windows 10 свежие
 * эмодзи выходят пустыми квадратами, и вставить такой — отправить в сеть
 * знак, который автор сам не видел.
 */

import { el, iconButton } from './ui.js';

const RECENT_KEY = 'smm.emoji.recent';
const TONE_KEY = 'smm.emoji.tone';
const RECENT_MAX = 24;
const TONE_SWATCHES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];

let dataPromise = null;
let openPicker = null; // один открытый пикер на страницу

function loadData() {
  dataPromise ??= fetch('/js/emoji-data.json')
    .then((r) => {
      if (!r.ok) throw new Error(`набор эмодзи не загрузился: ${r.status}`);
      return r.json();
    })
    .then((data) => {
      const hidden = unsupportedVersions(data.groups);
      const broken = brokenSequences();
      for (const g of data.groups) {
        // Флаги Windows рисует буквами, но это всё тот же флаг в сети — их не прячем
        if (g.key !== 'flags') g.items = g.items.filter((it) => !hidden.has(it[3]) && !broken(it[0]));
      }
      return data;
    })
    .catch((err) => {
      dataPromise = null; // следующая попытка — заново, а не тот же отказ
      throw err;
    });
  return dataPromise;
}

/**
 * Какие версии Эмодзи система не рисует. Проверяем по одному знаку на версию:
 * цветной глиф даёт цветные пиксели, пустой квадрат — только цвет текста.
 */
function unsupportedVersions(groups) {
  const hidden = new Set();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return hidden;

  const probes = new Map();
  for (const group of groups) {
    if (group.key === 'flags') continue;
    for (const it of group.items) if (!probes.has(it[3])) probes.set(it[3], it[0]);
  }
  g.font = '20px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  g.textBaseline = 'top';
  for (const [version, sample] of probes) {
    g.clearRect(0, 0, 24, 24);
    g.fillStyle = '#000';
    g.fillText(sample, 0, 0);
    const px = g.getImageData(0, 0, 24, 24).data;
    let colored = false;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] && (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2])) {
        colored = true;
        break;
      }
    }
    if (!colored) hidden.add(version);
  }
  return hidden;
}

/**
 * Составной знак (через ZWJ), которого система не знает, цветной — только
 * рассыпается на части: 😮‍💨 выходит как 😮💨. Такой шире одиночного глифа.
 */
function brokenSequences() {
  const g = document.createElement('canvas').getContext('2d');
  if (!g) return () => false;
  g.font = '20px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  const single = g.measureText('😀').width;
  return (char) => char.includes('‍') && g.measureText(char).width > single * 1.4;
}

function readStore(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватное окно: недавние просто не запомнятся */
  }
}

/**
 * Вставка туда, где стоит курсор, с заменой выделенного. Событие `input`
 * обязательно: на нём висят автосохранение, счётчики и превью.
 */
function insertInto(field, text) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.focus({ preventScroll: true });
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Кнопка-смайлик с пикером под ней.
 * @param {HTMLTextAreaElement|HTMLInputElement} field поле, куда вставлять
 */
export function emojiButton(field) {
  const wrap = el('span', 'emoji');
  const btn = iconButton('smile', { title: 'Вставить эмодзи' });
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  wrap.append(btn);

  let pop = null;

  const close = ({ refocus = false } = {}) => {
    if (!pop) return;
    pop.remove();
    pop = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (openPicker === close) openPicker = null;
    if (refocus) btn.focus();
  };

  const onOutside = (e) => {
    if (!wrap.contains(e.target)) close();
  };

  btn.addEventListener('click', () => {
    if (pop) return close();
    openPicker?.();
    openPicker = close;
    pop = picker(field, close);
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
  });

  return wrap;
}

function picker(field, close) {
  const pop = el('div', 'emoji-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Эмодзи');
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close({ refocus: true });
    }
  });

  const head = el('div', 'emoji-pop__head');
  const search = el('input', 'input emoji-pop__search');
  search.type = 'search';
  search.placeholder = 'Поиск: сердце, огонь, heart…';
  search.setAttribute('aria-label', 'Поиск эмодзи');

  let tone = Number(readStore(TONE_KEY, 0)) || 0;
  const toneBtn = el('button', 'emoji-pop__tone', TONE_SWATCHES[tone]);
  toneBtn.type = 'button';
  toneBtn.title = 'Тон кожи';
  toneBtn.setAttribute('aria-label', 'Сменить тон кожи');
  head.append(search, toneBtn);

  const tabs = el('div', 'emoji-pop__tabs');
  const body = el('div', 'emoji-pop__body');
  body.append(el('div', 'emoji-pop__status', 'Загружаю…'));
  pop.append(head, tabs, body);

  queueMicrotask(() => search.focus());

  let data = null;
  const withTone = (it) => (tone && it[4] ? it[4][tone - 1] : it[0]);

  const cell = (char, label) => {
    const b = el('button', 'emoji-pop__cell', char);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.dataset.char = char;
    return b;
  };

  const section = (id, title, items) => {
    const s = el('section', 'emoji-pop__group');
    s.dataset.group = id;
    s.append(el('div', 'emoji-pop__title', title));
    const grid = el('div', 'emoji-pop__grid');
    grid.append(...items);
    s.append(grid);
    return s;
  };

  function render() {
    body.textContent = '';
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    tabs.hidden = words.length > 0;

    if (words.length) {
      const found = [];
      for (const g of data.groups) {
        for (const it of g.items) {
          const hay = `${it[1].toLowerCase()} ${it[2]}`;
          if (words.every((w) => hay.includes(w))) found.push(cell(withTone(it), it[1]));
        }
      }
      body.append(
        found.length ? section('found', `Найдено: ${found.length}`, found) : el('div', 'emoji-pop__status', 'Ничего не нашлось')
      );
      body.scrollTop = 0;
      return;
    }

    const recent = readStore(RECENT_KEY, []);
    if (recent.length) body.append(section('recent', 'Недавние', recent.map((r) => cell(r[0], r[1]))));
    for (const g of data.groups) body.append(section(g.key, g.title, g.items.map((it) => cell(withTone(it), it[1]))));
  }

  function renderTabs() {
    tabs.textContent = '';
    const list = [...(readStore(RECENT_KEY, []).length ? [{ key: 'recent', title: 'Недавние', mark: '🕘' }] : [])];
    for (const g of data.groups) list.push({ key: g.key, title: g.title, mark: g.items[0]?.[0] });
    for (const t of list) {
      const b = el('button', 'emoji-pop__tab', t.mark);
      b.type = 'button';
      b.title = t.title;
      b.setAttribute('aria-label', t.title);
      b.addEventListener('click', () => {
        const target = body.querySelector(`[data-group="${t.key}"]`);
        if (target) body.scrollTop = target.offsetTop; // тело пикера — offsetParent, см. CSS
      });
      tabs.append(b);
    }
  }

  body.addEventListener('click', (e) => {
    const b = e.target.closest('.emoji-pop__cell');
    if (!b) return;
    const char = b.dataset.char;
    insertInto(field, char);
    const recent = readStore(RECENT_KEY, []).filter((r) => r[0] !== char);
    recent.unshift([char, b.title]);
    writeStore(RECENT_KEY, recent.slice(0, RECENT_MAX));
    // Пикер не закрываем: эмодзи часто ставят по два-три подряд
  });

  search.addEventListener('input', () => data && render());

  toneBtn.addEventListener('click', () => {
    tone = (tone + 1) % TONE_SWATCHES.length;
    toneBtn.textContent = TONE_SWATCHES[tone];
    writeStore(TONE_KEY, tone);
    if (data) {
      const top = body.scrollTop;
      render();
      body.scrollTop = top;
    }
  });

  loadData()
    .then((d) => {
      data = d;
      renderTabs();
      render();
    })
    .catch((err) => {
      body.textContent = '';
      body.append(el('div', 'emoji-pop__status', err.message));
    });

  return pop;
}
