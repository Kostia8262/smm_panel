/**
 * Сотрудники. Механика как в админке школы: владелец заводит человека, тому
 * выпускается токен, и этот токен — ключ от панели.
 *
 * Главное в экране — момент выдачи. Токен показывается ровно один раз, и
 * если человек его не скопировал, лечится только перевыпуском. Поэтому после
 * создания панель не закрывается сама, а держит токен на виду с кнопками
 * «скопировать» и «скопировать ссылку для входа».
 */

import { api } from '../api.js';
import { icon, iconMarkup } from '../icons.js';
import { el, button, iconButton, panel, note, empty, toast, skeleton } from '../ui.js';

export function staffView(ctx) {
  const root = el('div', 'view');
  let staff = [];
  let roles = [];

  ctx.setTopbar({
    title: 'Сотрудники',
    subtitle: 'Доступ к панели по токену',
    actions: [button('Добавить', { variant: 'primary', iconName: 'plus', onClick: openCreate })],
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
    for (const h of ['Имя', 'Роль', 'Токен', 'Был в панели', '']) hr.append(el('th', null, h));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const person of staff) tbody.append(row(person));
    table.append(tbody);
    wrap.append(table);
    listBox.append(wrap);
  }

  function row(person) {
    const tr = el('tr');
    if (!person.active) tr.style.opacity = '0.55';

    const tdName = el('td');
    const nameLine = el('div', 'target__name');
    nameLine.append(el('span', `dot dot--${person.active ? 'ok' : 'idle'}`));
    nameLine.append(el('span', null, person.name));
    if (person.id === ctx.state.user.id) nameLine.append(el('span', 'tag', 'это вы'));
    tdName.append(nameLine);
    if (person.note) tdName.append(el('div', 'dim small', person.note));
    tr.append(tdName);

    const tdRole = el('td');
    const roleTag = el('span', `tag ${person.role === 'owner' ? 'tag--gold' : ''}`, person.roleTitle);
    tdRole.append(roleTag);
    tr.append(tdRole);

    const tdToken = el('td');
    tdToken.append(el('span', 'platform__missing', `…${person.tokenTail}`));
    tr.append(tdToken);

    tr.append(el('td', 'table__time', person.lastSeenAt || 'ни разу'));

    const tdActions = el('td');
    const actions = el('div', 'target__meta');

    actions.append(
      iconButton('refresh', {
        title: 'Перевыпустить токен',
        onClick: () => reissue(person),
      })
    );
    actions.append(
      iconButton(person.active ? 'eye' : 'check', {
        title: person.active ? 'Отключить доступ' : 'Включить доступ',
        onClick: () => toggleActive(person),
      })
    );
    actions.append(
      iconButton('trash', {
        title: 'Удалить сотрудника',
        variant: 'danger',
        onClick: () => remove(person),
      })
    );
    tdActions.append(actions);
    tr.append(tdActions);

    return tr;
  }

  /* ------------------------------ действия ------------------------------ */

  function openCreate() {
    root.querySelector('.create-box')?.remove();
    const box = panel('Новый сотрудник');
    box.classList.add('create-box');

    const form = el('form', 'login__form');
    form.style.maxWidth = '420px';

    const name = field('Имя', 'text');
    name.input.placeholder = 'Как называть в панели';
    name.input.required = true;

    const roleWrap = el('div', 'field');
    roleWrap.append(el('label', 'field__label', 'Роль'));
    const select = el('select', 'select');
    for (const r of roles) {
      const opt = el('option', null, r.title);
      opt.value = r.id;
      if (r.id === 'smm') opt.selected = true;
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

    form.append(name.wrap, roleWrap, noteField.wrap);

    const buttons = el('div', 'target__meta');
    buttons.style.justifyContent = 'flex-start';
    const submit = button('Завести и выпустить токен', { variant: 'primary' });
    submit.type = 'submit';
    buttons.append(submit, button('Отмена', { onClick: () => box.remove() }));
    form.append(buttons);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { staff: created } = await api.createStaff({
          name: name.input.value,
          role: select.value,
          note: noteField.input.value,
        });
        box.remove();
        await load();
        showToken(created, 'Сотрудник заведён');
      } catch (err) {
        toast(err.message, 'danger');
        submit.disabled = false;
      }
    });

    box.append(form);
    root.prepend(box);
    name.input.focus();
  }

  /**
   * Экран выдачи токена. Держится на месте, пока человек сам не закроет:
   * второй раз показать будет негде.
   */
  function showToken(person, title) {
    root.querySelector('.token-box')?.remove();
    const box = panel(title);
    box.classList.add('token-box');
    box.append(
      note(
        'warn',
        'Токен показывается один раз',
        'Скопируйте и передайте сотруднику. Потом его можно будет только перевыпустить.'
      )
    );

    const value = el('div', 'token-value');
    value.textContent = person.token;
    box.append(value);

    const link = `${location.origin}/login?token=${person.token}`;
    const buttons = el('div', 'target__meta');
    buttons.style.justifyContent = 'flex-start';
    buttons.append(
      button('Скопировать токен', {
        variant: 'primary',
        iconName: 'check',
        onClick: () => copy(person.token, 'Токен скопирован'),
      })
    );
    buttons.append(
      button('Скопировать ссылку для входа', {
        iconName: 'send',
        onClick: () => copy(link, 'Ссылка скопирована'),
      })
    );
    buttons.append(button('Готово', { onClick: () => box.remove() }));
    box.append(buttons);
    box.append(
      el('p', 'field__hint', 'Ссылка входит в панель сама и сразу убирает токен из адреса.')
    );

    root.prepend(box);
  }

  async function copy(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage, 'ok');
    } catch {
      // Буфер недоступен без https и без разрешения — тогда хотя бы выделим.
      const field = document.querySelector('.token-value');
      if (field) {
        const range = document.createRange();
        range.selectNodeContents(field);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      toast('Буфер недоступен — текст выделен, скопируйте вручную');
    }
  }

  async function reissue(person) {
    const mine = person.id === ctx.state.user.id;
    const warning = mine
      ? 'Это ваш токен. Перевыпуск закроет и вашу текущую сессию — придётся войти заново. Продолжить?'
      : `Старый токен ${person.name} перестанет работать немедленно. Перевыпустить?`;
    if (!confirm(warning)) return;
    try {
      const { staff: fresh } = await api.reissueStaffToken(person.id);
      await load();
      showToken(fresh, `Новый токен: ${person.name}`);
      if (mine) setTimeout(() => (location.href = '/login'), 8000);
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function toggleActive(person) {
    try {
      await api.updateStaff(person.id, { active: !person.active });
      toast(person.active ? 'Доступ отключён' : 'Доступ включён', 'ok');
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
