/**
 * Содержимое базы (или все контакты школы): кто в ней, в каком состоянии,
 * откуда взялся. Здесь же правка человека, отписка, стирание по просьбе и
 * действия над отмеченными строками.
 *
 * Фильтр живёт в адресе, как у журнала: Ctrl+F5 после выкатки не сбрасывает
 * поиск, а ссылку на «отписавшихся из базы родителей» можно переслать.
 */

import { api } from '../../api.js';
import { el, button, iconButton, panel, empty, skeleton, toast, note } from '../../ui.js';
import { icon } from '../../icons.js';
import { STATUS_TAG, tag, num, day, plural, ADDRESSES, backLink, field, input, select, chip, ask, hashParams, setHashParams } from './common.js';

const SORTS = [
  ['added', 'Сначала новые'],
  ['email', 'По адресу'],
  ['name', 'По имени'],
  ['status', 'Сначала неактивные'],
];

/** Сколько своих колонок базы показывать в таблице — остальные в карточке. */
const VISIBLE_COLUMNS = 3;

export function listView(ctx, listKey) {
  const root = el('div', 'view');
  const listId = listKey === 'all' ? null : Number(listKey);
  const path = `#/mail/lists/${listKey}`;
  const params = hashParams();
  const filters = {
    q: params.get('q') || '',
    status: params.get('status') || '',
    sort: params.get('sort') || 'added',
    page: Number(params.get('page')) || 1,
  };

  let data = null;
  let lists = [];
  let consentBases = {};
  let requestNo = 0;
  const selected = new Set();

  const cardHost = el('div', 'stack mail-slot');
  const tools = el('div', 'jtools');
  const bulkHost = el('div', 'mail-slot');
  const tableHost = el('div', 'mail-table-host');
  tableHost.append(skeleton(44), skeleton(44), skeleton(44));
  const pagerHost = el('div', 'mail-pager');
  const host = panel(null, tools, bulkHost, tableHost, pagerHost);

  root.append(backLink(), cardHost, host);
  setTopbar();
  loadMeta();
  load();
  return root;

  /* ------------------------------- данные ------------------------------- */

  async function loadMeta() {
    try {
      const summary = await api.mailSummary(false);
      lists = summary.lists;
      consentBases = summary.consentBases;
      renderBulk();
    } catch {
      // Без списка баз не работают только «скопировать в…» — не повод ронять экран.
    }
  }

  async function load() {
    const mine = ++requestNo;
    tableHost.setAttribute('aria-busy', 'true');
    let fresh;
    try {
      fresh = await api.mailContacts({ list: listKey, ...filters });
    } catch (err) {
      tableHost.removeAttribute('aria-busy');
      toast(err.message, 'danger');
      if (err.status === 404) location.hash = '#/mail';
      return;
    }
    if (mine !== requestNo) return;
    tableHost.removeAttribute('aria-busy');
    data = fresh;
    filters.page = data.page;
    for (const id of [...selected]) if (!data.contacts.some((c) => c.id === id)) selected.delete(id);
    setTopbar();
    renderTools();
    renderBulk();
    renderTable();
    renderPager();
  }

  function applyFilters(patch, { keepPage = false } = {}) {
    Object.assign(filters, patch);
    if (!keepPage) filters.page = 1;
    selected.clear();
    setHashParams(path, filters);
    load();
  }

  /* ------------------------------- шапка ------------------------------- */

  function setTopbar() {
    const list = data?.list;
    const title = listId ? list?.name || 'База' : 'Все контакты школы';
    const project = ctx.state.projects.find((p) => p.id === ctx.state.projectId);
    const subtitle = data
      ? listId
        ? `${list?.consentTitle || ''} · ${plural(data.counts.total, ADDRESSES)}`
        : `${project?.title || ''} · ${plural(data.counts.total, ['человек', 'человека', 'человек'])}`
      : '';

    const exportLink = el('a', 'btn btn--quiet');
    exportLink.href = api.mailExportUrl(listId);
    exportLink.setAttribute('download', '');
    exportLink.title = 'Таблица для Excel: кириллица откроется без мастера импорта';
    exportLink.append(icon('download', { size: 16 }), el('span', null, 'Выгрузить CSV'));

    const actions = [];
    if (listId && list && !list.archivedAt) {
      actions.push(
        button('Добавить адрес', { variant: 'quiet', iconName: 'plus', onClick: () => openAddForm() }),
        button('Загрузить', { variant: 'quiet', iconName: 'upload', onClick: () => (location.hash = `#/mail/import/new?list=${listId}`) })
      );
    }
    actions.push(exportLink);
    if (listId && list) actions.push(button('Изменить базу', { variant: 'quiet', iconName: 'settings', onClick: () => openListForm() }));
    ctx.setTopbar({ title, subtitle, actions });
  }

  /* ----------------------------- фильтры ----------------------------- */

  function renderTools() {
    if (tools.childNodes.length) {
      // Поле поиска не перерисовываем: иначе курсор улетает посреди набора.
      tools.querySelector('.chips')?.replaceWith(statusChips());
      return;
    }
    const sort = select(SORTS, filters.sort);
    sort.classList.add('jtools__platform');
    sort.setAttribute('aria-label', 'Порядок');
    sort.addEventListener('change', () => applyFilters({ sort: sort.value }));

    const search = el('label', 'search jtools__search');
    search.append(icon('search', { size: 15, className: 'search__icon' }));
    const q = input(filters.q, { type: 'search', placeholder: 'Адрес или имя' });
    q.setAttribute('aria-label', 'Поиск по базе');
    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => applyFilters({ q: q.value.trim() }), 300);
    });
    search.append(q);

    tools.append(statusChips(), sort, search);
  }

  function statusChips() {
    const c = data.counts;
    const chips = el('div', 'chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Состояние');
    for (const [id, text, count] of [
      ['', 'Все', c.total],
      ['active', 'Активные', c.active],
      ['unsubscribed', 'Отписались', c.unsubscribed],
      ['undeliverable', 'Не доставить', c.undeliverable],
    ]) {
      chips.append(chip(`${text} ${num(count)}`, filters.status === id, () => applyFilters({ status: id })));
    }
    return chips;
  }

  /* --------------------------- отмеченные строки --------------------------- */

  function renderBulk() {
    bulkHost.textContent = '';
    if (!selected.size) return;
    const bar = el('div', 'mail-bulk');
    bar.append(el('span', 'mail-bulk__count', `Отмечено: ${num(selected.size)}`));

    const targets = lists.filter((l) => l.id !== listId && !l.archivedAt);
    if (targets.length) {
      const target = select([['', 'В базу…'], ...targets.map((l) => [String(l.id), l.name])], '');
      target.setAttribute('aria-label', 'База для копирования');
      bar.append(target);
      bar.append(small(button('Скопировать', { onClick: () => (target.value ? runBulk('copy', { targetListId: Number(target.value) }) : toast('Сначала выберите базу')) })));
      if (listId) {
        bar.append(small(button('Перенести', { onClick: () => (target.value ? runBulk('move', { targetListId: Number(target.value) }) : toast('Сначала выберите базу')) })));
      }
    }
    if (listId) bar.append(small(button('Убрать из базы', { onClick: () => runBulk('remove') })));
    bar.append(
      small(
        button('Отписать', {
          onClick: () =>
            ask(bulkHost, {
              placeholder: 'Причина — необязательно, например: попросили по телефону',
              confirmLabel: 'Отписать',
              onConfirm: (note) => runBulk('unsubscribe', { note }),
            }),
        })
      ),
      small(button('Адреса нет', { title: 'Письма на эти адреса возвращаются — отметить недоставляемыми', onClick: () => runBulk('bounced') })),
      small(button('Снять отметки', { variant: 'quiet', onClick: () => (selected.clear(), renderBulk(), renderTable()) }))
    );
    bulkHost.append(bar);
  }

  function small(b) {
    b.classList.add('btn--sm');
    return b;
  }

  async function runBulk(action, extra = {}) {
    try {
      const { done } = await api.mailBulk({ ids: [...selected], action, listId, ...extra });
      const word = {
        copy: 'скопировано',
        move: 'перенесено',
        remove: 'убрано из базы',
        unsubscribe: 'отписано',
        bounced: 'отмечено «адреса нет»',
      }[action];
      toast(`Готово: ${word} — ${num(done)}`, 'ok');
      selected.clear();
      load();
      loadMeta();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /* ------------------------------- таблица ------------------------------- */

  function renderTable() {
    tableHost.textContent = '';
    if (!data.contacts.length) {
      const filtered = filters.q || filters.status;
      tableHost.append(
        filtered
          ? empty('search', 'Под фильтр никто не попал', 'Попробуйте другое состояние или слово.', button('Сбросить фильтр', { onClick: () => applyFilters({ q: '', status: '' }) }))
          : empty(
              'mail',
              'В базе пока пусто',
              'Загрузите файл или добавьте адрес вручную.',
              listId ? button('Загрузить адреса', { variant: 'primary', iconName: 'upload', onClick: () => (location.hash = `#/mail/import/new?list=${listId}`) }) : null
            )
      );
      return;
    }

    const columns = listId ? (data.list?.columns || []).slice(0, VISIBLE_COLUMNS) : [];
    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table mail-table');
    const thead = el('thead');
    const hr = el('tr');

    const all = el('input', 'mail-check');
    all.type = 'checkbox';
    all.setAttribute('aria-label', 'Отметить всех на странице');
    all.checked = data.contacts.every((c) => selected.has(c.id));
    all.addEventListener('change', () => {
      for (const c of data.contacts) all.checked ? selected.add(c.id) : selected.delete(c.id);
      renderBulk();
      renderTable();
    });
    const thCheck = el('th', 'mail-check-cell');
    thCheck.append(all);
    hr.append(thCheck);
    for (const h of ['Адрес', 'Имя', ...columns, 'Состояние', listId ? 'Добавлен' : 'В базах']) hr.append(el('th', null, h));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const contact of data.contacts) tbody.append(row(contact, columns));
    table.append(tbody);
    wrap.append(table);
    tableHost.append(wrap);
  }

  function row(contact, columns) {
    const tr = el('tr');
    if (selected.has(contact.id)) tr.classList.add('mail-row--selected');

    const box = el('input', 'mail-check');
    box.type = 'checkbox';
    box.checked = selected.has(contact.id);
    box.setAttribute('aria-label', `Отметить ${contact.email}`);
    box.addEventListener('change', () => {
      box.checked ? selected.add(contact.id) : selected.delete(contact.id);
      tr.classList.toggle('mail-row--selected', box.checked);
      renderBulk();
    });
    const tdCheck = el('td', 'mail-check-cell');
    tdCheck.append(box);
    tr.append(tdCheck);

    const tdEmail = el('td');
    const open = el('button', 'mail-email', contact.email);
    open.type = 'button';
    open.title = 'Открыть карточку';
    open.addEventListener('click', () => openCard(contact.id));
    tdEmail.append(open);
    tr.append(tdEmail);

    tr.append(el('td', contact.name ? null : 'dim', contact.name || '—'));
    for (const col of columns) tr.append(el('td', 'mail-attr', contact.attrs?.[col] || ''));
    const tdStatus = el('td');
    tdStatus.append(tag(STATUS_TAG[contact.status] || { cls: '', text: contact.statusTitle }));
    tr.append(tdStatus);
    tr.append(el('td', 'table__time', listId ? day(contact.addedAt) : num(contact.listsCount)));
    return tr;
  }

  function renderPager() {
    pagerHost.textContent = '';
    if (!data.total) return;
    const from = (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.page * data.pageSize, data.total);
    pagerHost.append(el('span', 'num', `${num(from)}–${num(to)} из ${num(data.total)}`));
    if (data.pages > 1) {
      const prev = iconButton('chevronLeft', { title: 'Предыдущая страница', onClick: () => applyFilters({ page: data.page - 1 }, { keepPage: true }) });
      const next = iconButton('chevronRight', { title: 'Следующая страница', onClick: () => applyFilters({ page: data.page + 1 }, { keepPage: true }) });
      prev.disabled = data.page <= 1;
      next.disabled = data.page >= data.pages;
      pagerHost.append(prev, next);
    }
  }

  /* ------------------------------ карточка ------------------------------ */

  async function openCard(id) {
    let contact;
    try {
      ({ contact } = await api.mailContact(id));
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    cardHost.textContent = '';
    const card = panel(null);
    card.classList.add('mail-card');

    const head = el('div', 'panel__head');
    head.append(el('h2', 'mail-card__title', contact.email), tag(STATUS_TAG[contact.status] || { text: contact.statusTitle }));
    head.append(el('span', 'spacer'), iconButton('x', { title: 'Закрыть карточку', onClick: () => (cardHost.textContent = '') }));
    card.append(head);

    if (contact.suppression) {
      card.append(
        note(
          contact.suppression.reason === 'bounced' ? 'danger' : 'warn',
          `В стоп-листе школы: ${contact.suppression.title}`,
          [contact.suppression.note, `с ${day(contact.suppression.at)}`].filter(Boolean).join(' · ')
        )
      );
    } else if (contact.statusNote) {
      card.append(el('p', 'field__hint', `Заметка: ${contact.statusNote}`));
    }

    const form = el('form', 'mail-card__grid');
    const name = input(contact.name, { placeholder: 'Как обращаться в письме' });
    const email = input(contact.email, { type: 'email' });
    const save = button('Сохранить', { variant: 'primary' });
    save.type = 'submit';
    const saveBox = el('div', 'mail-actions mail-actions--end');
    saveBox.append(save);
    form.append(field('Имя', name), field('Адрес', email, 'Правка адреса проверяется так же, как загрузка'), saveBox);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        await api.updateMailContact(contact.id, { name: name.value, email: email.value });
        toast('Сохранено', 'ok');
        openCard(contact.id);
        load();
      } catch (err) {
        toast(err.message, 'danger');
        save.disabled = false;
      }
    });
    card.append(form);

    card.append(el('div', 'eyebrow', 'Базы'));
    const memberships = el('div', 'mail-members');
    for (const m of contact.memberships) {
      const item = el('div', `mail-member${m.removedAt ? ' mail-member--removed' : ''}`);
      const link = el('a', 'mail-name', m.listName);
      link.href = `#/mail/lists/${m.listId}`;
      item.append(link, el('span', 'dim small', m.consentTitle), el('span', 'dim small', `${m.source}, ${day(m.addedAt)}`));
      if (m.removedAt) item.append(el('span', 'tag', 'убран из базы'));
      const attrs = Object.entries(m.attrs || {});
      if (attrs.length) item.append(el('div', 'mail-attrs', attrs.map(([k, v]) => `${k}: ${v}`).join(' · ')));
      memberships.append(item);
    }
    if (!contact.memberships.length) memberships.append(el('p', 'field__hint', 'Ни в одной базе — остался только в «Всех контактах».'));
    card.append(memberships);

    const actions = el('div', 'mail-actions');
    const askHost = el('div');
    if (contact.status === 'active') {
      actions.append(
        button('Отписать', {
          iconName: 'lock',
          onClick: () =>
            ask(askHost, {
              placeholder: 'Причина — например: попросил по телефону',
              confirmLabel: 'Отписать',
              onConfirm: (note) => contactBulk(contact, 'unsubscribe', note),
            }),
        }),
        button('Адреса нет', { onClick: () => contactBulk(contact, 'bounced') })
      );
    } else {
      actions.append(
        button('Вернуть подписку', {
          iconName: 'unlock',
          onClick: () =>
            ask(askHost, {
              placeholder: 'Почему — обязательно, например: написал сам, хочет письма',
              confirmLabel: 'Вернуть',
              required: true,
              onConfirm: async (note) => {
                try {
                  await api.resubscribeMailContact(contact.id, note);
                  toast('Подписка возвращена', 'ok');
                  openCard(contact.id);
                  load();
                } catch (err) {
                  toast(err.message, 'danger');
                }
              },
            }),
        })
      );
    }
    actions.append(el('span', 'spacer'), button('Стереть по просьбе', { variant: 'danger', iconName: 'trash', onClick: () => erase(contact) }));
    card.append(actions, askHost);

    cardHost.append(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function contactBulk(contact, action, note = '') {
    try {
      await api.mailBulk({ ids: [contact.id], action, listId, note });
      toast(action === 'bounced' ? 'Отмечено: адреса нет' : 'Отписан', 'ok');
      openCard(contact.id);
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function erase(contact) {
    const sure = confirm(
      `Стереть ${contact.email}?\n\nЧеловек исчезнет из всех баз школы. Адрес останется в стоп-листе хешем — чтобы следующая загрузка его не вернула. Отменить нельзя.`
    );
    if (!sure) return;
    try {
      await api.eraseMailContact(contact.id);
      toast('Стёрт. Следующая загрузка его не вернёт', 'ok');
      cardHost.textContent = '';
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /* ------------------------------- формы ------------------------------- */

  function openAddForm() {
    cardHost.textContent = '';
    const box = panel('Добавить адрес');
    const form = el('form', 'mail-card__grid');
    const email = input('', { type: 'email', placeholder: 'name@example.com' });
    email.required = true;
    const name = input('', { placeholder: 'Необязательно' });
    const submit = button('Добавить', { variant: 'primary' });
    submit.type = 'submit';
    const actions = el('div', 'mail-actions mail-actions--end');
    actions.append(submit, button('Отмена', { variant: 'quiet', onClick: () => (cardHost.textContent = '') }));
    form.append(field('Адрес', email), field('Имя', name), actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const out = await api.addMailContact({ listId, email: email.value, name: name.value });
        const already = out.membership === 'existed';
        toast(
          already ? 'Этот адрес уже в базе' : out.warnings?.length ? `Добавлен. Внимание: ${out.warnings.join(', ')}` : 'Добавлен',
          already || out.warnings?.length ? '' : 'ok'
        );
        email.value = '';
        name.value = '';
        submit.disabled = false;
        email.focus();
        load();
      } catch (err) {
        toast(err.message, 'danger');
        submit.disabled = false;
      }
    });
    box.append(form);
    cardHost.append(box);
    email.focus();
  }

  function openListForm() {
    const list = data?.list;
    if (!list) return;
    cardHost.textContent = '';
    const box = panel(`База «${list.name}»`);
    const form = el('form', 'mail-form__grid');
    const name = input(list.name);
    name.required = true;
    const basis = select(Object.entries(consentBases), list.consentBasis);
    const consentNote = input(list.consentNote, { placeholder: 'Для «Другого» — обязательно' });
    const description = input(list.description, { placeholder: 'Необязательно' });
    form.append(field('Название', name), field('Откуда адреса', basis), field('Пояснение к основанию', consentNote), field('Описание', description));

    const actions = el('div', 'mail-actions');
    const submit = button('Сохранить', { variant: 'primary' });
    submit.type = 'submit';
    actions.append(
      submit,
      button('Отмена', { variant: 'quiet', onClick: () => (cardHost.textContent = '') }),
      el('span', 'spacer'),
      button(list.archivedAt ? 'Вернуть из архива' : 'Убрать в архив', {
        iconName: list.archivedAt ? 'refresh' : 'archive',
        onClick: async () => {
          if (!list.archivedAt && !confirm(`Убрать «${list.name}» в архив? Адреса останутся в школе, база спрячется из списков.`)) return;
          try {
            await api.updateMailList(list.id, { archived: !list.archivedAt });
            toast(list.archivedAt ? 'База возвращена' : 'База в архиве', 'ok');
            location.hash = '#/mail';
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      })
    );
    form.append(actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api.updateMailList(list.id, {
          name: name.value,
          consentBasis: basis.value,
          consentNote: consentNote.value,
          description: description.value,
        });
        toast('Сохранено', 'ok');
        cardHost.textContent = '';
        load();
      } catch (err) {
        toast(err.message, 'danger');
        submit.disabled = false;
      }
    });
    box.append(form);
    cardHost.append(box);
    name.focus();
  }
}
