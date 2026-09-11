/**
 * Проекты и их подключения.
 *
 * Школ четыре, аккаунты у них разные — у «Дошколярика» свои Instagram и
 * Facebook, не академии. Раньше токены лежали в `.env` одним набором, и
 * любой пост уходил в один и тот же аккаунт. Теперь у каждого проекта своя
 * карточка, и токены вписываются прямо здесь, без похода на сервер.
 *
 * Сохранённые секреты наружу не отдаются: в поле видно только хвост
 * («…a41f»), а пустое поле означает «не менять». Иначе интерфейс, открытый
 * на чужом ноутбуке, показывал бы полный ключ от всех аккаунтов школы.
 */

import { api } from '../api.js';
import { icon, iconMarkup } from '../icons.js';
import { el, button, iconButton, panel, note, toast, skeleton } from '../ui.js';

export function projectsView(ctx) {
  const root = el('div', 'view');
  let projects = [];
  let openId = ctx.state.projectId;

  ctx.setTopbar({
    title: 'Проекты',
    subtitle: 'Аккаунты и доступы каждой школы',
    actions: [button('Новый проект', { iconName: 'plus', onClick: openCreate })],
  });

  const list = el('div', 'projects');
  root.append(list);
  const card = el('div');
  root.append(card);

  const loading = el('div', 'issues');
  loading.append(skeleton(70));
  list.append(loading);

  load();
  return root;

  async function load() {
    try {
      projects = (await api.projects()).projects;
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    if (!projects.some((p) => p.id === openId)) openId = projects[0]?.id;
    renderList();
    renderCard();
  }

  function renderList() {
    list.textContent = '';
    for (const project of projects) {
      const tile = el('button', `project-tile${project.id === openId ? ' project-tile--active' : ''}`);
      tile.type = 'button';

      const dot = el('span', 'project-tile__dot');
      dot.style.background = project.accent;
      tile.append(dot);

      const text = el('div', 'project-tile__text');
      text.append(el('span', 'project-tile__name', project.title));
      text.append(el('span', 'project-tile__sub', project.subtitle || '—'));
      tile.append(text);

      const count = el('span', `tag ${project.connected === project.total ? 'tag--ok' : project.connected ? 'tag--warn' : ''}`);
      count.textContent = `${project.connected}/${project.total}`;
      count.title = 'Подключено площадок';
      tile.append(count);

      tile.addEventListener('click', () => {
        openId = project.id;
        renderList();
        renderCard();
      });
      list.append(tile);
    }
  }

  async function renderCard() {
    card.textContent = '';
    if (!openId) return;

    const box = panel(null);
    box.append(el('div', 'panel__head'));
    card.append(box);

    let data;
    try {
      data = await api.projectAccounts(openId);
    } catch (err) {
      card.textContent = '';
      card.append(note('danger', 'Не удалось прочитать карточку', err.message));
      return;
    }

    card.textContent = '';
    const project = data.project;

    const head = panel(null);
    head.classList.add('project-head');
    const title = el('div', 'platform__head');
    const mark = el('span', 'platform__logo');
    mark.style.borderColor = project.accent;
    mark.style.color = project.accent;
    mark.innerHTML = iconMarkup('layers', 17);
    title.append(mark);
    const titles = el('div');
    titles.append(el('div', 'platform__name', project.title));
    titles.append(el('div', 'dim small', project.subtitle || 'без подписи'));
    title.append(titles);
    head.append(title);
    head.append(
      note(
        'info',
        'Токены хранятся зашифрованными',
        'В базе лежит шифротекст, ключ — отдельным файлом на сервере. В полях виден только хвост: пустое поле означает «не менять».'
      )
    );
    card.append(head);

    const grid = el('div', 'platforms');
    for (const account of data.accounts) grid.append(accountCard(project, account));
    card.append(grid);
  }

  function accountCard(project, account) {
    const box = el('section', 'panel platform');

    const head = el('div', 'platform__head');
    const logo = el('span', 'platform__logo');
    logo.innerHTML = iconMarkup(account.platform, 17);
    logo.style.color = account.configured ? 'var(--gold)' : 'var(--ink-3)';
    head.append(logo);

    const titles = el('div');
    titles.append(el('div', 'platform__name', account.title));
    const state = el('div', 'platform__state');
    state.append(el('span', `dot dot--${account.configured ? 'ok' : 'idle'}`));
    state.append(el('span', null, account.configured ? 'подключено' : 'не заполнено'));
    titles.append(state);
    head.append(titles);
    box.append(head);

    const form = el('form', 'account-form');
    const inputs = {};

    for (const field of account.fields) {
      const wrap = el('div', 'field');
      const lab = el('label', 'field__label', field.title);
      const input = el('input', 'input');
      input.type = field.secret ? 'password' : 'text';
      input.autocomplete = 'off';
      input.placeholder = field.filled ? (field.secret ? field.preview : field.preview) : 'не заполнено';
      if (!field.secret && field.filled) input.value = field.preview;
      const id = `a-${account.platform}-${field.key}`;
      input.id = id;
      lab.htmlFor = id;
      wrap.append(lab, input);
      if (field.hint) wrap.append(el('span', 'field__hint', field.hint));
      inputs[field.key] = input;
      form.append(wrap);
    }

    const foot = el('div', 'target__meta');
    foot.style.justifyContent = 'flex-start';

    const save = button('Сохранить', { variant: 'primary', iconName: 'check' });
    save.type = 'submit';
    foot.append(save);

    const check = button('Проверить связь', {
      iconName: 'refresh',
      disabled: !account.configured,
      onClick: async () => {
        check.disabled = true;
        try {
          const res = await api.checkAccount(project.id, account.platform);
          toast(`${account.title}: связь есть — ${res.account || res.chat || res.bot || 'ок'}`, 'ok');
        } catch (err) {
          toast(`${account.title}: ${err.message}`, 'danger');
        } finally {
          check.disabled = false;
        }
      },
    });
    foot.append(check);

    if (account.configured) {
      foot.append(
        button('Снять доступ', {
          variant: 'danger',
          onClick: async () => {
            if (!confirm(`Убрать доступы ${account.title} у проекта «${project.title}»?`)) return;
            await api.clearAccount(project.id, account.platform);
            toast('Доступы сняты', 'ok');
            load();
          },
        })
      );
    }

    form.append(foot);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {};
      for (const [key, input] of Object.entries(inputs)) payload[key] = input.value;
      save.disabled = true;
      try {
        await api.saveAccount(project.id, account.platform, payload);
        toast(`${account.title}: сохранено`, 'ok');
        load();
      } catch (err) {
        toast(err.message, 'danger');
        save.disabled = false;
      }
    });

    box.append(form);

    if (account.notes?.length) {
      const notes = el('ul', 'platform__notes');
      for (const n of account.notes) notes.append(el('li', null, n));
      box.append(notes);
    }

    return box;
  }

  function openCreate() {
    root.querySelector('.project-form')?.remove();
    const box = panel('Новый проект');
    box.classList.add('project-form');

    const form = el('form', 'plan-form__grid');
    const title = inputField('Название', 'Как называется школа или бренд');
    const slug = inputField('Короткий код', 'латиницей: например fluentfox');
    const subtitle = inputField('Подпись', 'домен или пояснение');

    form.append(title.wrap, slug.wrap, subtitle.wrap);

    const foot = el('div', 'target__meta');
    foot.style.justifyContent = 'flex-start';
    const submit = button('Завести', { variant: 'primary' });
    submit.type = 'submit';
    foot.append(submit, button('Отмена', { onClick: () => box.remove() }));
    form.append(foot);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { project } = await api.createProject({
          title: title.input.value,
          slug: slug.input.value,
          subtitle: subtitle.input.value,
        });
        box.remove();
        openId = project.id;
        await load();
        toast('Проект заведён', 'ok');
      } catch (err) {
        toast(err.message, 'danger');
        submit.disabled = false;
      }
    });

    box.append(form);
    root.prepend(box);
    title.input.focus();
  }
}

function inputField(label, placeholder) {
  const wrap = el('div', 'field');
  const input = el('input', 'input');
  input.placeholder = placeholder || '';
  const id = `pr-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}
