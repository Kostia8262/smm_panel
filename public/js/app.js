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

const NAV = [
  { id: 'calendar', hash: '#/', title: 'Календарь', icon: 'calendar', group: 'Работа' },
  { id: 'platforms', hash: '#/platforms', title: 'Площадки', icon: 'plug', group: 'Работа' },
  { id: 'journal', hash: '#/journal', title: 'Журнал', icon: 'journal', group: 'Служебное' },
  { id: 'settings', hash: '#/settings', title: 'Настройки', icon: 'settings', group: 'Служебное' },
];

const state = { user: null, specs: null, connections: null, weekStart: null };

const dom = {};

boot();

async function boot() {
  buildShell();
  try {
    const [me, specs, status] = await Promise.all([api.me(), api.specs(), api.status()]);
    state.user = me.user;
    state.specs = specs.platforms;
    state.connections = status.platforms;
  } catch {
    return; // api.js уже увёл на страницу входа
  }
  renderWho();
  if (state.user.mustChange) showDefaultPasswordWarning();
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
  for (const item of NAV) {
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
  dom.who.append(el('span', 'who__name', state.user.name));
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

function showDefaultPasswordWarning() {
  const bar = el('div', 'note note--warn');
  bar.id = 'default-password-bar';
  bar.style.margin = '16px 24px 0';
  bar.append(icon('alert', { size: 16, className: 'note__icon' }));
  const body = el('div', 'note__body');
  body.append(el('div', 'note__title', 'Панель открывается паролем по умолчанию'));
  body.append(el('div', 'note__text', 'admin / admin — это временно, на время сборки. Смените, прежде чем отдавать панель в работу.'));
  bar.append(body);
  const go = button('Сменить', { onClick: () => (location.hash = '#/settings') });
  go.style.marginLeft = 'auto';
  bar.append(go);
  dom.outlet.before(bar);
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

  // На странице настроек полоса лишняя: там та же мысль сказана по делу,
  // рядом с формой, которая её закрывает.
  const bar = document.getElementById('default-password-bar');
  if (bar) bar.hidden = hash.startsWith('#/settings');

  dom.outlet.textContent = '';
  try {
    const postMatch = hash.match(/^#\/post\/(\d+)$/);
    if (postMatch) dom.outlet.append(composerView(ctx, Number(postMatch[1])));
    else if (hash.startsWith('#/platforms')) dom.outlet.append(platformsView(ctx));
    else if (hash.startsWith('#/journal')) dom.outlet.append(journalView(ctx));
    else if (hash.startsWith('#/settings')) dom.outlet.append(settingsView(ctx));
    else dom.outlet.append(calendarView(ctx));
  } catch (err) {
    console.error(err);
    toast('Экран не открылся: ' + err.message, 'danger');
  }
}
