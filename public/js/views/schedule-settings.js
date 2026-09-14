/**
 * Настройки расписания и связи с заявками.
 *
 * Живут отдельным файлом от общих настроек: это две разные темы — «мой
 * доступ» и «как работает проект», и смешивать их в одном модуле значит
 * потом искать нужное среди чужого.
 */

import { api } from '../api.js';
import { el, button, panel, note, toast, dateKey } from '../ui.js';
import { iconMarkup } from '../icons.js';

/** Подписи статуса у поста в слоте. Штатное «запланирован» молчит. */
const SLOT_POST_STATE = {
  review: { label: 'на согласовании', cls: 'tag--warn' },
  publishing: { label: 'публикуется', cls: 'tag--gold' },
  published: { label: 'опубликован', cls: 'tag--ok' },
  partial: { label: 'ушёл не везде', cls: 'tag--danger' },
};

const WEEKDAY_NAMES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

/** «2026-09-15 10:00:00» → { date: '15.09', time: '10:00', weekday: 2 } */
function parseStamp(value) {
  const [d, t] = String(value).split(' ');
  const [y, m, day] = d.split('-').map(Number);
  const js = new Date(y, m - 1, day);
  return { date: `${String(day).padStart(2, '0')}.${String(m).padStart(2, '0')}`, time: t.slice(0, 5), weekday: ((js.getDay() + 6) % 7) + 1 };
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Слоты и рубрики. Сетка задаётся один раз на проект: выбирать время
 * у каждого поста руками — самая частая лишняя операция за день.
 *
 * Панель отвечает на три вопроса по порядку: сколько у нас эфира и где
 * ближайшая дыра (сводка), что уже стоит на неделе (сетка с занятостью),
 * какие рубрики живут и сколько в них постов (список).
 */
export function schedulePanel() {
  const p = panel('Расписание проекта');
  const body = el('div', 'sched');
  p.append(body);

  // Форма слота переживает перерисовку: правка рубрики не должна сбрасывать
  // выбранные дни и время.
  const draft = { days: new Set(), time: '10:00', categoryId: '' };

  load();
  return p;

  async function load() {
    let data;
    try {
      data = await api.schedule();
    } catch (err) {
      body.textContent = '';
      body.append(note('danger', 'Не удалось прочитать расписание', err.message));
      return;
    }
    render(data);
  }

  function render(data) {
    body.textContent = '';
    body.append(
      el(
        'p',
        'field__hint',
        'Время публикации решается один раз: пост кнопкой «В ближайший слот» падает в первый свободный. Слот с рубрикой принимает только посты этой рубрики, общий — любые.'
      )
    );
    body.append(summary(data));

    const week = section('Ближайшие 7 дней', data.slots.length ? 'нажмите на пост, чтобы открыть его' : '');
    week.append(data.slots.length ? weekGrid(data) : note('warn', 'Сетка пуста', 'Пока нет ни одного слота, кнопка «В ближайший слот» в редакторе времени не найдёт. Добавьте слоты ниже — например, будни в 10:00.'));
    week.append(slotForm(data));
    body.append(week);

    const cats = section('Рубрики', 'цвет, название и повтор меняются прямо в строке');
    cats.append(categoryList(data), categoryForm());
    body.append(cats);
  }

  function section(title, hint) {
    const s = el('div', 'sched__section');
    const head = el('div', 'sched__head');
    head.append(el('h3', null, title));
    if (hint) head.append(el('span', 'field__hint', hint));
    s.append(head);
    return s;
  }

  /* ------------------------------ сводка ------------------------------ */

  function summary(data) {
    const box = el('div', 'sched-sum');
    const total = data.slots.length;
    const named = data.slots.filter((s) => s.categoryId).length;
    const entries = Object.values(data.week || {});
    const busy = entries.filter((w) => w.post).length;
    const evergreen = data.categories.filter((c) => c.evergreen).length;

    box.append(
      stat('Слотов в неделю', String(total), total ? `${total - named} общих · ${named} под рубрику` : 'сетка не задана'),
      busyStat(busy, entries.length),
      nextStat(data, total, named),
      stat('Рубрик', String(data.categories.length), `${evergreen} ${plural(evergreen, 'вечнозелёная', 'вечнозелёные', 'вечнозелёных')}`)
    );
    return box;
  }

  function stat(label, value, sub) {
    const s = el('div', 'sched-sum__item');
    s.append(el('span', 'eyebrow', label), el('span', 'sched-sum__value tnum', value));
    if (sub) s.append(el('span', 'sched-sum__sub', sub));
    return s;
  }

  function busyStat(busy, total) {
    const s = stat('Занято на неделю', total ? `${busy} из ${total}` : '—', '');
    if (!total) return s;
    const meter = el('div', 'meter');
    const fill = el('div', 'meter__fill');
    fill.style.setProperty('--value', String(busy / total));
    meter.append(fill);
    const free = total - busy;
    s.append(meter, el('span', 'sched-sum__sub', free ? `${free} ${plural(free, 'слот свободен', 'слота свободны', 'слотов свободны')}` : 'неделя закрыта'));
    return s;
  }

  function nextStat(data, total, named) {
    if (!data.nextFree) {
      const why = !total ? 'нет ни одного слота' : named === total ? 'все слоты именные — пост без рубрики не встанет' : 'свободных нет на 60 дней';
      const s = stat('Ближайший свободный', '—', why);
      s.classList.add('sched-sum__item--warn');
      return s;
    }
    const at = parseStamp(data.nextFree);
    return stat('Ближайший свободный', `${data.weekdays[at.weekday - 1]} ${at.time}`, `${at.date} · для поста без рубрики`);
  }

  /* ------------------------------ неделя ------------------------------ */

  function weekGrid(data) {
    const grid = el('div', 'week');
    const today = ((new Date().getDay() + 6) % 7) + 1;
    const byId = new Map(data.categories.map((c) => [c.id, c]));

    // Колонки начинаются с сегодняшнего дня: «ближайшие 7 дней» читаются
    // слева направо, а не с понедельника, который уже прошёл.
    for (let i = 0; i < 7; i++) {
      const day = ((today - 1 + i) % 7) + 1;
      const todays = data.slots.filter((s) => s.weekday === day);
      const col = el('div', `week__day${i === 0 ? ' week__day--today' : ''}`);

      const head = el('div', 'week__head');
      head.title = WEEKDAY_NAMES[day - 1];
      head.append(el('span', 'week__name', i === 0 ? `${data.weekdays[day - 1]} · сегодня` : data.weekdays[day - 1]));
      const date = new Date();
      date.setDate(date.getDate() + i);
      head.append(el('span', 'week__date tnum', parseStamp(`${dateKey(date)} 00:00`).date));
      col.append(head);

      const list = el('div', 'week__list');
      for (const slot of todays) list.append(slotCard(slot, data.week?.[slot.id], byId.get(slot.categoryId), i === 0));
      if (!todays.length) list.append(el('div', 'week__empty', 'нет слотов'));
      col.append(list);
      grid.append(col);
    }

    const scroller = el('div', 'week-scroll');
    scroller.append(grid);
    return scroller;
  }

  function slotCard(slot, occ, category, isToday) {
    const card = el('div', `wslot${occ?.post ? ' wslot--busy' : ''}`);

    const top = el('div', 'wslot__top');
    top.append(el('span', 'wslot__time tnum', slot.time));
    // Прошедший сегодня слот уже смотрит на следующую неделю — иначе
    // «свободно» у слота, который был утром, читалось бы как упущенный эфир.
    if (occ && isToday && occ.at.slice(0, 10) !== dateKey(new Date())) {
      card.classList.add('wslot--later');
      top.append(el('span', 'wslot__next', 'след. неделя'));
    }
    top.append(removeButton('Убрать слот', async () => {
      try {
        await api.removeSlot(slot.id);
        load();
      } catch (err) {
        toast(err.message, 'danger');
      }
    }));
    card.append(top);

    const cat = el('div', 'wslot__cat');
    const dot = el('span', 'cat-dot');
    if (category) dot.style.background = category.color;
    else dot.classList.add('cat-dot--any');
    cat.append(dot, el('span', null, category ? category.title : 'любая рубрика'));
    card.append(cat);

    if (occ?.post) {
      const link = el('a', 'wslot__post', occ.post.title);
      link.href = `#/post/${occ.post.id}`;
      link.title = occ.post.title;
      card.append(link);
      const state = SLOT_POST_STATE[occ.post.status];
      if (state) card.append(el('span', `tag ${state.cls}`, state.label));
    } else {
      card.append(el('span', 'wslot__free', 'свободно'));
    }
    return card;
  }

  function slotForm(data) {
    const form = el('form', 'slot-add');

    const days = el('div', 'chips');
    days.setAttribute('role', 'group');
    days.setAttribute('aria-label', 'Дни недели');
    const dayButtons = data.weekdays.map((title, i) => {
      const b = el('button', 'chip', title);
      b.type = 'button';
      b.title = WEEKDAY_NAMES[i];
      b.setAttribute('aria-pressed', String(draft.days.has(i + 1)));
      b.addEventListener('click', () => {
        draft.days.has(i + 1) ? draft.days.delete(i + 1) : draft.days.add(i + 1);
        sync();
      });
      days.append(b);
      return b;
    });

    const preset = (label, set) => {
      const b = button(label, { variant: 'quiet' });
      b.classList.add('btn--sm');
      b.addEventListener('click', () => {
        draft.days = new Set(set);
        sync();
      });
      return b;
    };

    const time = el('input', 'input slot-add__time');
    time.type = 'time';
    time.value = draft.time;
    time.setAttribute('aria-label', 'Время');
    time.addEventListener('input', () => (draft.time = time.value));

    const cat = el('select', 'select slot-add__cat');
    cat.setAttribute('aria-label', 'Рубрика слота');
    cat.append(new Option('любая рубрика', ''));
    for (const c of data.categories) cat.append(new Option(`только «${c.title}»`, String(c.id)));
    cat.value = draft.categoryId;
    cat.addEventListener('change', () => (draft.categoryId = cat.value));

    const add = button('Добавить слот', { variant: 'primary', iconName: 'plus' });
    add.type = 'submit';

    const row1 = el('div', 'slot-add__row');
    row1.append(el('span', 'field__label', 'Дни'), days, preset('будни', [1, 2, 3, 4, 5]), preset('каждый день', [1, 2, 3, 4, 5, 6, 7]));
    const row2 = el('div', 'slot-add__row');
    row2.append(el('span', 'field__label', 'Время'), time, cat, add);
    form.append(el('span', 'eyebrow', 'Новый слот'), row1, row2);

    function sync() {
      dayButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(draft.days.has(i + 1))));
      const n = draft.days.size;
      add.querySelector('span').textContent =
        n === 0 ? 'Выберите дни' : n > 1 ? `Добавить ${n} ${plural(n, 'слот', 'слота', 'слотов')}` : 'Добавить слот';
      add.disabled = n === 0;
    }
    sync();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!draft.days.size) return;
      add.disabled = true;
      let added = 0;
      let dupes = 0;
      for (const weekday of [...draft.days].sort()) {
        try {
          await api.addSlot({ weekday, time: time.value, categoryId: cat.value ? Number(cat.value) : null });
          added++;
        } catch (err) {
          if (/уже есть/.test(err.message)) dupes++;
          else {
            toast(err.message, 'danger');
            break;
          }
        }
      }
      if (dupes) toast(added ? `Добавлено: ${added}, ещё ${dupes} уже были` : 'Такие слоты уже есть');
      else if (added) toast(added > 1 ? `Добавлено слотов: ${added}` : 'Слот добавлен', 'ok');
      draft.days.clear();
      load();
    });
    return form;
  }

  /* ------------------------------ рубрики ------------------------------ */

  function categoryList(data) {
    const list = el('div', 'cats');
    if (!data.categories.length) {
      list.append(el('div', 'week__empty', 'Рубрик пока нет — добавьте первую ниже.'));
      return list;
    }
    for (const c of data.categories) list.append(categoryRow(c, data.stats?.[c.id], data.palette || []));
    return list;
  }

  function categoryRow(c, stats = { slots: 0, queued: 0, published: 0 }, palette) {
    const row = el('div', 'cat');

    const swatch = el('button', 'cat__swatch');
    swatch.type = 'button';
    swatch.style.background = c.color;
    swatch.title = 'Сменить цвет';
    swatch.setAttribute('aria-label', `Цвет рубрики «${c.title}»`);
    swatch.setAttribute('aria-expanded', 'false');

    const colors = el('div', 'cat__palette');
    colors.hidden = true;
    for (const hex of palette) {
      const b = el('button', 'cat__color');
      b.type = 'button';
      b.style.background = hex;
      b.setAttribute('aria-label', hex);
      if (hex.toLowerCase() === String(c.color).toLowerCase()) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => save({ color: hex }));
      colors.append(b);
    }
    swatch.addEventListener('click', () => {
      colors.hidden = !colors.hidden;
      swatch.setAttribute('aria-expanded', String(!colors.hidden));
    });

    const title = el('input', 'cat__title');
    title.value = c.title;
    title.setAttribute('aria-label', 'Название рубрики');
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') title.blur();
      if (e.key === 'Escape') {
        title.value = c.title;
        title.blur();
      }
    });
    title.addEventListener('change', () => {
      if (title.value.trim() && title.value.trim() !== c.title) save({ title: title.value });
      else title.value = c.title;
    });

    const name = el('div', 'cat__name');
    name.append(title);
    const facts = [
      stats.slots ? `${stats.slots} ${plural(stats.slots, 'свой слот', 'своих слота', 'своих слотов')}` : 'только общие слоты',
      `${stats.queued} в очереди`,
      `${stats.published} ${plural(stats.published, 'вышел', 'вышло', 'вышло')}`,
    ];
    name.append(el('span', 'cat__facts', facts.join(' · ')));

    const ever = el('div', 'cat__ever');
    const sw = checkbox(c.evergreen, 'Вечнозелёная', (on) => save({ evergreen: on }));
    ever.append(sw.label);
    if (c.evergreen) {
      const days = el('input', 'input cat__days tnum');
      days.type = 'number';
      days.min = '1';
      days.max = '730';
      days.value = String(c.recycleDays);
      days.setAttribute('aria-label', 'Через сколько дней повторять');
      days.addEventListener('change', () => {
        if (Number(days.value) !== c.recycleDays) save({ recycleDays: Number(days.value) });
      });
      const repeat = el('span', 'cat__repeat');
      repeat.append(el('span', null, 'повтор через'), days, el('span', null, 'дн.'));
      ever.append(repeat);
    }

    const remove = removeButton('Удалить рубрику', async () => {
      const tail = stats.slots ? ` Её слоты (${stats.slots}) станут общими.` : '';
      if (!confirm(`Удалить рубрику «${c.title}»?${tail} Посты останутся, но без рубрики.`)) return;
      try {
        await api.removeCategory(c.id);
        load();
      } catch (err) {
        toast(err.message, 'danger');
      }
    });

    row.append(swatch, name, ever, remove, colors);
    return row;

    async function save(patch) {
      try {
        await api.updateCategory(c.id, patch);
        load();
      } catch (err) {
        toast(err.message, 'danger');
        load();
      }
    }
  }

  function categoryForm() {
    const form = el('form', 'cat-add');

    const title = el('input', 'input');
    title.placeholder = 'Название новой рубрики';
    title.setAttribute('aria-label', 'Название новой рубрики');

    const ever = checkbox(false, 'вечнозелёная — лучшие посты вернутся в оборот');
    const add = button('Добавить рубрику', { iconName: 'plus' });
    add.type = 'submit';

    form.append(title, ever.label, add);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.createCategory({ title: title.value, evergreen: ever.input.checked });
        title.value = '';
        ever.input.checked = false;
        load();
      } catch (err) {
        toast(err.message, 'danger');
      }
    });
    return form;
  }

  /** Галочка с подписью: щелчок по тексту тоже переключает. */
  function checkbox(checked, text, onChange) {
    const label = el('label', 'check');
    const box = el('span', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    const face = el('span', 'switch__box');
    face.innerHTML = iconMarkup('check', 12);
    box.append(input, face);
    label.append(box, el('span', null, text));
    if (onChange) input.addEventListener('change', () => onChange(input.checked));
    return { label, input };
  }

  function removeButton(title, onClick) {
    const b = el('button', 'slot__x');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = iconMarkup('x', 13);
    b.addEventListener('click', onClick);
    return b;
  }
}

/**
 * Доступ к заявкам школы. Ради этого отчёта панель и делалась своими руками:
 * сервисы планирования не знают, сколько учеников пришло с поста.
 */
export function leadsPanel() {
  const p = panel('Связь с заявками школы');
  const body = el('div');
  p.append(body);

  api
    .leadsSettings()
    .then((cfg) => {
      body.textContent = '';
      body.append(
        el(
          'p',
          'field__hint',
          'Ссылки на наши сайты в постах подменяются короткими: они считают переходы и проставляют метки, а сайт кладёт метки в заявку.'
        )
      );

      const form = el('form', 'plan-form__grid');
      const url = field('Адрес админки', cfg.url || 'https://mycomputer.education');
      // С 14.09.2026 — ключ интеграции с правом leads:read, а не полный админ-токен.
      const token = field('Ключ интеграции', '');
      token.input.type = 'password';
      token.input.autocomplete = 'new-password';
      token.input.placeholder = cfg.hasToken ? 'сохранён — пустое поле не меняет' : 'mcai_…';
      token.wrap.append(el('span', 'field__hint', 'Админка школы → «Співробітники» → «Інтеграції» → «Випустити ключ», право leads:read. Ключ показывается один раз.'));
      const domains = field('Наши домены', cfg.ownDomains || '');
      domains.wrap.append(el('span', 'field__hint', 'Через запятую. Ссылки на чужие сайты не трогаем.'));

      const foot = el('div', 'target__meta');
      foot.style.justifyContent = 'flex-start';
      const save = button('Сохранить', { variant: 'primary' });
      save.type = 'submit';
      const check = button('Проверить связь', {
        variant: 'quiet',
        onClick: async () => {
          check.disabled = true;
          try {
            const out = await api.checkLeads();
            toast(`Связь есть${out.name ? `: ключ «${out.name}»` : ''}`, 'ok');
          } catch (err) {
            toast(err.message, 'danger');
          } finally {
            check.disabled = false;
          }
        },
      });
      foot.append(save, check);

      form.append(url.wrap, token.wrap, domains.wrap, foot);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          await api.saveLeadsSettings({
            url: url.input.value,
            token: token.input.value,
            ownDomains: domains.input.value,
          });
          toast('Сохранено', 'ok');
          token.input.value = '';
        } catch (err) {
          toast(err.message, 'danger');
        } finally {
          save.disabled = false;
        }
      });
      body.append(form);
    })
    .catch((err) => {
      body.textContent = '';
      body.append(note('danger', 'Настройки не прочитались', err.message));
    });

  return p;
}

function field(label, value) {
  const wrap = el('div', 'field');
  const input = el('input', 'input');
  input.value = value || '';
  const id = `ls-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}

/**
 * Ключ для расширения-сборщика.
 *
 * Отдельный от токенов сотрудников: расширение работает в чужой вкладке
 * рядом с Threads, и давать ему ключ от всей панели нельзя — этот ключ
 * умеет ровно одно, принимать посты.
 */
export function ingestPanel() {
  const p = panel('Сборщик ленты (расширение)');
  const body = el('div', 'stack');
  p.append(body);

  load();
  return p;

  async function load() {
    body.textContent = '';
    body.append(el('span', 'field__hint', 'читаю…'));
    try {
      render(await api.ingestKey());
    } catch (err) {
      body.textContent = '';
      body.append(note('danger', 'Не прочиталось', err.message));
    }
  }

  function render(cfg) {
    body.textContent = '';
    body.append(
      el(
        'p',
        'field__hint',
        'Расширение читает ленту Threads, пока её листает человек, и присылает сюда лайки, ответы и репосты чужих постов. Официальный API этих цифр не отдаёт.'
      )
    );

    if (!cfg.key) {
      body.append(
        note('warn', 'Ключ ещё не выпущен', 'Без него панель не примет данные. Нажмите кнопку ниже.')
      );
      body.append(actionRow(cfg));
      return;
    }

    // Шаги по порядку: первый вопрос после «выпустить ключ» — что дальше.
    body.append(el('div', 'eyebrow', 'Как подключить'));
    const steps = el('ol', 'steps');
    steps.append(
      step('Нажмите «Скопировать настройку» — в буфер уйдёт одна строка с адресом панели, проектом и ключом.'),
      step('Откройте в Chrome адрес chrome://extensions и включите «Режим разработчика» — переключатель справа сверху.'),
      step('Нажмите «Загрузить распакованное расширение» и выберите папку extension из репозитория планировщика.'),
      step('Щёлкните значок расширения, вставьте строку в поле «Настройка одной строкой» и нажмите «Применить».'),
      step('Откройте Threads и листайте ленту. Собранное появится в разделе «Тренды».')
    );
    body.append(steps);

    const setup = el('div', 'token-value', cfg.setup);
    body.append(setup);
    body.append(
      el(
        'span',
        'field__hint',
        `Строка настроена на проект «${cfg.projectTitle}» (№${cfg.projectId}). Для другого проекта переключите его вверху и скопируйте заново.`
      )
    );

    body.append(actionRow(cfg));
  }

  function actionRow(cfg) {
    const row = el('div', 'target__meta');
    row.style.justifyContent = 'flex-start';

    if (cfg.setup) {
      row.append(
        button('Скопировать настройку', {
          variant: 'primary',
          iconName: 'check',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(cfg.setup);
              toast('Строка скопирована — вставьте её в расширение', 'ok');
            } catch {
              toast('Буфер недоступен — выделите строку выше и скопируйте вручную');
            }
          },
        })
      );
    }

    row.append(
      button(cfg.key ? 'Перевыпустить ключ' : 'Выпустить ключ', {
        variant: cfg.key ? 'danger' : 'primary',
        iconName: cfg.key ? 'refresh' : 'plus',
        onClick: async () => {
          if (cfg.key && !confirm('Старый ключ перестанет работать — расширение придётся настроить заново. Продолжить?')) {
            return;
          }
          try {
            await api.newIngestKey();
            await load();
            toast('Ключ выпущен', 'ok');
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      })
    );
    return row;
  }

  function step(text) {
    return el('li', null, text);
  }
}
