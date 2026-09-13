/**
 * Сотрудники. Механика как в админке школы: владелец заводит человека, тому
 * выпускается токен, и этот токен — ключ от панели.
 *
 * Токен виден в списке всегда (решение владельца 13.09.2026): раньше он
 * показывался один раз при выдаче, и потерянный ключ лечился только
 * перевыпуском. Строка устроена как в школьной админке: имя — роль — токен
 * с кнопкой копирования — статус — когда был — «Отозвать» и «Удалить».
 */

import { api } from '../api.js';
import { el, button, iconButton, panel, empty, toast, skeleton } from '../ui.js';

export function staffView(ctx) {
  const root = el('div', 'view');
  let staff = [];
  let roles = [];

  ctx.setTopbar({
    title: 'Сотрудники',
    subtitle: 'Доступ к панели по токену',
    actions: [button('Добавить', { variant: 'primary', iconName: 'plus', onClick: () => openForm() })],
  });

  const listBox = panel('Кто имеет доступ');
  const loading = el('div', 'issues');
  loading.append(skeleton(48), skeleton(48));
  listBox.append(loading);
  root.append(listBox);

  load();
  return root;

  async function load() {
    try {
      const data = await api.staff();
      staff = data.staff;
      roles = data.roles;
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    render();
  }

  function render() {
    listBox.textContent = '';
    const head = el('div', 'panel__head');
    head.append(el('h2', null, 'Кто имеет доступ'));
    head.append(el('span', 'spacer'));
    head.append(el('span', 'dim small', `${staff.length} чел.`));
    listBox.append(head);

    if (!staff.length) {
      listBox.append(empty('staff', 'Пока никого', 'Добавьте человека — при создании ему выпустится токен.'));
      return;
    }

    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Имя', 'Роль', 'Токен', 'Статус', 'Был в панели', '']) hr.append(el('th', null, h));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const person of staff) tbody.append(row(person));
    table.append(tbody);
    wrap.append(table);
    listBox.append(wrap);
  }

  function cell(tr) {
    const td = el('td', 'table__middle');
    tr.append(td);
    return td;
  }

  function row(person) {
    const tr = el('tr');
    const mine = person.id === ctx.state.user.id;

    const tdName = cell(tr);
    const nameLine = el('div', 'target__name');
    const name = el('button', 'staff-name', person.name);
    name.type = 'button';
    name.title = 'Изменить имя, роль и заметку';
    name.addEventListener('click', () => openForm(person));
    nameLine.append(name);
    if (mine) nameLine.append(el('span', 'tag', 'это вы'));
    tdName.append(nameLine);
    if (person.note) tdName.append(el('div', 'dim small', person.note));

    const roleTag = el('span', `tag ${person.role === 'owner' ? 'tag--gold' : ''}`);
    roleTag.append(el('span', `dot ${person.role === 'owner' ? 'dot--warn' : 'dot--ok'}`));
    roleTag.append(el('span', null, person.roleTitle));
    cell(tr).append(roleTag);

    cell(tr).append(tokenBox(person));

    const status = el('span', `tag ${person.active ? 'tag--ok' : 'tag--danger'}`);
    status.textContent = person.active ? 'Активен' : 'Отозван';
    cell(tr).append(status);

    const tdSeen = cell(tr);
    tdSeen.className = 'table__time table__middle';
    tdSeen.textContent = person.lastSeenAt ? stamp(person.lastSeenAt) : 'ни разу';

    const actions = el('div', 'target__meta');
    actions.style.flexWrap = 'nowrap';
    actions.append(
      button(person.active ? 'Отозвать' : 'Вернуть', {
        iconName: person.active ? 'lock' : 'unlock',
        title: person.active
          ? 'Токен перестанет пускать в панель, открытые сессии закроются'
          : 'Тот же токен снова пускает в панель',
        onClick: () => toggleActive(person),
      })
    );
    actions.append(
      button('Удалить', { variant: 'danger', iconName: 'x', onClick: () => remove(person) })
    );
    actions.firstChild.classList.add('btn--sm');
    actions.lastChild.classList.add('btn--sm');
    cell(tr).append(actions);

    return tr;
  }

  function tokenBox(person) {
    const box = el('div', 'staff-token');
    if (!person.token) {
      // Шифротекст не читается (сменился ключ шифрования) — вход по токену
      // работает, но показать его нечем. Лечится перевыпуском.
      const lost = el('span', 'staff-token__value staff-token__value--lost', `…${person.tokenTail || ''}`);
      lost.title = 'Токен не расшифровать — перевыпустите, чтобы увидеть';
      box.append(lost);
    } else {
      const value = el('span', 'staff-token__value', person.token);
      box.append(value);
      box.append(
        iconButton('copy', { title: 'Скопировать токен', onClick: () => copy(person.token, 'Токен скопирован', value) })
      );
      box.append(
        iconButton('link', {
          title: 'Скопировать ссылку для входа',
          onClick: () => copy(`${location.origin}/login?token=${person.token}`, 'Ссылка для входа скопирована', value),
        })
      );
    }
    box.append(iconButton('refresh', { title: 'Перевыпустить токен', onClick: () => reissue(person) }));
    return box;
  }

  /* ------------------------------ действия ------------------------------ */

  /** Одна форма на «завести» и «изменить»: поля те же, разница в кнопке. */
  function openForm(person = null) {
    root.querySelector('.create-box')?.remove();
    const box = panel(person ? `Изменить: ${person.name}` : 'Новый сотрудник');
    box.classList.add('create-box');

    const form = el('form', 'login__form');
    form.style.maxWidth = '420px';

    const name = field('Имя', 'text');
    name.input.placeholder = 'Как называть в панели';
    name.input.required = true;
    if (person) name.input.value = person.name;

    const roleWrap = el('div', 'field');
    roleWrap.append(el('label', 'field__label', 'Роль'));
    const select = el('select', 'select');
    for (const r of roles) {
      const opt = el('option', null, r.title);
      opt.value = r.id;
      if (r.id === (person ? person.role : 'smm')) opt.selected = true;
      select.append(opt);
    }
    const hint = el('span', 'field__hint');
    const setHint = () => {
      hint.textContent = roles.find((r) => r.id === select.value)?.hint || '';
    };
    select.addEventListener('change', setHint);
    setHint();
    roleWrap.append(select, hint);

    const noteField = field('Заметка', 'text');
    noteField.input.placeholder = 'Необязательно: телефон, кто это';
    if (person) noteField.input.value = person.note;

    form.append(name.wrap, roleWrap, noteField.wrap);

    const buttons = el('div', 'target__meta');
    buttons.style.justifyContent = 'flex-start';
    const submit = button(person ? 'Сохранить' : 'Завести и выпустить токен', { variant: 'primary' });
    submit.type = 'submit';
    buttons.append(submit, button('Отмена', { onClick: () => box.remove() }));
    form.append(buttons);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      const body = { name: name.input.value, role: select.value, note: noteField.input.value };
      try {
        if (person) {
          await api.updateStaff(person.id, body);
          toast('Сохранено', 'ok');
        } else {
          await api.createStaff(body);
          toast('Сотрудник заведён — токен в списке', 'ok');
        }
        box.remove();
        load();
      } catch (err) {
        toast(err.message, 'danger');
        submit.disabled = false;
      }
    });

    box.append(form);
    root.prepend(box);
    name.input.focus();
  }

  async function copy(text, okMessage, fallbackNode) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage, 'ok');
    } catch {
      // Буфер недоступен без https и без разрешения — тогда хотя бы выделим.
      const range = document.createRange();
      range.selectNodeContents(fallbackNode);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast('Буфер недоступен — токен выделен, скопируйте вручную');
    }
  }

  async function reissue(person) {
    const mine = person.id === ctx.state.user.id;
    const warning = mine
      ? 'Это ваш токен. Перевыпуск закроет и вашу текущую сессию — придётся войти заново новым токеном. Продолжить?'
      : `Старый токен ${person.name} перестанет работать немедленно. Перевыпустить?`;
    if (!confirm(warning)) return;
    try {
      const { staff: fresh } = await api.reissueStaffToken(person.id);
      if (mine) {
        // Своя сессия уже закрыта: список с сервера не получить, поэтому
        // новый ключ подставляем на месте и даём время его скопировать.
        staff = staff.map((s) => (s.id === fresh.id ? fresh : s));
        render();
        toast('Скопируйте новый токен — через 20 секунд откроется вход', 'ok');
        setTimeout(() => (location.href = '/login'), 20000);
        return;
      }
      toast(`Новый токен ${person.name} выпущен`, 'ok');
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function toggleActive(person) {
    try {
      await api.updateStaff(person.id, { active: !person.active });
      toast(person.active ? 'Доступ отозван' : 'Доступ возвращён', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function remove(person) {
    if (!confirm(`Удалить ${person.name}? Токен перестанет работать.`)) return;
    try {
      await api.deleteStaff(person.id);
      toast('Сотрудник удалён', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
}

/** Время из SQLite (`datetime('now')` — всегда UTC) в местное «13.09.2026, 14:05:12». */
function stamp(value) {
  const d = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

function field(label, type) {
  const wrap = el('div', 'field');
  const input = el('input', 'input');
  input.type = type;
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}
