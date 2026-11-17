/**
 * «Входящие»: переписка Direct и Messenger (docs/бот.md, §5a).
 *
 * Слева — диалоги: кто ведёт (бот или человек), сколько осталось от окна
 * 24 часов, непрочитанное и почему диалог ждёт человека. Справа — лента и
 * ответ. Ответ из панели забирает диалог у бота; вернуть — кнопкой.
 * В режиме «только черновики» готовый ответ бота уходит одной кнопкой.
 *
 * На телефоне колонки не помещаются: список и лента показываются по очереди.
 */

import { api } from '../../api.js';
import { el, button, note, empty, toast, projectTabs } from '../../ui.js';
import { icon } from '../../icons.js';

const SOURCE_TITLE = { customer: 'Клиент', bot: 'Бот', human: 'Человек' };
const STEP_TITLE = {
  start: 'новый',
  ask_age: 'спросили возраст',
  trial: 'предложили пробное',
  contacts: 'ждём контакты',
  birthday: 'младше 6',
  abroad: 'за границей',
  done: 'передан',
};
const TAG_TITLE = { client: 'наш клиент', child: 'пишет ребёнок', adult: 'взрослый', abroad: 'за границей', offline: 'офлайн', certificate: 'сертификат', two_kids: 'двое детей' };
const POLL_MS = 8000;

function windowLeft(msLeft) {
  if (msLeft <= 0) return { text: 'окно закрыто', cls: 'tag--danger' };
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  return { text: h ? `окно ${h} ч ${m} мин` : `окно ${m} мин`, cls: h < 3 ? 'tag--warn' : 'tag--ok' };
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function inboxView(ctx, { tabs } = {}) {
  const box = el('div', 'view');
  let list = null;
  let current = null; // { dialog, messages }
  let openId = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('d')) || null;
  let busy = false;

  ctx.setTopbar({
    title: 'Бот-консультант',
    subtitle: 'Входящие: переписка Direct и Messenger',
    actions: [button('Настройки бота', { iconName: 'settings', onClick: () => (location.hash = '#/bot/settings') })],
  });

  box.append(projectTabs({ projects: ctx.state.projects, current: ctx.state.projectId, onPick: (id) => ctx.switchProject(id) }));
  if (tabs) box.append(tabs);

  const host = el('div', 'stack');
  box.append(host);
  load();

  // Новые сообщения приходят вебхуком — список перечитывается сам, пока экран открыт.
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    if (!busy && document.visibilityState === 'visible') load({ quiet: true });
  }, POLL_MS);

  return box;

  async function load({ quiet = false } = {}) {
    if (!quiet) {
      host.textContent = '';
      host.append(el('p', 'field__hint', 'Читаю переписку…'));
    }
    try {
      // Сначала лента: её чтение снимает «непрочитано», и список уже это видит.
      if (openId) current = await api.botDialog(openId);
      list = await api.botDialogs();
    } catch (err) {
      if (quiet) return;
      host.textContent = '';
      host.append(note('danger', 'Переписка не прочиталась', err.message));
      return;
    }
    render();
  }

  function render() {
    // Не перерисовываем под пальцами: набранный ответ не должен пропасть.
    const typing = host.querySelector('.inbox-reply textarea');
    const draft = typing ? typing.value : '';
    const focused = typing && document.activeElement === typing;
    host.textContent = '';
    if (!list.settings.enabled) {
      host.append(note('warn', 'Бот выключен', 'Переписка собирается, но клиенту бот ничего не пишет. Отвечайте отсюда или из приложения Instagram.'));
    } else if (!list.settings.autoReply) {
      host.append(note('info', 'Режим черновиков', 'Бот готовит ответ, отправляет его человек — кнопкой «Отправить ответ бота».'));
    }
    const layout = el('div', `inbox${openId ? ' inbox--open' : ''}`);
    layout.append(listPane(), threadPane());
    host.append(layout);
    if (draft) {
      const t = host.querySelector('.inbox-reply textarea');
      if (t) {
        t.value = draft;
        if (focused) t.focus();
      }
    }
  }

  function listPane() {
    const pane = el('div', 'inbox__list');
    if (!list.dialogs.length) {
      pane.append(empty('chat', 'Переписки пока нет', 'Сообщения появятся, когда Meta начнёт присылать их на вебхук панели.'));
      return pane;
    }
    for (const d of list.dialogs) {
      const item = el('button', `inbox-item${d.id === openId ? ' inbox-item--on' : ''}${d.unread ? ' inbox-item--unread' : ''}`);
      item.type = 'button';
      const head = el('div', 'inbox-item__head');
      head.append(icon(d.channel === 'messenger' ? 'facebook' : 'instagram', { size: 15 }));
      head.append(el('span', 'inbox-item__who', d.who));
      if (d.unread) head.append(el('span', 'inbox-item__unread', String(d.unread)));
      head.append(el('span', 'inbox-item__time', when(d.lastMessageAt)));
      item.append(head);
      if (d.last) item.append(el('div', 'inbox-item__last', `${d.last.source === 'customer' ? '' : SOURCE_TITLE[d.last.source] + ': '}${d.last.text || '[вложение]'}`));
      const tags = el('div', 'inbox-item__tags');
      tags.append(el('span', `tag ${d.handledBy === 'bot' ? 'tag--gold' : ''}`, d.handledBy === 'bot' ? 'ведёт бот' : 'ведёт человек'));
      const w = windowLeft(d.windowLeftMs);
      tags.append(el('span', `tag ${w.cls}`, w.text));
      if (d.attention) tags.append(el('span', 'tag tag--warn', 'ждёт человека'));
      item.append(tags);
      item.addEventListener('click', () => open(d.id));
      pane.append(item);
    }
    return pane;
  }

  async function open(id) {
    openId = id;
    history.replaceState(null, '', `#/bot/inbox?d=${id}`);
    try {
      current = await api.botDialog(id);
      list = await api.botDialogs();
    } catch (err) {
      toast(err.message, 'danger');
    }
    render();
  }

  function back() {
    openId = null;
    current = null;
    history.replaceState(null, '', '#/bot/inbox');
    render();
  }

  function threadPane() {
    const pane = el('div', 'inbox__thread');
    if (!openId || !current) {
      pane.append(empty('chat', 'Выберите диалог', 'Слева — все разговоры проекта. Жёлтая метка — диалог ждёт человека.'));
      return pane;
    }
    const d = current.dialog;

    const head = el('div', 'inbox-head');
    const backBtn = button('', { iconName: 'x', variant: 'quiet', title: 'К списку', onClick: back });
    backBtn.classList.add('inbox-head__back');
    head.append(backBtn);
    const title = el('div', 'inbox-head__title');
    title.append(el('div', 'inbox-head__who', d.who));
    const facts = [STEP_TITLE[d.step] || d.step];
    if (d.childAge) facts.push(`возраст ${d.childAge}`);
    if (d.lang) facts.push(d.lang === 'ru' ? 'пишет по-русски' : 'пишет українською');
    for (const t of d.tags) facts.push(TAG_TITLE[t] || t);
    title.append(el('div', 'inbox-head__facts', facts.join(' · ')));
    head.append(title);
    const w = windowLeft(d.windowLeftMs);
    head.append(el('span', `tag ${w.cls}`, w.text));
    pane.append(head);

    if (d.attention) pane.append(note('warn', 'Ждёт человека', d.attention));
    if (d.phone) {
      const lead = d.lead;
      const leadText = !lead ? 'заявка ещё не создавалась'
        : lead.status === 'sent' ? `заявка в CRM школы${lead.id ? ' #' + lead.id : ''}`
        : lead.status === 'no_access' ? 'заявка не создана: нет ключа записи в «Настройках → Связь с заявками школы»'
        : `заявка не создана: ${lead.error || 'ошибка'}`;
      const c = note(lead?.status === 'sent' ? 'ok' : 'info', `Контакты: ${d.phone}${d.preferredTime ? ' · ' + d.preferredTime : ''}`, leadText);
      if (lead && lead.status !== 'sent') {
        c.querySelector('.note__body').append(button('Повторить заявку', { variant: 'quiet', onClick: () => act(() => api.botDialogLead(d.id), 'Заявка отправлена') }));
      }
      pane.append(c);
    }

    const feed = el('div', 'inbox-feed');
    for (const m of current.messages) {
      const msg = el('div', `inbox-msg inbox-msg--${m.source}`);
      msg.append(el('div', 'inbox-msg__text', m.text || (m.meta?.attachments ? `[${m.meta.attachments.join(', ')}]` : '')));
      msg.append(el('div', 'inbox-msg__meta', `${SOURCE_TITLE[m.source]} · ${when(m.at)}`));
      feed.append(msg);
    }
    pane.append(feed);
    requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));

    if (d.draftText) {
      const dr = el('div', 'inbox-draft');
      dr.append(el('div', 'inbox-draft__label', 'Ответ бота — черновик'));
      dr.append(el('div', 'inbox-draft__text', d.draftText));
      const row = el('div', 'bot-actions');
      if (list.settings.autoReply === false && d.handledBy === 'bot') {
        row.append(button('Отправить ответ бота', { variant: 'primary', iconName: 'send', onClick: () => act(() => api.botDialogSendDraft(d.id), 'Ответ отправлен') }));
      }
      row.append(button('Взять в поле ответа', { variant: 'quiet', onClick: () => {
        const t = pane.querySelector('.inbox-reply textarea');
        t.value = d.draftText;
        t.focus();
      } }));
      dr.append(row);
      pane.append(dr);
    }

    const reply = el('div', 'inbox-reply');
    const area = el('textarea', 'textarea');
    area.rows = 3;
    area.maxLength = 1000;
    area.placeholder = d.windowLeftMs > 0 ? 'Ответ клиенту — после него диалог ведёте вы' : 'Окно 24 часа закрыто — ответьте из приложения Instagram';
    area.disabled = d.windowLeftMs <= 0;
    reply.append(area);
    const actions = el('div', 'bot-actions');
    actions.append(button('Отправить', { variant: 'primary', iconName: 'send', disabled: d.windowLeftMs <= 0, onClick: () => {
      const text = area.value.trim();
      if (!text) return toast('Напишите ответ', 'warn');
      act(() => api.botDialogReply(d.id, text), 'Отправлено — диалог ведёте вы', () => (area.value = ''));
    } }));
    if (d.handledBy === 'human') {
      actions.append(button('Вернуть боту', { variant: 'quiet', iconName: 'refresh', onClick: () => act(() => api.botDialogReturn(d.id), 'Диалог снова ведёт бот') }));
    }
    reply.append(actions);
    pane.append(reply);
    return pane;
  }

  async function act(fn, ok, after) {
    if (busy) return;
    busy = true;
    try {
      current = await fn();
      if (after) after();
      list = await api.botDialogs();
      toast(ok, 'ok');
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      busy = false;
    }
    render();
  }
}
