/**
 * Письма школы: что в работе, что ждёт согласования, что разослано.
 *
 * Строка отвечает на вопросы, с которыми сюда приходят: что это за письмо,
 * в каком оно состоянии, кому уйдёт и проверено ли пробным письмом. Новое
 * письмо создаётся сразу с образца и открывается в редакторе.
 */

import { api } from '../../api.js';
import { el, button, iconButton, panel, empty, skeleton, toast } from '../../ui.js';
import { num, day, plural, mailTabs, CAMPAIGN_TAG, ADDRESSES } from './common.js';

const time = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function campaignsView(ctx) {
  const root = el('div', 'view');
  const project = ctx.state.projects.find((p) => p.id === ctx.state.projectId);
  const createButton = button('Новое письмо', { variant: 'primary', iconName: 'plus', onClick: () => create() });
  ctx.setTopbar({ title: 'Рассылка', subtitle: `Письма · ${project?.title || ''}`, actions: [createButton] });

  const host = panel(null);
  host.append(skeleton(48), skeleton(48));
  let pollTimer = null;
  root.append(mailTabs(ctx, 'letters'), host);
  load();
  return root;

  async function load() {
    let data;
    try {
      data = await api.mailCampaigns();
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    render(data.campaigns);
  }

  function render(campaigns) {
    host.textContent = '';
    // Идущая рассылка — счётчики обновляются сами, пока экран открыт.
    clearTimeout(pollTimer);
    if (campaigns.some((c) => ['scheduled', 'sending'].includes(c.status))) {
      pollTimer = setTimeout(() => root.isConnected && load(), 15000);
    }
    if (!campaigns.length) {
      host.append(
        empty(
          'mail',
          'Писем пока нет',
          'Новое письмо откроется с образца в фирменном оформлении: замените текст, загрузите картинки, выберите базы и отправьте себе пробное.',
          button('Написать письмо', { variant: 'primary', iconName: 'plus', onClick: () => create() })
        )
      );
      return;
    }

    const head = el('div', 'panel__head');
    head.append(el('h2', null, 'Письма'), el('span', 'spacer'), el('span', 'dim small', plural(campaigns.length, ['письмо', 'письма', 'писем'])));
    host.append(head);

    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table mail-table');
    const hr = el('tr');
    for (const [text, cls] of [
      ['Письмо', ''],
      ['Состояние', ''],
      ['Базы', ''],
      ['Адресатов', 'mail-num'],
      ['Изменено', ''],
      ['', ''],
    ]) {
      hr.append(el('th', cls, text));
    }
    const thead = el('thead');
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const c of campaigns) tbody.append(row(c));
    table.append(tbody);
    wrap.append(table);
    host.append(wrap);
  }

  function row(c) {
    const tr = el('tr');

    const tdName = el('td', 'mail-name-cell');
    const a = el('a', 'mail-name', c.title || 'Без названия');
    a.href = `#/mail/letter/${c.id}`;
    tdName.append(a, el('div', 'mail-sub', c.subject ? `Тема: ${c.subject}` : 'тема не написана'));
    tr.append(tdName);

    const tdState = el('td');
    const stateBox = el('div', 'mail-state');
    stateBox.append(el('span', `tag ${CAMPAIGN_TAG[c.status] || ''}`.trim(), c.statusTitle));
    // «Проверено» — только для писем, которые ещё правят: у разосланного
    // пробное письмо уже ничего не решает.
    if (['draft', 'review'].includes(c.status)) {
      stateBox.append(el('span', `mail-sub${c.testedCurrent ? ' mail-sub--ok' : ''}`, c.testedCurrent ? 'пробное письмо этой версии ушло' : 'пробного письма этой версии нет'));
    }
    if (c.status === 'scheduled') stateBox.append(el('span', 'mail-sub', `начнётся ${day(c.scheduledAt)} в ${time(c.scheduledAt)}`));
    if (c.progress) {
      const p = c.progress;
      const done = p.sent + p.failed + p.skipped + p.unknown + p.cancelled;
      const meter = el('div', 'meter mail-list-meter');
      const fill = el('div', 'meter__fill');
      fill.style.setProperty('--value', String(p.total ? done / p.total : 0));
      meter.append(fill);
      const bad = [p.failed && `не ушло ${num(p.failed)}`, p.unknown && `неизвестно ${num(p.unknown)}`].filter(Boolean).join(', ');
      stateBox.append(meter, el('span', 'mail-sub', `ушло ${num(p.sent)} из ${num(p.total)}${bad ? ` · ${bad}` : ''}`));
      if (c.status === 'sending' && c.delivery?.forecast) stateBox.append(el('span', 'mail-sub', `закончится ~${day(c.delivery.forecast.finishAt)} в ${time(c.delivery.forecast.finishAt)}`));
      if (c.status === 'paused' && c.pauseReason) stateBox.append(el('span', 'mail-sub mail-sub--warn', c.pauseReason));
    }
    tdState.append(stateBox);
    tr.append(tdState);

    tr.append(el('td', 'mail-sub-cell', c.lists.length ? c.lists.join(', ') : '—'));
    const tdAudience = el('td', 'mail-num num');
    tdAudience.append(c.lists.length ? el('b', null, num(c.audience)) : el('span', 'dim', '—'));
    if (c.lists.length) tdAudience.title = plural(c.audience, ADDRESSES);
    tr.append(tdAudience);
    tr.append(el('td', 'table__time', day(c.updatedAt)));

    const tdActions = el('td');
    const actions = el('div', 'mail-row-actions');
    actions.append(
      iconButton('copy', { title: 'Сделать копию — с теми же картинками и базами', onClick: () => copy(c) }),
      iconButton('trash', { title: 'Убрать письмо', onClick: () => remove(c) })
    );
    tdActions.append(actions);
    tr.append(tdActions);
    return tr;
  }

  async function create() {
    createButton.disabled = true;
    try {
      const { campaign } = await api.createMailCampaign();
      location.hash = `#/mail/letter/${campaign.id}`;
    } catch (err) {
      toast(err.message, 'danger');
      createButton.disabled = false;
    }
  }

  async function copy(c) {
    try {
      const { campaign } = await api.createMailCampaign(c.id);
      toast(`Копия «${c.title}» создана`, 'ok');
      location.hash = `#/mail/letter/${campaign.id}`;
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function remove(c) {
    if (!confirm(`Убрать письмо «${c.title}»?\n\nОно пропадёт из списка; разосланные копии у получателей останутся.`)) return;
    try {
      await api.deleteMailCampaign(c.id);
      toast('Письмо убрано', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
}
