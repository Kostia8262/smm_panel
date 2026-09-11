/**
 * Оболочка панели: навигация, шапка, маршрутизация по хэшу.
 *
 * Сборки нет намеренно — модули грузит браузер как есть, выкатка сводится
 * к `git pull`. Ради этого держим импорты явными и без зависимостей.
 */

import { api } from './api.js';
import { icon, iconMarkup } from './icons.js';
import { el, button, iconButton, toast } from './ui.js';
import { calendarView } from './views/calendar.js';
import { composerView } from './views/composer.js';
import { platformsView } from './views/platforms.js';
import { journalView } from './views/journal.js';
import { settingsView } from './views/settings.js';
import { staffView } from './views/staff.js';
import { planView } from './views/plan.js';
import { trendsView } from './views/trends.js';

// Карта прав — зеркало ACCESS из src/staff.js. Держать в согласии: в школьной
// панели такая же карта разъехалась, когда жила в трёх местах сразу.
const NAV = [
  { id: 'calendar', hash: '#/', title: 'Календарь', icon: 'calendar', group: 'Работа', area: 'calendar' },
  { id: 'plan', hash: '#/plan', title: 'Контент-план', icon: 'layers', group: 'Работа', area: 'plan' },
  { id: 'trends', hash: '#/trends', title: 'Тренды', icon: 'trend', group: 'Работа', area: 'trends' },
  { id: 'platforms', hash: '#/platforms', title: 'Площадки', icon: 'plug', group: 'Работа', area: 'platforms' },
  { id: 'staff', hash: '#/staff', title: 'Сотрудники', icon: 'staff', group: 'Доступ', area: 'staff' },
  { id: 'journal', hash: '#/journal', title: 'Журнал', icon: 'journal', group: 'Служебное', area: 'journal' },
  { id: 'settings', hash: '#/settings', title: 'Настройки', icon: 'settings', group: 'Служебное', area: 'settings' },
];

const ACCESS = {
  calendar: ['owner', 'smm'],
  post: ['owner', 'smm'],
  plan: ['owner', 'smm'],
  trends: ['owner', 'smm'],
  platforms: ['owner'],
  journal: ['owner', 'smm'],
  staff: ['owner'],
  settings: ['owner', 'smm'],
};

function can(area) {
  return Boolean(ACCESS[area]?.includes(state.user?.role));
}

const state = { user: null, specs: null, connections: null, weekStart: null };

const dom = {};

boot();

async function boot() {
  // Сперва узнаём, кто вошёл: набор разделов зависит от роли, и рисовать
  // сначала всё, а потом прятать лишнее — значит показать СММщику вкладку
  // «Сотрудники» на долю секунды.
  let me;
  try {
    me = await api.me();
  } catch {
    return; // api.js уже увёл на страницу входа
  }
  state.user = me.user;

  buildShell();
  renderWho();

  try {
    const [specs, status] = await Promise.all([api.specs(), can('platforms') ? api.status() : null]);
    state.specs = specs.platforms;
    state.connections = status ? status.platforms : null;
  } catch (err) {
    toast(err.message, 'danger');
  }

  window.addEventListener('hashchange', route);
  route();
}

/* ------------------------------- каркас ------------------------------- */

function buildShell() {
  document.body.textContent = '';

  const app = el('div', 'app');

  // Боковая навигация
  const rail = el('nav', 'rail');
  rail.id = 'rail';
  rail.setAttribute('aria-label', 'Разделы');

  const brand = el('div', 'brand');
  const mark = el('span', 'brand__mark');
  mark.innerHTML = iconMarkup('calendar', 19);
  brand.append(mark);
  const brandText = el('div', 'brand__text');
  brandText.append(el('span', 'brand__name', 'Планировщик'));
  brandText.append(el('span', 'brand__sub', 'My Computer Academy'));
  brand.append(brandText);
  rail.append(brand);

  let currentGroup = null;
  let groupBox = null;
  for (const item of NAV.filter((n) => can(n.area))) {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      groupBox = el('div', 'nav');
      groupBox.append(el('div', 'eyebrow nav__label', item.group));
      rail.append(groupBox);
    }
    const link = el('a', 'nav__item');
    link.href = item.hash;
    link.dataset.nav = item.id;
    link.append(icon(item.icon, { size: 18, className: 'nav__icon' }));
    link.append(el('span', 'nav__text', item.title));
    link.append(el('span', 'nav__dot'));
    link.addEventListener('click', () => closeRail());
    groupBox.append(link);
  }

  const foot = el('div', 'rail__foot');
  const who = el('div', 'who');
  who.id = 'who';
  foot.append(who);
  rail.append(foot);

  // Шапка
  const main = el('div', 'main');
  const topbar = el('header', 'topbar');

  const burger = iconButton('menu', { title: 'Разделы', onClick: toggleRail });
  burger.classList.add('burger');
  topbar.append(burger);

  const back = iconButton('chevronLeft', { title: 'Назад к календарю', onClick: () => (location.hash = '#/') });
  back.id = 'back';
  back.hidden = true;
  topbar.append(back);

  const titleBox = el('div', 'topbar__title');
  const h1 = el('h1', null, 'Планировщик');
  h1.id = 'title';
  const sub = el('span', 'topbar__sub');
  sub.id = 'subtitle';
  titleBox.append(h1, sub);
  topbar.append(titleBox);

  const actions = el('div', 'topbar__actions');
  actions.id = 'actions';
  topbar.append(actions);

  const outlet = el('main');
  outlet.id = 'outlet';

  main.append(topbar, outlet);

  const scrim = el('div', 'scrim');
  scrim.id = 'scrim';
  scrim.addEventListener('click', closeRail);

  app.append(rail, main);
  document.body.append(app, scrim);

  Object.assign(dom, { app, rail, scrim, outlet, title: h1, subtitle: sub, actions, back, who });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRail();
  });
}

function toggleRail() {
  const open = dom.rail.dataset.open !== 'true';
  dom.rail.dataset.open = String(open);
  dom.scrim.dataset.open = String(open);
}

function closeRail() {
  dom.rail.dataset.open = 'false';
  dom.scrim.dataset.open = 'false';
}

function renderWho() {
  dom.who.textContent = '';
  const avatar = el('span', 'who__avatar', (state.user.name || 'A').slice(0, 1).toUpperCase());
  dom.who.append(avatar);
  const roleTitle = state.user.role === 'owner' ? 'Владелец' : 'СММщик';
  const nameBox = el('div', 'who__text');
  nameBox.append(el('span', 'who__name', state.user.name));
  // У владельца по умолчанию имя совпадает с ролью, и строка повторяла сама
  // себя — «Владелец / ВЛАДЕЛЕЦ». Подпись роли только когда она добавляет смысл.
  if (state.user.name.trim().toLowerCase() !== roleTitle.toLowerCase()) {
    nameBox.append(el('span', 'who__role', roleTitle));
  }
  dom.who.append(nameBox);
  const out = iconButton('logout', {
    title: 'Выйти',
    onClick: async () => {
      await api.logout();
      location.href = '/login';
    },
  });
  out.style.marginLeft = 'auto';
  dom.who.append(out);
}


/* ----------------------------- маршрутизация ----------------------------- */

const ctx = {
  state,
  setTopbar({ title, subtitle = '', actions = [], back = null }) {
    dom.title.textContent = title;
    dom.subtitle.textContent = subtitle;
    dom.actions.textContent = '';
    for (const a of actions) dom.actions.append(a);
    dom.back.hidden = !back;
  },
  setSubtitle(text) {
    dom.subtitle.textContent = text;
  },
  setSaveState(text) {
    let node = document.getElementById('save-state');
    if (!node) {
      node = el('span', 'small dim');
      node.id = 'save-state';
      dom.actions.prepend(node);
    }
    node.textContent = text;
  },
};

function route() {
  const hash = location.hash || '#/';
  closeRail();

  for (const link of document.querySelectorAll('[data-nav]')) {
    const item = NAV.find((n) => n.id === link.dataset.nav);
    const active = item.hash === '#/' ? hash === '#/' || hash.startsWith('#/post/') : hash.startsWith(item.hash);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  dom.outlet.textContent = '';
  try {
    const postMatch = hash.match(/^#\/post\/(\d+)$/);
    // Адрес можно набрать руками, поэтому право проверяется и здесь, а не
    // только скрытием пункта в навигации. Сервер всё равно откажет, но
    // человек должен увидеть внятный ответ, а не пустой экран с ошибкой.
    const area = postMatch
      ? 'post'
      : hash.startsWith('#/plan') ? 'plan'
      : hash.startsWith('#/trends') ? 'trends'
      : hash.startsWith('#/platforms') ? 'platforms'
      : hash.startsWith('#/staff') ? 'staff'
      : hash.startsWith('#/journal') ? 'journal'
      : hash.startsWith('#/settings') ? 'settings'
      : 'calendar';
    if (!can(area)) {
      ctx.setTopbar({ title: 'Раздел закрыт' });
      dom.outlet.append(noAccessView());
      return;
    }

    if (postMatch) dom.outlet.append(composerView(ctx, Number(postMatch[1])));
    else if (hash.startsWith('#/plan')) dom.outlet.append(planView(ctx));
    else if (hash.startsWith('#/trends')) dom.outlet.append(trendsView(ctx));
    else if (hash.startsWith('#/platforms')) dom.outlet.append(platformsView(ctx));
    else if (hash.startsWith('#/staff')) dom.outlet.append(staffView(ctx));
    else if (hash.startsWith('#/journal')) dom.outlet.append(journalView(ctx));
    else if (hash.startsWith('#/settings')) dom.outlet.append(settingsView(ctx));
    else dom.outlet.append(calendarView(ctx));
  } catch (err) {
    console.error(err);
    toast('Экран не открылся: ' + err.message, 'danger');
  }
}

function noAccessView() {
  const box = el('div', 'view');
  const p = el('section', 'panel');
  p.append(
    el('h2', null, 'Этот раздел доступен владельцу'),
    el('p', 'field__hint', 'Токены площадок и список сотрудников видит только он. Вернитесь к календарю.')
  );
  const go = button('К календарю', { variant: 'primary', onClick: () => (location.hash = '#/') });
  go.style.marginTop = '12px';
  p.append(go);
  box.append(p);
  return box;
}
