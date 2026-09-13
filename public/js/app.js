/**
 * Оболочка панели: навигация, шапка, маршрутизация по хэшу.
 *
 * Сборки нет намеренно — модули грузит браузер как есть, выкатка сводится
 * к `git pull`. Ради этого держим импорты явными и без зависимостей.
 */

import { api, setProject } from './api.js';
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
import { projectsView } from './views/projects.js';
import { mailView } from './views/mail/index.js';

// Карта прав — зеркало ACCESS из src/staff.js. Держать в согласии: в школьной
// панели такая же карта разъехалась, когда жила в трёх местах сразу.
const NAV = [
  { id: 'calendar', hash: '#/', title: 'Календарь', icon: 'calendar', group: 'Работа', area: 'calendar' },
  { id: 'plan', hash: '#/plan', title: 'Контент-план', icon: 'layers', group: 'Работа', area: 'plan' },
  { id: 'trends', hash: '#/trends', title: 'Тренды', icon: 'trend', group: 'Работа', area: 'trends' },
  { id: 'mail', hash: '#/mail', title: 'Рассылка', icon: 'mail', group: 'Работа', area: 'mail' },
  { id: 'projects', hash: '#/projects', title: 'Проекты', icon: 'plug', group: 'Доступ', area: 'platforms' },
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
  mail: ['owner', 'smm'],
  mail_contacts: ['owner'],
  mail_senders: ['owner'],
};

function can(area) {
  return Boolean(ACCESS[area]?.includes(state.user?.role));
}

const state = { user: null, specs: null, connections: null, weekStart: null, projectId: null, projects: [] };

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
    const [specs, projects] = await Promise.all([api.specs(), api.projects()]);
    state.specs = specs.platforms;
    state.projects = projects.projects;

    // Выбранный проект переживает перезагрузку: СММщик ведёт одну школу
    // неделями, и каждый раз переключаться заново — лишний шаг на ровном месте.
    const saved = Number(localStorage.getItem('smm.project') || 0);
    state.projectId = state.projects.some((p) => p.id === saved) ? saved : state.projects[0]?.id || null;
    setProject(state.projectId);
    renderProjectSwitch();

    if (can('platforms')) {
      const status = await api.status();
      state.connections = status.platforms;
      markTokenAlerts();
    }
  } catch (err) {
    toast(err.message, 'danger');
  }

  window.addEventListener('hashchange', route);
  route();
}

/**
 * Значок у раздела «Проекты», когда сторож нашёл беду с токенами.
 *
 * Без него о смерти токена узнаёшь, только зайдя в карточку проекта, а
 * заходят туда раз в месяц. Владелец же сидит в календаре — значит сказать
 * надо там, где он есть.
 *
 * Сторож ходит по площадкам в воркере, здесь только чтение отметок: лишней
 * задержки при открытии панели это не даёт.
 */
async function markTokenAlerts() {
  let alerts;
  try {
    alerts = await api.tokenAlerts();
  } catch {
    return; // сторож — не повод ронять панель
  }
  if (!alerts.count) return;

  const link = dom.rail?.querySelector('[data-nav="projects"]');
  if (!link) return;

  const mark = el('span', `nav__alert nav__alert--${alerts.worst}`);
  mark.title =
    alerts.worst === 'danger'
      ? 'Токен площадки истёк или отозван — публикация туда не уйдёт'
      : 'Токен площадки скоро умрёт';
  link.append(mark);

  toast(
    alerts.worst === 'danger'
      ? `Токены площадок: ${alerts.count} — не работают. Откройте «Проекты»`
      : `Токены площадок: ${alerts.count} — скоро умрут. Откройте «Проекты»`,
    alerts.worst
  );
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

  const switcher = el('div', 'projsw');
  switcher.id = 'projsw';
  rail.append(switcher);

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
  // Экраны с вкладками проектов переключают панель целиком: иначе «новая
  // идея» ушла бы не в ту школу, которую человек только что открыл.
  switchProject: (id) => switchProject(id),
  can: (area) => can(area),
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
      : hash.startsWith('#/mail') ? 'mail'
      : hash.startsWith('#/projects') || hash.startsWith('#/platforms') ? 'platforms'
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
    else if (hash.startsWith('#/mail')) dom.outlet.append(mailView(ctx));
    else if (hash.startsWith('#/projects')) dom.outlet.append(projectsView(ctx));
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

/**
 * Переключатель проектов. Стоит вверху навигации, потому что отвечает на
 * вопрос «чей это календарь» — а он важнее любого раздела: перепутав проект,
 * человек опубликует пост академии в канале «Дошколярика».
 */
function renderProjectSwitch() {
  const host = document.getElementById('projsw');
  if (!host || !state.projects.length) return;
  host.textContent = '';

  const current = state.projects.find((p) => p.id === state.projectId) || state.projects[0];

  const btn = el('button', 'projsw__btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  const dot = el('span', 'projsw__dot');
  dot.style.background = current.accent;
  btn.append(dot);
  const text = el('div', 'projsw__text');
  text.append(el('span', 'projsw__name', current.title));
  text.append(el('span', 'projsw__sub', `${current.connected}/${current.total} площадок`));
  btn.append(text);
  btn.append(icon('chevronRight', { size: 15, className: 'projsw__chev' }));
  host.append(btn);

  const menu = el('div', 'projsw__menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  for (const project of state.projects) {
    const item = el('button', 'projsw__item');
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(project.id === state.projectId));
    const d = el('span', 'projsw__dot');
    d.style.background = project.accent;
    item.append(d);
    const t = el('div', 'projsw__text');
    t.append(el('span', 'projsw__name', project.title));
    t.append(el('span', 'projsw__sub', project.subtitle || '—'));
    item.append(t);
    item.addEventListener('click', () => switchProject(project.id));
    menu.append(item);
  }
  host.append(menu);

  btn.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    btn.classList.toggle('projsw__btn--open', !menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!host.contains(e.target)) {
      menu.hidden = true;
      btn.classList.remove('projsw__btn--open');
    }
  });
}

function switchProject(id) {
  if (id === state.projectId) return;
  state.projectId = id;
  setProject(id);
  try {
    localStorage.setItem('smm.project', String(id));
  } catch {
    // Приватное окно — переживём, просто не запомним выбор.
  }
  state.connections = null;
  renderProjectSwitch();
  route();
}
