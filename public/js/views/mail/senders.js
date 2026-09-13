/**
 * Ящики-отправители: приложение Google, подключение кнопкой, потолок с
 * прогревом, пробное письмо себе, отключение (docs/рассылка.md, фаза 2).
 *
 * Экран отвечает на три вопроса: подключён ли ящик и жив ли доступ, сколько
 * ещё можно отправить за сутки и дошло ли пробное письмо. Всё, что может
 * сломать отправку, — словами и заранее, а не ошибкой посреди рассылки.
 */

import { api } from '../../api.js';
import { el, button, panel, empty, skeleton, toast, note, iconButton } from '../../ui.js';
import { num, day, field, input, mailTabs, ask } from './common.js';

const STATE_TAG = {
  ok: 'tag--ok',
  expiring: 'tag--warn',
  dead: 'tag--danger',
  error: 'tag--danger',
  unknown: '',
  disconnected: '',
};

export function sendersView(ctx) {
  const root = el('div', 'view');
  const project = ctx.state.projects.find((p) => p.id === ctx.state.projectId);
  let data = null;
  let editingApp = false;

  const connectButton = button('Подключить Gmail', { variant: 'primary', iconName: 'mail', onClick: () => connect() });
  ctx.setTopbar({ title: 'Рассылка', subtitle: 'Ящики-отправители', actions: [connectButton] });

  const returnHost = el('div', 'mail-slot');
  const appHost = el('div');
  appHost.append(skeleton(120));
  const sendersHost = el('div');

  const tabs = mailTabs(ctx, 'senders');
  if (tabs) root.append(tabs);
  root.append(returnHost, appHost, sendersHost);

  showOauthReturn();
  load();
  return root;

  /* ------------------------------ данные ------------------------------ */

  async function load() {
    try {
      data = await api.mailSenders();
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    connectButton.disabled = !(data.app.clientId && data.app.hasSecret);
    connectButton.title = connectButton.disabled ? 'Сначала впишите ID и секрет приложения Google' : '';
    renderApp();
    renderSenders();
  }

  /** Возврат из окна Google: результат приходит в адресе, показываем и убираем из адреса. */
  function showOauthReturn() {
    const params = new URLSearchParams(location.search);
    if (params.get('oauth') !== 'google') return;
    if (params.get('result') === 'ok') {
      returnHost.append(
        note(
          'ok',
          `Ящик ${params.get('email') || ''} подключён`,
          params.get('temporary')
            ? 'Но Google выдал временный доступ — так бывает, когда приложение в режиме Testing. Переведите его в In production и подключите ящик заново, иначе через 7 дней отправка встанет.'
            : 'Отправьте пробное письмо себе и проверьте, что оно пришло во «Входящие», а не в «Спам».'
        )
      );
    } else {
      returnHost.append(note('danger', 'Ящик не подключён', params.get('message') || 'Google вернул ошибку'));
    }
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }

  /* ------------------------- приложение Google ------------------------- */

  function renderApp() {
    appHost.textContent = '';
    const configured = data.app.clientId && data.app.hasSecret;
    const box = panel(null);
    const head = el('div', 'panel__head');
    head.append(el('h2', null, 'Приложение Google'), el('span', 'spacer'));
    if (configured && !editingApp) {
      head.append(
        button('Изменить', {
          variant: 'quiet',
          onClick: () => {
            editingApp = true;
            renderApp();
          },
        })
      );
    }
    box.append(head);

    if (configured && !editingApp) {
      const facts = el('div', 'mail-facts');
      facts.append(fact('Client ID', `…${data.app.clientId.split('.')[0].slice(-12)}.apps.googleusercontent.com`), fact('Client secret', 'сохранён, зашифрован'));
      box.append(facts);
      appHost.append(box);
      return;
    }

    box.append(
      el(
        'p',
        'field__hint',
        'Из Google Cloud → Google Auth Platform → Clients → ваш клиент «Web application». Секрет хранится зашифрованным и после сохранения не показывается.'
      )
    );
    const form = el('form', 'mail-form__grid mail-app-form');
    const clientId = input(data.app.clientId, { placeholder: '1234567890-abc….apps.googleusercontent.com' });
    clientId.autocomplete = 'off';
    const secret = input('', { type: 'password', placeholder: data.app.hasSecret ? 'сохранён — оставьте пустым, чтобы не менять' : 'GOCSPX-…' });
    secret.autocomplete = 'new-password';
    form.append(field('Client ID', clientId), field('Client secret', secret));

    const redirect = el('div', 'mail-copy');
    redirect.append(el('code', 'mail-copy__value', data.app.redirectUri));
    redirect.append(
      iconButton('copy', {
        title: 'Скопировать адрес возврата',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(data.app.redirectUri);
            toast('Адрес возврата скопирован', 'ok');
          } catch {
            toast('Буфер недоступен — выделите адрес вручную');
          }
        },
      })
    );
    const redirectField = el('div', 'field mail-form__wide');
    redirectField.append(
      el('span', 'field__label', 'Адрес возврата'),
      redirect,
      el('span', 'field__hint', 'Должен до символа совпадать с Authorized redirect URIs у клиента в Google Cloud')
    );
    form.append(redirectField);

    const actions = el('div', 'mail-actions');
    const save = button('Сохранить', { variant: 'primary' });
    save.type = 'submit';
    actions.append(save);
    if (configured) {
      actions.append(
        button('Отмена', {
          variant: 'quiet',
          onClick: () => {
            editingApp = false;
            renderApp();
          },
        })
      );
    }
    form.append(actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        await api.saveGoogleApp({ clientId: clientId.value, clientSecret: secret.value });
        toast('Приложение Google сохранено', 'ok');
        editingApp = false;
        load();
      } catch (err) {
        toast(err.message, 'danger');
        save.disabled = false;
      }
    });
    box.append(form);
    appHost.append(box);
  }

  function fact(label, value, sub = '') {
    const box = el('div', 'mail-fact');
    box.append(el('div', 'eyebrow', label), el('div', 'mail-fact__value', value));
    if (sub) box.append(el('div', 'mail-fact__sub', sub));
    return box;
  }

  /* ------------------------------- ящики ------------------------------- */

  function renderSenders() {
    sendersHost.textContent = '';
    const box = panel('Ящики');
    const live = data.senders.filter((s) => s.state !== 'disconnected');
    const gone = data.senders.filter((s) => s.state === 'disconnected');

    if (!live.length) {
      box.append(
        empty(
          'mail',
          'Ящик не подключён',
          data.app.clientId && data.app.hasSecret
            ? 'Нажмите «Подключить Gmail» и войдите в ящик академии. Google покажет «приложение не проверено» — для своего ящика это нормально: «Дополнительно» → «Перейти». Галочку «Отправлять письма» не снимайте.'
            : 'Сначала впишите выше ID и секрет приложения Google, потом подключите ящик.',
          data.app.clientId && data.app.hasSecret ? button('Подключить Gmail', { variant: 'primary', iconName: 'mail', onClick: () => connect() }) : null
        )
      );
    }
    for (const sender of live) box.append(senderCard(sender));
    if (gone.length) {
      box.append(el('div', 'eyebrow', 'Отключённые'));
      for (const sender of gone) box.append(goneRow(sender));
    }
    sendersHost.append(box);
  }

  function senderCard(sender) {
    const card = el('section', `mail-sender mail-sender--${sender.state}`);

    const head = el('div', 'mail-sender__head');
    const title = el('div', 'mail-sender__title');
    title.append(el('span', 'mail-name', sender.email), el('span', 'dim small', sender.kindTitle));
    head.append(title, el('span', `tag ${STATE_TAG[sender.state] || ''}`, sender.stateTitle));
    card.append(head);

    if (['dead', 'error', 'expiring'].includes(sender.state) && sender.lastError) {
      card.append(note(sender.state === 'expiring' ? 'warn' : 'danger', sender.state === 'dead' ? 'Письма с этого ящика не уйдут' : 'Проверьте ящик', sender.lastError));
    }

    const { cap } = sender;
    const facts = el('div', 'mail-facts');
    const usage = fact('За последние 24 часа', `${num(sender.sent24h)} из ${num(cap.effective)}`, 'окно скользящее, не календарные сутки');
    const meter = el('div', 'meter');
    const fill = el('div', `meter__fill${sender.sent24h >= cap.effective ? ' meter__fill--over' : sender.sent24h > cap.effective * 0.8 ? ' meter__fill--warn' : ''}`);
    fill.style.setProperty('--value', String(Math.min(1, cap.effective ? sender.sent24h / cap.effective : 0)));
    meter.append(fill);
    usage.append(meter);
    facts.append(usage);

    const capSub = cap.warmupCap
      ? `прогрев: день ${cap.warmupDay}, дальше потолок растёт до ${num(cap.panel)}`
      : sender.dailyCap
        ? `свой потолок; у Google — ${num(cap.google)}`
        : `80 % от ${num(cap.google)} у Google — запас на письма, отправленные руками`;
    facts.append(fact('Потолок в сутки', num(cap.effective), capSub));
    facts.append(fact('Окно отправки', `${sender.windowFrom}–${sender.windowTo}`, 'по Киеву'));
    facts.append(
      fact(
        'Доступ выдан',
        day(sender.tokenSavedAt),
        sender.tokenExpiresAt ? `временный — умрёт ${day(sender.tokenExpiresAt)}` : sender.checkedAt ? `проверен ${day(sender.checkedAt)}` : ''
      )
    );
    card.append(facts);

    const actions = el('div', 'mail-actions');
    const askHost = el('div', 'mail-slot');
    const settingsHost = el('div', 'mail-slot');
    if (sender.state === 'dead') {
      actions.append(button('Подключить заново', { variant: 'primary', iconName: 'mail', onClick: () => connect(sender.email) }));
    } else {
      actions.append(
        button('Пробное письмо', {
          iconName: 'send',
          onClick: () =>
            ask(askHost, {
              placeholder: `Кому — через запятую, до ${data.limits.testRecipientsMax}; пусто — на ${sender.email}`,
              confirmLabel: 'Отправить',
              onConfirm: (value) => sendTest(sender, value),
            }),
        }),
        button('Проверить доступ', { variant: 'quiet', iconName: 'refresh', onClick: () => check(sender) })
      );
    }
    actions.append(
      button('Настройки', { variant: 'quiet', iconName: 'settings', onClick: () => openSettings(sender, settingsHost) }),
      el('span', 'spacer'),
      button('Отключить', { variant: 'danger', onClick: () => disconnect(sender) })
    );
    card.append(actions, askHost, settingsHost);
    return card;
  }

  function goneRow(sender) {
    const row = el('div', 'mail-member mail-member--removed');
    row.append(el('span', 'mail-name', sender.email), el('span', 'dim small', `отключён ${day(sender.disconnectedAt)}`));
    const again = button('Подключить заново', { variant: 'quiet', onClick: () => connect(sender.email) });
    again.classList.add('btn--sm');
    row.append(again);
    return row;
  }

  function openSettings(sender, host) {
    if (host.childNodes.length) {
      host.textContent = '';
      return;
    }
    const form = el('form', 'mail-form__grid mail-sender__settings');
    const name = input(sender.displayName, { placeholder: project?.title || 'Название школы' });
    const cap = input(sender.dailyCap ?? '', { type: 'number', placeholder: String(sender.cap.panel) });
    cap.min = '1';
    cap.max = String(sender.cap.google);
    const from = input(sender.windowFrom, { type: 'time' });
    const to = input(sender.windowTo, { type: 'time' });
    const warmup = el('label', 'check mail-form__wide');
    const warmBox = el('input', 'mail-check');
    warmBox.type = 'checkbox';
    warmBox.checked = sender.warmup;
    warmup.append(warmBox, el('span', null, 'Прогрев: первые три недели потолок растёт с 50 писем в сутки. Для нового ящика не выключайте'));

    form.append(
      field('Имя отправителя', name, 'Пусто — название школы, из которой отправляется письмо'),
      field('Свой потолок в сутки', cap, `Пусто — 80 % от ${sender.cap.google}`),
      field('Отправлять с', from),
      field('до', to),
      warmup
    );
    const actions = el('div', 'mail-actions');
    const save = button('Сохранить', { variant: 'primary' });
    save.type = 'submit';
    actions.append(save, button('Отмена', { variant: 'quiet', onClick: () => (host.textContent = '') }));
    form.append(actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        await api.updateMailSender(sender.id, {
          displayName: name.value,
          dailyCap: cap.value === '' ? null : Number(cap.value),
          warmup: warmBox.checked,
          windowFrom: from.value,
          windowTo: to.value,
        });
        toast('Настройки ящика сохранены', 'ok');
        load();
      } catch (err) {
        toast(err.message, 'danger');
        save.disabled = false;
      }
    });
    host.append(form);
    name.focus();
  }

  /* ------------------------------ действия ------------------------------ */

  async function connect(loginHint = '') {
    try {
      const { url } = await api.startGoogleOauth(loginHint);
      location.href = url;
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function sendTest(sender, value) {
    const to = value
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const out = await api.testMailSender(sender.id, to);
      if (out.sent.length) {
        toast(`Ушло на ${out.sent.map((s) => s.email).join(', ')} — проверьте «Входящие» и «Спам»`, 'ok');
      }
      if (out.failed.length) toast(`Не ушло: ${out.failed[0].email} — ${out.failed[0].error}`, 'danger');
    } catch (err) {
      toast(err.message, 'danger');
    }
    load();
  }

  async function check(sender) {
    try {
      const { sender: fresh } = await api.checkMailSender(sender.id);
      toast(fresh.state === 'ok' ? 'Доступ к Gmail работает' : fresh.lastError || fresh.stateTitle, fresh.state === 'ok' ? 'ok' : 'danger');
    } catch (err) {
      toast(err.message, 'danger');
    }
    load();
  }

  async function disconnect(sender) {
    const sure = confirm(`Отключить ${sender.email}?\n\nПанель отзовёт доступ у Google и больше не сможет отправлять письма с этого ящика. Подключить заново можно в любой момент.`);
    if (!sure) return;
    try {
      await api.disconnectMailSender(sender.id);
      toast('Ящик отключён', 'ok');
    } catch (err) {
      toast(err.message, 'danger');
    }
    load();
  }
}
