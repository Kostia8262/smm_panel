/**
 * Журнал. Отвечает на «почему не ушло» без логов PM2 — их ротирует
 * logrotate, а разбираться приходится через неделю.
 *
 * Сверху — четыре ответа за неделю, ниже — лента по дням. Штатный пульс
 * системы (перезапуск воркера, обход сторожа) сворачивается в одну строку:
 * на проде он занимал две трети экрана и прятал настоящие события.
 */

import { api } from '../api.js';
import { el, panel, empty, skeleton, toast, button, humanDate, dowLabel, dateKey } from '../ui.js';
import { icon, iconMarkup } from '../icons.js';

// Подписи короче серверных: чипы стоят в одну строку и на планшете.
const KIND_CHIP = {
  publish: 'Публикации',
  post: 'Посты',
  access: 'Доступы',
  people: 'Люди',
  system: 'Служебное',
};

const KIND_ICON = { publish: 'send', post: 'image', access: 'key', people: 'staff', system: 'settings' };

const LEVEL_TAG = {
  error: { cls: 'tag--danger', text: 'ошибка' },
  warn: { cls: 'tag--warn', text: 'внимание' },
};

export function journalView(ctx) {
  const root = el('div', 'view');
  const filters = readFilters();
  const titles = new Map((ctx.state.specs || []).map((p) => [p.id, p.title]));

  let rows = [];
  let nextBefore = null;
  let kinds = null;
  let requestNo = 0;
  const expanded = new Set(); // свёрнутые группы, которые человек раскрыл

  ctx.setTopbar({
    title: 'Журнал',
    subtitle: 'Публикации, сбои и действия команды',
    actions: [button('Обновить', { iconName: 'refresh', variant: 'quiet', onClick: () => load() })],
  });

  const summaryHost = el('div', 'jsum');
  for (let i = 0; i < 4; i++) summaryHost.append(skeleton(86));

  const toolbar = el('div', 'jtools');
  const feedHost = el('div', 'jfeed');
  feedHost.append(skeleton(44), skeleton(44), skeleton(44));
  const moreHost = el('div', 'jmore');

  const host = panel('События', toolbar, feedHost, moreHost);
  root.append(summaryHost, host);

  load();
  return root;

  /* ------------------------------ данные ------------------------------ */

  async function load({ append = false } = {}) {
    const mine = ++requestNo;
    feedHost.setAttribute('aria-busy', 'true');
    let data;
    try {
      data = await api.journal({ ...filters, before: append ? nextBefore : 0 });
    } catch (err) {
      toast(err.message, 'danger');
      feedHost.removeAttribute('aria-busy');
      if (append) renderFeed(); // вернуть кнопку «Показать ещё» в строй
      return;
    }
    // Ответ на устаревший фильтр не должен перерисовать свежий.
    if (mine !== requestNo) return;
    feedHost.removeAttribute('aria-busy');

    rows = append ? rows.concat(data.log) : data.log;
    nextBefore = data.nextBefore;
    if (!kinds) {
      kinds = data.kinds;
      renderToolbar();
    }
    if (data.summary) renderSummary(data.summary);
    renderFeed();
  }

  function readFilters() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    return {
      kind: params.get('kind') || '',
      problems: params.get('problems') === '1',
      platform: params.get('platform') || '',
      q: params.get('q') || '',
    };
  }

  /**
   * Фильтр живёт в адресе: Ctrl+F5 после выкатки не сбрасывает разбор.
   * replaceState не зовёт hashchange — экран не пересобирается целиком.
   */
  function applyFilters(patch, { redrawTools = true } = {}) {
    Object.assign(filters, patch);
    const params = new URLSearchParams();
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.problems) params.set('problems', '1');
    if (filters.platform) params.set('platform', filters.platform);
    if (filters.q) params.set('q', filters.q);
    const query = params.toString();
    history.replaceState(null, '', `#/journal${query ? `?${query}` : ''}`);
    if (redrawTools) renderToolbar();
    load();
  }

  /* ------------------------------ сводка ------------------------------ */

  function renderSummary(s) {
    summaryHost.textContent = '';

    const published = tile('Ушло в сети', String(s.published.total), `за ${s.days} дней`);
    published.sub.textContent = s.published.byPlatform.length
      ? s.published.byPlatform.map((p) => `${titles.get(p.platform) || p.platform} ${p.count}`).join(' · ')
      : `за ${s.days} дней ничего`;
    if (s.published.total) published.box.classList.add('jsum__item--ok');

    const failures = tile('Сбои публикации', String(s.failures.count), '');
    if (s.failures.count) {
      failures.box.classList.add('jsum__item--danger');
      failures.sub.textContent = `последний ${stamp(new Date(s.failures.lastAt))}`;
      failures.box.append(
        linkButton('Показать сбои', () => applyFilters({ kind: 'publish', problems: true, platform: '', q: '' }))
      );
    } else {
      failures.sub.textContent = `за ${s.days} дней без сбоев`;
    }

    const waiting = tile('Ждут решения', String(s.waiting.count), '');
    if (s.waiting.count) {
      waiting.box.classList.add('jsum__item--warn');
      waiting.sub.textContent = '';
      waiting.sub.append(plural(s.waiting.count, ['пост не ушёл', 'поста не ушли', 'постов не ушли']), ' ');
      for (const id of s.waiting.ids) {
        const a = el('a', 'jsum__link', `#${id}`);
        a.href = `#/post/${id}`;
        waiting.sub.append(a, ' ');
      }
    } else {
      waiting.sub.textContent = 'всё ушло, висящих нет';
    }

    const w = s.worker;
    const worker = tile('Воркер очереди', '', '');
    if (w.state === 'alive') {
      worker.value.append(el('span', 'dot dot--ok'), 'на связи');
      worker.sub.textContent = `отметка ${ago(w.agoMs)} · тик ${Math.round(w.tickMs / 1000)} с`;
      worker.box.classList.add('jsum__item--ok');
    } else if (w.state === 'silent') {
      worker.value.textContent = 'молчит';
      worker.sub.textContent = `последняя отметка ${ago(w.agoMs)} — посты не уходят`;
      worker.box.classList.add('jsum__item--danger');
    } else {
      worker.value.textContent = 'нет данных';
      worker.sub.textContent = 'отметка появится после перезапуска воркера';
    }

    summaryHost.append(published.box, failures.box, waiting.box, worker.box);
  }

  function tile(label, value, sub) {
    const box = el('div', 'jsum__item');
    const valueNode = el('div', 'jsum__value num', value);
    const subNode = el('div', 'jsum__sub', sub);
    box.append(el('div', 'eyebrow', label), valueNode, subNode);
    return { box, value: valueNode, sub: subNode };
  }

  function linkButton(text, onClick) {
    const b = el('button', 'jsum__action', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /* ----------------------------- фильтры ----------------------------- */

  function renderToolbar() {
    toolbar.textContent = '';

    const kindChips = el('div', 'chips');
    kindChips.setAttribute('role', 'group');
    kindChips.setAttribute('aria-label', 'Категория');
    kindChips.append(chip('Всё', !filters.kind, () => applyFilters({ kind: '' })));
    for (const id of Object.keys(kinds || KIND_CHIP)) {
      kindChips.append(chip(KIND_CHIP[id] || id, filters.kind === id, () => applyFilters({ kind: id })));
    }

    const levelChips = el('div', 'chips');
    levelChips.setAttribute('role', 'group');
    levelChips.setAttribute('aria-label', 'Уровень');
    levelChips.append(
      chip('Все записи', !filters.problems, () => applyFilters({ problems: false })),
      chip('Только проблемы', filters.problems, () => applyFilters({ problems: true }))
    );

    const platform = el('select', 'select jtools__platform');
    platform.setAttribute('aria-label', 'Площадка');
    platform.append(new Option('Все площадки', ''));
    for (const spec of ctx.state.specs || []) platform.append(new Option(spec.title, spec.id));
    platform.value = filters.platform;
    platform.addEventListener('change', () => applyFilters({ platform: platform.value }));

    const search = el('label', 'search jtools__search');
    search.append(icon('search', { size: 15, className: 'search__icon' }));
    const input = el('input', 'input');
    input.type = 'search';
    input.placeholder = 'Текст или #номер поста';
    input.setAttribute('aria-label', 'Поиск по журналу');
    input.value = filters.q;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      // Поле не перерисовываем: иначе курсор улетает посреди набора.
      timer = setTimeout(() => applyFilters({ q: input.value.trim() }, { redrawTools: false }), 300);
    });
    search.append(input);

    toolbar.append(kindChips, levelChips, platform, search);
  }

  function chip(text, pressed, onClick) {
    const b = el('button', 'chip', text);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', onClick);
    return b;
  }

  /* ------------------------------ лента ------------------------------ */

  function renderFeed() {
    feedHost.textContent = '';
    moreHost.textContent = '';

    if (!rows.length) {
      const filtered = filters.kind || filters.problems || filters.platform || filters.q;
      feedHost.append(
        filtered
          ? empty(
              'journal',
              'Под фильтр ничего не попало',
              'Попробуйте другую категорию или площадку.',
              button('Сбросить фильтры', {
                onClick: () => applyFilters({ kind: '', problems: false, platform: '', q: '' }),
              })
            )
          : empty('journal', 'Пока пусто', 'Здесь появятся записи о публикациях, сбоях и действиях команды.')
      );
      return;
    }

    // Сворачивать пульс имеет смысл только в общей ленте: открыв
    // «Служебное», человек пришёл именно за этими строками.
    const collapse = !filters.kind && !filters.q;
    let day = null;
    let run = [];

    const flush = () => {
      if (run.length >= 2) feedHost.append(groupRow(run));
      else for (const r of run) feedHost.append(eventRow(r));
      run = [];
    };

    for (const row of rows) {
      const at = new Date(row.at);
      const key = dateKey(at);
      if (key !== day) {
        flush();
        day = key;
        feedHost.append(el('div', 'jfeed__day eyebrow', dayLabel(at)));
      }
      if (collapse && row.routine) {
        run.push(row);
        continue;
      }
      flush();
      feedHost.append(eventRow(row));
    }
    flush();

    if (nextBefore) {
      const more = button('Показать ещё', {
        onClick: async () => {
          more.disabled = true;
          await load({ append: true });
        },
      });
      moreHost.append(more);
    }
  }

  function eventRow(row) {
    const at = new Date(row.at);
    const item = el('div', `jrow${row.tone ? ` jrow--${row.tone}` : ''}`);

    const time = el('time', 'jrow__time', clock(at));
    time.dateTime = row.at;
    time.title = at.toLocaleString('ru-RU');
    item.append(time);

    const mark = el('span', 'jrow__icon');
    mark.innerHTML = iconMarkup(row.platform || KIND_ICON[row.kind] || 'info', 15);
    mark.title = row.platform ? titles.get(row.platform) || row.platform : KIND_CHIP[row.kind] || '';
    item.append(mark);

    const body = el('div', 'jrow__body');
    const head = el('div', 'jrow__head');
    head.append(el('span', 'jrow__msg', row.message));
    const tag = LEVEL_TAG[row.level];
    if (tag) head.append(el('span', `tag ${tag.cls}`, tag.text));
    body.append(head);

    const meta = el('div', 'jrow__meta');
    // Площадку подписываем, только если её нет в самом сообщении: «Опубликовано:
    // Threads» с подписью «Threads» ниже читается заиканием.
    const platformTitle = row.platform ? titles.get(row.platform) || row.platform : '';
    if (platformTitle && !row.message.toLowerCase().includes(platformTitle.toLowerCase())) {
      meta.append(el('span', null, platformTitle));
    }
    if (row.post) meta.append(postLink(row.post));
    if (row.link) {
      const a = el('a', 'jrow__ext');
      a.href = row.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.append(icon('link', { size: 13 }), el('span', null, 'Открыть в сети'));
      meta.append(a);
    }
    if (meta.childNodes.length) body.append(meta);

    item.append(body);
    return item;
  }

  function postLink(post) {
    const box = el('span', 'jrow__post');
    if (post.project) {
      const dot = el('i', 'jrow__dot');
      dot.style.background = post.project.accent;
      dot.title = post.project.title;
      box.append(dot);
      // Журнал общий на все школы. Свою школу человек и так знает, а чужую
      // по одному цвету точки не узнать — её называем словом.
      if (post.project.id !== ctx.state.projectId) box.append(el('span', null, post.project.title));
    }
    if (!post.exists) {
      box.append(el('span', null, `пост #${post.id} не найден`));
      return box;
    }
    const a = el('a', null, `#${post.id} · ${post.title}`);
    a.href = `#/post/${post.id}`;
    box.append(a);
    if (post.deleted) box.append(el('span', 'dim', 'убран из панели'));
    return box;
  }

  function groupRow(run) {
    const key = run[0].id;
    if (expanded.has(key)) {
      const frag = document.createDocumentFragment();
      for (const r of run) frag.append(eventRow(r));
      return frag;
    }

    const item = el('div', 'jrow jrow--group');
    const newest = new Date(run[0].at);
    const oldest = new Date(run[run.length - 1].at);
    const time = el('time', 'jrow__time', clock(newest));
    time.dateTime = run[0].at;
    time.title = `${clock(oldest)}–${clock(newest)}`;
    item.append(time);

    const mark = el('span', 'jrow__icon');
    mark.innerHTML = iconMarkup('settings', 15);
    item.append(mark);

    const body = el('div', 'jrow__body');
    const head = el('div', 'jrow__head');
    head.append(el('span', 'jrow__msg', `Служебные записи: ${run.length}`));
    body.append(head);

    // Одинаковые строки считаем, а не повторяем: «воркер запущен — 3 раза»
    // читается быстрее трёх одинаковых строк.
    const counts = new Map();
    for (const r of run) counts.set(r.message, (counts.get(r.message) || 0) + 1);
    const meta = el('div', 'jrow__meta');
    for (const [message, n] of counts) {
      meta.append(el('span', null, n > 1 ? `${message} — ${plural(n, ['раз', 'раза', 'раз'])}` : message));
    }
    body.append(meta);
    item.append(body);

    const open = button('Показать', {
      variant: 'quiet',
      onClick: () => {
        expanded.add(key);
        renderFeed();
      },
    });
    open.classList.add('btn--sm', 'jrow__open');
    item.append(open);
    return item;
  }
}

/* ------------------------------ форматы ------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const key = dateKey(date);
  const year = date.getFullYear() !== today.getFullYear() ? ` ${date.getFullYear()}` : '';
  if (key === dateKey(today)) return `Сегодня · ${humanDate(date)}`;
  if (key === dateKey(yesterday)) return `Вчера · ${humanDate(date)}`;
  return `${humanDate(date)}${year} · ${dowLabel(date)}`;
}

function stamp(date) {
  const today = dateKey(date) === dateKey(new Date());
  return today ? `сегодня в ${clock(date)}` : `${humanDate(date)} в ${clock(date)}`;
}

function ago(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} с назад`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** «1 раз», «3 раза», «11 раз» — с числом впереди. */
function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}
