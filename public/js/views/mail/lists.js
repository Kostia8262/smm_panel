/**
 * Базы школы: сколько людей, в каком они состоянии, откуда адреса.
 *
 * Сверху четыре ответа за один взгляд — сколько адресов, сколько отписались,
 * сколько не доставить, сколько баз. Ниже таблица баз. СММщик видит те же
 * названия и цифры, но не адреса: ему достаточно выбрать базу для письма.
 */

import { api } from '../../api.js';
import { el, button, iconButton, panel, empty, skeleton, toast, note } from '../../ui.js';
import { tile, num, day, plural, field, input, select, chip, mailTabs, tag, ADDRESSES } from './common.js';

export function listsView(ctx) {
  const root = el('div', 'view');
  const project = ctx.state.projects.find((p) => p.id === ctx.state.projectId);
  const canManage = ctx.can('mail_contacts');
  let archived = false;
  let data = null;

  ctx.setTopbar({
    title: 'Рассылка',
    subtitle: `Базы адресов · ${project?.title || ''}`,
    actions: canManage
      ? [
          button('Возвраты писем', { variant: 'quiet', iconName: 'alert', onClick: () => openBounces() }),
          button('Новая база', { variant: 'quiet', iconName: 'plus', onClick: () => openForm() }),
          button('Загрузить базу', { variant: 'primary', iconName: 'upload', onClick: () => (location.hash = '#/mail/import/new') }),
        ]
      : [],
  });

  const pendingHost = el('div', 'stack mail-slot');
  const summaryHost = el('div', 'jsum');
  for (let i = 0; i < 4; i++) summaryHost.append(skeleton(86));
  const listsHost = panel(null);
  listsHost.append(skeleton(48), skeleton(48));

  // Беда с ящиком видна там, где владелец бывает, — на базах, а не только
  // на вкладке ящиков, куда заходят раз в месяц.
  const alertHost = el('div', 'mail-slot');
  const tabs = mailTabs(ctx, 'lists');
  if (tabs) root.append(tabs);
  root.append(alertHost, pendingHost, summaryHost, listsHost);
  if (ctx.can('mail_senders')) {
    api
      .mailSenderAlerts()
      .then((alerts) => {
        if (!alerts.count) return;
        const box = note(
          alerts.worst === 'danger' ? 'danger' : 'warn',
          alerts.worst === 'danger' ? 'Ящик рассылки потерял доступ к Gmail' : 'С ящиком рассылки не всё в порядке',
          'Письма с него не уйдут. Откройте вкладку «Ящики» — там сказано, что случилось и как подключить заново.'
        );
        alertHost.append(box);
      })
      .catch(() => {});
  }
  load();
  return root;

  async function load() {
    try {
      data = await api.mailSummary(archived);
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    renderPending();
    renderSummary();
    renderLists();
  }

  /* ------------------------ брошенные загрузки ------------------------ */

  function renderPending() {
    pendingHost.textContent = '';
    for (const imp of data.pendingImports) {
      const box = note(
        'warn',
        `Загрузка «${imp.sourceName}» ждёт подтверждения`,
        `${plural(imp.rows, ['строка', 'строки', 'строк'])} разобрано ${day(imp.createdAt)}${imp.createdBy ? `, ${imp.createdBy}` : ''}. Пока не подтвердите, в базу ничего не попало; через сутки загрузка сотрётся сама.`
      );
      const actions = el('div', 'mail-actions');
      actions.append(
        button('Продолжить', { variant: 'primary', onClick: () => (location.hash = `#/mail/import/${imp.id}`) }),
        button('Отменить', {
          variant: 'quiet',
          onClick: async () => {
            try {
              await api.discardMailImport(imp.id);
              toast('Загрузка отменена', 'ok');
              load();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
      box.querySelector('.note__body').append(actions);
      pendingHost.append(box);
    }
  }

  /* ------------------------------ сводка ------------------------------ */

  function renderSummary() {
    const s = data.summary;
    summaryHost.textContent = '';
    const undeliverable = s.bounced + s.invalid;
    summaryHost.append(
      tile('Адресов в школе', num(s.total), s.total ? `активных ${num(s.active)}` : 'баз ещё не загружали'),
      tile('Отписались', num(s.unsubscribed), 'в стоп-листе — писем им не будет', s.unsubscribed ? 'warn' : ''),
      tile('Не доставить', num(undeliverable), 'адреса нет или он ошибочный', undeliverable ? 'danger' : ''),
      tile('Баз', num(s.lists), s.lastImportAt ? `последняя загрузка ${day(s.lastImportAt)}` : 'загрузок ещё не было')
    );
  }

  /* ------------------------------- базы ------------------------------- */

  function renderLists() {
    listsHost.textContent = '';
    const head = el('div', 'panel__head');
    head.append(el('h2', null, 'Базы'), el('span', 'spacer'));
    const chips = el('div', 'chips');
    chips.append(
      chip('Действующие', !archived, () => switchArchived(false)),
      chip('С архивом', archived, () => switchArchived(true))
    );
    head.append(chips);
    listsHost.append(head);

    if (!canManage) {
      listsHost.append(
        note('info', 'Адреса баз видит владелец', 'Здесь названия и размеры — этого хватает, чтобы выбрать базу для письма.')
      );
    }

    if (!data.lists.length && !data.summary.total) {
      listsHost.append(
        empty(
          'mail',
          'Баз пока нет',
          'Загрузите таблицу Excel или CSV, контакты из телефона или просто вставьте адреса — панель сама найдёт колонки и проверит каждый адрес.',
          canManage ? button('Загрузить базу', { variant: 'primary', iconName: 'upload', onClick: () => (location.hash = '#/mail/import/new') }) : null
        )
      );
      return;
    }

    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table mail-table');
    const hr = el('tr');
    for (const [text, cls] of [
      ['База', ''],
      ['Основание', ''],
      ['Активных', 'mail-num'],
      ['Отписались', 'mail-num'],
      ['Не доставить', 'mail-num'],
      ['Обновлена', ''],
      ['', ''],
    ]) {
      hr.append(el('th', cls, text));
    }
    const thead = el('thead');
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    const s = data.summary;
    tbody.append(
      row({
        name: 'Все контакты школы',
        sub: 'каждый человек один раз, в скольких бы базах он ни был',
        href: '#/mail/lists/all',
        consent: '—',
        counts: { total: s.total, active: s.active, unsubscribed: s.unsubscribed, bounced: s.bounced, invalid: s.invalid },
        updated: s.lastImportAt,
      })
    );
    for (const list of data.lists) {
      tbody.append(
        row({
          list,
          name: list.name,
          sub: [list.crmSegment ? 'сегмент CRM школы, обновляется сам' : list.description, list.archivedAt ? (list.crmSegment ? 'выключен в админке' : 'в архиве') : '']
            .filter(Boolean)
            .join(' · '),
          href: `#/mail/lists/${list.id}`,
          consent: list.consentTitle,
          counts: list.counts,
          updated: list.lastImportAt || list.createdAt,
          by: list.createdBy,
        })
      );
    }
    table.append(tbody);
    wrap.append(table);
    listsHost.append(wrap);
  }

  function row({ list = null, name, sub, href, consent, counts, updated, by = null }) {
    const tr = el('tr');
    if (list?.archivedAt) tr.classList.add('mail-row--archived');

    const tdName = el('td', 'mail-name-cell');
    if (canManage) {
      const a = el('a', 'mail-name', name);
      a.href = href;
      tdName.append(a);
    } else {
      tdName.append(el('span', 'mail-name', name));
    }
    if (sub) tdName.append(el('div', 'mail-sub', sub));
    tr.append(tdName);

    tr.append(el('td', 'mail-sub-cell', consent));

    const active = el('td', 'mail-num num');
    active.append(el('b', null, num(counts.active)));
    if (counts.total !== counts.active) active.append(el('span', 'dim', ` из ${num(counts.total)}`));
    tr.append(active);
    tr.append(el('td', 'mail-num num', counts.unsubscribed ? num(counts.unsubscribed) : '—'));
    const dead = (counts.bounced || 0) + (counts.invalid || 0);
    tr.append(el('td', 'mail-num num', dead ? num(dead) : '—'));

    const tdUpdated = el('td', 'table__time', day(updated));
    if (by) tdUpdated.title = `завёл: ${by}`;
    tr.append(tdUpdated);

    const tdActions = el('td');
    // Базу сегмента CRM не загружают и не архивируют руками — это делает сверка с админкой.
    if (canManage && list && !list.crmSegment) {
      const actions = el('div', 'mail-row-actions');
      if (!list.archivedAt) {
        actions.append(
          iconButton('upload', {
            title: `Загрузить адреса в «${list.name}»`,
            onClick: () => (location.hash = `#/mail/import/new?list=${list.id}`),
          })
        );
      }
      actions.append(
        iconButton(list.archivedAt ? 'refresh' : 'archive', {
          title: list.archivedAt ? 'Вернуть из архива' : 'Убрать в архив — адреса останутся, база спрячется из списков',
          onClick: () => toggleArchive(list),
        })
      );
      tdActions.append(actions);
    }
    tr.append(tdActions);
    return tr;
  }

  function switchArchived(value) {
    if (archived === value) return;
    archived = value;
    load();
  }

  async function toggleArchive(list) {
    if (!list.archivedAt && !confirm(`Убрать «${list.name}» в архив? Адреса останутся в школе, база спрячется из списков.`)) return;
    try {
      await api.updateMailList(list.id, { archived: !list.archivedAt });
      toast(list.archivedAt ? 'База возвращена' : 'База в архиве', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /* ------------------------------- возвраты ------------------------------- */

  /**
   * «Адрес не найден» приходит письмом в ящик рассылки, а читать ящик панель
   * не может. Владелец вставляет текст возвратов — панель находит адреса своих
   * контактов и после подтверждения отмечает их «адреса нет».
   */
  function openBounces() {
    root.querySelector('.mail-bounces')?.remove();
    const box = panel('Возвраты писем');
    box.classList.add('mail-bounces');
    box.append(
      el(
        'p',
        'field__hint',
        'Откройте в Gmail письма «Адрес не найден» / «Delivery Status Notification», скопируйте их текст целиком и вставьте сюда — можно несколько писем подряд. Служебные адреса и ящик рассылки панель отбросит сама.'
      )
    );
    const area = el('textarea', 'textarea mail-paste');
    area.setAttribute('aria-label', 'Текст писем о недоставке');
    area.placeholder = 'Адрес не найден. Письмо не доставлено на …';
    const actions = el('div', 'mail-actions');
    const find = button('Найти адреса', { variant: 'primary', iconName: 'search' });
    actions.append(find, button('Закрыть', { variant: 'quiet', onClick: () => box.remove() }));
    const resultHost = el('div', 'mail-bounces__list mail-slot');
    box.append(area, actions, resultHost);

    find.addEventListener('click', async () => {
      find.disabled = true;
      let data;
      try {
        data = await api.previewMailBounces(area.value);
      } catch (err) {
        toast(err.message, 'danger');
        find.disabled = false;
        return;
      }
      find.disabled = false;
      renderBounces(resultHost, data, box);
    });

    tabs.after(box);
    area.focus();
  }

  function renderBounces(host, data, box) {
    host.textContent = '';
    if (!data.found.length) {
      host.append(note('info', 'Своих контактов в тексте не нашлось', data.notInBase.length ? `Нашлись чужие адреса: ${data.notInBase.slice(0, 5).join(', ')}${data.notInBase.length > 5 ? '…' : ''}` : 'Проверьте, что вставлен текст самого письма о недоставке.'));
      return;
    }
    const checks = [];
    for (const f of data.found) {
      const row = el('label', 'mail-bounce check');
      const box2 = el('input', 'mail-check');
      box2.type = 'checkbox';
      // По умолчанию отмечены те, кому уходили письма: возврат почти наверняка про них.
      box2.checked = Boolean(f.lastLetter) && f.status === 'active';
      checks.push([box2, f]);
      row.append(box2, el('span', 'mail-name', f.email));
      if (f.name) row.append(el('span', 'dim small', f.name));
      if (f.status !== 'active') row.append(tag({ cls: 'tag--warn', text: 'уже не активен' }));
      row.append(el('span', 'mail-sub', f.lastLetter ? `последнее письмо: «${f.lastLetter.title}», ${day(f.lastLetter.sentAt)}` : 'писем рассылки не получал — возможно, адрес попал в текст случайно'));
      host.append(row);
    }
    if (data.notInBase.length) host.append(el('p', 'field__hint', `Не из баз школы, пропущены: ${plural(data.notInBase.length, ADDRESSES)}.`));
    const actions = el('div', 'mail-actions');
    const apply = button('Отметить «адреса нет»', {
      variant: 'danger',
      onClick: async () => {
        const ids = checks.filter(([c]) => c.checked).map(([, f]) => f.contactId);
        if (!ids.length) return toast('Отметьте хотя бы один адрес', 'danger');
        apply.disabled = true;
        try {
          const { done } = await api.applyMailBounces(ids);
          toast(`Отмечено «адреса нет»: ${done}. Письма рассылок им больше не уйдут`, 'ok');
          box.remove();
          load();
        } catch (err) {
          toast(err.message, 'danger');
          apply.disabled = false;
        }
      },
    });
    actions.append(apply);
    host.append(actions);
  }

  /* ----------------------------- новая база ----------------------------- */

  function openForm() {
    root.querySelector('.mail-form')?.remove();
    const box = panel('Новая база');
    box.classList.add('mail-form');

    const form = el('form', 'mail-form__grid');
    const name = input('', { placeholder: 'Например: Родители учеников 2026' });
    name.required = true;
    const basis = select([['', 'Выберите…'], ...Object.entries(data?.consentBases || {})], '');
    const consentNote = input('', { placeholder: 'Необязательно, для «Другого» — обязательно' });
    const description = input('', { placeholder: 'Необязательно' });

    form.append(
      field('Название', name),
      field('Откуда адреса', basis, 'Без основания слать нельзя'),
      field('Пояснение к основанию', consentNote),
      field('Описание', description)
    );

    const actions = el('div', 'mail-actions');
    const submit = button('Завести базу', { variant: 'primary' });
    submit.type = 'submit';
    actions.append(submit, button('Отмена', { variant: 'quiet', onClick: () => box.remove() }));
    form.append(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { list } = await api.createMailList({
          name: name.value,
          consentBasis: basis.value,
          consentNote: consentNote.value,
          description: description.value,
        });
        toast(`База «${list.name}» заведена`, 'ok');
        location.hash = `#/mail/lists/${list.id}`;
      } catch (err) {
        toast(err.message, 'danger');
        submit.disabled = false;
      }
    });

    box.append(form);
    tabs.after(box);
    name.focus();
  }
}
