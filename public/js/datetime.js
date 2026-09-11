/**
 * Поле даты и времени.
 *
 * Родной `datetime-local` рисует браузер: светлый календарь с системными
 * шрифтами посреди тёмной панели. Перекрасить его нельзя — виджет живёт вне
 * страницы. Поэтому здесь свой: та же палитра, те же радиусы, та же сетка.
 *
 * Поле остаётся текстовым и принимает набор с клавиатуры («7.09 10:00»):
 * СММщик ставит десятки постов подряд, и каждый раз лезть мышью в сетку —
 * медленнее, чем напечатать.
 */

import { el } from './ui.js';
import { icon, iconMarkup } from './icons.js';

const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const pad = (n) => String(n).padStart(2, '0');

/** База хранит местное время без зоны: «2026-09-07 10:00:00». */
export function parseDb(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

export function toDb(date) {
  if (!date) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:00`;
}

export function formatHuman(date) {
  if (!date) return '';
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/**
 * Разбор того, что напечатал человек. Понимает «7.9», «07.09.2026 10:00»,
 * «7 сентября 18:30», «завтра 10:00» — год и время подставляются сами,
 * потому что чаще всего они очевидны.
 */
export function parseTyped(text, base = new Date()) {
  const raw = String(text).trim().toLowerCase();
  if (!raw) return null;

  let date = null;
  let rest = raw;

  const relative = { 'сегодня': 0, 'завтра': 1, 'послезавтра': 2 };
  for (const [word, shift] of Object.entries(relative)) {
    if (rest.startsWith(word)) {
      date = new Date(base);
      date.setDate(date.getDate() + shift);
      rest = rest.slice(word.length).trim();
      break;
    }
  }

  if (!date) {
    const numeric = rest.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?/);
    if (numeric) {
      const year = numeric[3]
        ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3])
        : base.getFullYear();
      date = new Date(year, Number(numeric[2]) - 1, Number(numeric[1]));
      rest = rest.slice(numeric[0].length).trim();
    }
  }

  if (!date) return null;

  const time = rest.match(/(\d{1,2})[:. ](\d{2})/);
  if (time) date.setHours(Number(time[1]), Number(time[2]), 0, 0);
  else date.setHours(10, 0, 0, 0);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {{value: string|null, onChange: (dbValue: string|null) => void}} opts
 * @returns {HTMLElement} поле целиком
 */
export function dateTimeField({ value, onChange, label = 'Время публикации' } = {}) {
  let current = parseDb(value);
  let popup = null;

  const wrap = el('div', 'field dtf');
  const labelEl = el('label', 'field__label', label);
  wrap.append(labelEl);

  const shell = el('div', 'dtf__shell');
  const input = el('input', 'input dtf__input');
  input.placeholder = 'дд.мм.гггг чч:мм — или «завтра 10:00»';
  input.value = formatHuman(current);
  input.autocomplete = 'off';
  const id = `dt-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  labelEl.htmlFor = id;

  const openBtn = el('button', 'dtf__btn');
  openBtn.type = 'button';
  openBtn.title = 'Открыть календарь';
  openBtn.setAttribute('aria-label', 'Открыть календарь');
  openBtn.append(icon('calendar', { size: 16 }));

  shell.append(input, openBtn);
  wrap.append(shell);

  const hint = el('span', 'field__hint');
  wrap.append(hint);
  renderHint();

  input.addEventListener('change', () => {
    const parsed = parseTyped(input.value);
    if (!input.value.trim()) {
      commit(null);
      return;
    }
    if (!parsed) {
      input.value = formatHuman(current);
      hint.textContent = 'Не разобрал дату — попробуйте «12.09 10:00»';
      hint.style.color = 'var(--danger)';
      return;
    }
    commit(parsed);
  });

  // Календарь живёт в body, а поле перерисовывается вместе с композером:
  // без проверки на isConnected остаётся висеть осиротевший попап, а кнопка
  // считает его открытым и вместо открытия «закрывает» призрак.
  const isOpen = () => Boolean(popup && popup.isConnected);
  openBtn.addEventListener('click', () => (isOpen() ? close() : open()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
    if ((e.key === 'ArrowDown' || e.key === 'Enter') && e.altKey) open();
  });

  return wrap;

  function commit(date) {
    current = date;
    input.value = formatHuman(date);
    renderHint();
    onChange(toDb(date));
  }

  function renderHint() {
    hint.style.color = '';
    if (!current) {
      hint.textContent = 'Пусто — пост останется черновиком без даты.';
      return;
    }
    const now = new Date();
    const diff = current - now;
    if (diff < 0) {
      hint.textContent = 'Время уже прошло — пост уйдёт при первой же проверке очереди.';
      hint.style.color = 'var(--warn)';
      return;
    }
    const hours = Math.round(diff / 3600000);
    hint.textContent =
      hours < 1
        ? `Через ${Math.max(1, Math.round(diff / 60000))} мин · ${DOW[(current.getDay() + 6) % 7]}`
        : hours < 48
        ? `Через ${hours} ч · ${DOW[(current.getDay() + 6) % 7]}`
        : `Через ${Math.round(hours / 24)} дн · ${DOW[(current.getDay() + 6) % 7]}`;
  }

  /* ------------------------------ календарь ------------------------------ */

  function open() {
    close();
    let shown = new Date(current || new Date());
    shown.setDate(1);

    popup = el('div', 'dtp');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Выбор даты и времени');
    document.body.append(popup);
    position();
    draw();

    // Попап в fixed и в body: внутри композера он бы обрезался прокруткой
    // родительской колонки.
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    document.addEventListener('keydown', onEsc);

    function position() {
      // Поле исчезло вместе с перерисовкой — уносим и календарь.
      if (!wrap.isConnected) {
        close();
        return;
      }
      const r = shell.getBoundingClientRect();
      const width = 300;
      popup.style.width = `${width}px`;
      popup.style.left = `${Math.min(r.left, window.innerWidth - width - 12)}px`;
      const below = window.innerHeight - r.bottom;
      if (below > 380 || below > r.top) popup.style.top = `${r.bottom + 6}px`;
      else popup.style.bottom = `${window.innerHeight - r.top + 6}px`;
    }

    function draw() {
      popup.textContent = '';

      const head = el('div', 'dtp__head');
      const prev = navBtn('chevronLeft', 'Предыдущий месяц', () => {
        shown.setMonth(shown.getMonth() - 1);
        draw();
      });
      const next = navBtn('chevronRight', 'Следующий месяц', () => {
        shown.setMonth(shown.getMonth() + 1);
        draw();
      });
      const title = el('span', 'dtp__month', `${MONTHS[shown.getMonth()]} ${shown.getFullYear()}`);
      head.append(prev, title, next);
      popup.append(head);

      const grid = el('div', 'dtp__grid');
      for (const d of DOW) grid.append(el('span', 'dtp__dow', d));

      const first = new Date(shown);
      const offset = (first.getDay() + 6) % 7;
      const start = new Date(first);
      start.setDate(1 - offset);

      const todayKey = keyOf(new Date());
      const pickedKey = current ? keyOf(current) : null;

      for (let i = 0; i < 42; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        const cell = el('button', 'dtp__day');
        cell.type = 'button';
        cell.textContent = String(day.getDate());
        if (day.getMonth() !== shown.getMonth()) cell.classList.add('dtp__day--out');
        if (keyOf(day) === todayKey) cell.classList.add('dtp__day--today');
        if (keyOf(day) === pickedKey) cell.classList.add('dtp__day--picked');
        cell.addEventListener('click', () => {
          const next = new Date(current || new Date());
          if (!current) next.setHours(10, 0, 0, 0);
          next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
          commit(next);
          draw();
        });
        grid.append(cell);
      }
      popup.append(grid);

      // Время: ползунок по получасам плюс ручной ввод. Сетка из 48 кнопок
      // заняла бы весь экран, а колесо прокрутки промахивается на телефоне.
      const timeRow = el('div', 'dtp__time');
      const timeInput = el('input', 'input dtp__timeinput');
      timeInput.type = 'time';
      timeInput.step = 300;
      timeInput.value = current ? `${pad(current.getHours())}:${pad(current.getMinutes())}` : '10:00';
      timeInput.addEventListener('change', () => {
        const [h, m] = timeInput.value.split(':').map(Number);
        const next = new Date(current || new Date());
        next.setHours(h || 0, m || 0, 0, 0);
        commit(next);
      });
      timeRow.append(el('span', 'dtp__timelabel', 'Время'), timeInput);
      popup.append(timeRow);

      const quick = el('div', 'dtp__quick');
      for (const preset of presets()) {
        const b = el('button', 'chip');
        b.type = 'button';
        b.textContent = preset.title;
        b.addEventListener('click', () => {
          commit(preset.date);
          shown = new Date(preset.date);
          shown.setDate(1);
          draw();
        });
        quick.append(b);
      }
      popup.append(quick);

      const foot = el('div', 'dtp__foot');
      const clear = el('button', 'btn btn--quiet btn--sm');
      clear.type = 'button';
      clear.textContent = 'Убрать дату';
      clear.addEventListener('click', () => {
        commit(null);
        close();
      });
      const done = el('button', 'btn btn--primary btn--sm');
      done.type = 'button';
      done.textContent = 'Готово';
      done.addEventListener('click', close);
      foot.append(clear, el('span', 'spacer'), done);
      popup.append(foot);
    }

    function navBtn(iconName, title, onClick) {
      const b = el('button', 'dtp__nav');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = iconMarkup(iconName, 15);
      b.addEventListener('click', onClick);
      return b;
    }

    function onOutside(e) {
      if (!popup || !popup.contains(e.target)) {
        if (!wrap.contains(e.target)) close();
      }
    }

    function onEsc(e) {
      if (e.key === 'Escape') {
        close();
        input.focus();
      }
    }

    popup._cleanup = () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }

  function close() {
    if (!popup) return;
    popup._cleanup?.();
    popup.remove();
    popup = null;
  }
}

function keyOf(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Ходовые варианты: утро, вечер, выходные — то, что ставят чаще всего. */
function presets() {
  const now = new Date();
  const make = (shiftDays, h, m, title) => {
    const d = new Date(now);
    d.setDate(d.getDate() + shiftDays);
    d.setHours(h, m, 0, 0);
    return { title, date: d };
  };
  const soon = new Date(now.getTime() + 3600000);
  soon.setMinutes(0, 0, 0);
  return [
    { title: 'Через час', date: soon },
    make(0, 18, 30, 'Сегодня 18:30'),
    make(1, 10, 0, 'Завтра 10:00'),
    make(1, 18, 30, 'Завтра 18:30'),
  ];
}
