/**
 * Редактор письма: конверт, получатели, блоки, проверка — слева; письмо
 * глазами получателя — справа (docs/рассылка.md, §9–10, фаза 3).
 *
 * Путь письма показан шагами: без ошибок → пробное письмо этой версии →
 * утверждено. Утвердить можно только то, что человек видел у себя в почте,
 * поэтому любая правка текста сбрасывает шаги — об этом сказано заранее.
 *
 * Правки сохраняются сами. Форма после сохранения не перерисовывается —
 * иначе курсор прыгал бы посреди слова; обновляются только проверка,
 * шаги и предпросмотр.
 */

import { api } from '../../api.js';
import { el, button, iconButton, panel, skeleton, toast, note, humanBytes } from '../../ui.js';
import { icon } from '../../icons.js';
import { num, day, plural, field, input, select, chip, ask, backLink, tile, CAMPAIGN_TAG, ADDRESSES } from './common.js';

const BLOCKS = {
  hero: { title: 'Главная картинка', hint: 'Рисуйте 1200 × 600 px, JPEG или PNG. В письме займёт 600 × 300 — во всю ширину под шапкой.' },
  eyebrow: { title: 'Надзаголовок', hint: 'Короткая строка капсом над заголовком: «Новий навчальний рік».' },
  heading: { title: 'Заголовок' },
  subheading: { title: 'Подзаголовок' },
  text: { title: 'Текст' },
  bullets: { title: 'Список' },
  button: { title: 'Кнопка' },
  image: { title: 'Картинка в тексте', hint: 'Рисуйте 1200 × 675 px (16:9), JPEG или PNG. В письме займёт 520 × 293.' },
  callout: { title: 'Врезка' },
  divider: { title: 'Разделитель' },
};

/** Порядок кнопок «Добавить»: чаще нужное — первым. */
const ADD_ORDER = ['text', 'heading', 'subheading', 'bullets', 'button', 'image', 'callout', 'eyebrow', 'divider', 'hero'];

const NEW_BLOCK = {
  hero: () => ({ mediaId: null, alt: '', href: '' }),
  eyebrow: () => ({ text: '' }),
  heading: () => ({ text: '' }),
  subheading: () => ({ text: '' }),
  text: () => ({ text: '' }),
  bullets: () => ({ items: [] }),
  button: () => ({ text: 'Детальніше', href: '', note: '' }),
  image: () => ({ mediaId: null, alt: '', href: '' }),
  callout: () => ({ title: '', text: '' }),
  divider: () => ({}),
};

/** Картинка шире не нужна: в письме она 600 px, вдвое — для чётких экранов. */
const IMAGE_MAX_WIDTH = 1200;
/** Файл меньше этого и нужной ширины уходит как есть — без потери качества на пересжатии. */
const KEEP_BYTES = 400 * 1024;
const JPEG_QUALITY = 0.85;

/** Ширина рамки: письмо на компьютере — 600 и поля; телефон — 390, как у айфона. */
const PREVIEW_WIDTH = { desktop: 680, phone: 390 };

const SENDER_STATE = {
  ok: '',
  expiring: 'доступ скоро истечёт',
  dead: 'нет доступа к Gmail',
  error: 'ошибка доступа',
  unknown: 'доступ не проверен',
  disconnected: 'отключён',
};

const SUBJECT_WARN = 60;

export function editorView(ctx, id) {
  const root = el('div', 'view');
  const project = ctx.state.projects.find((p) => p.id === ctx.state.projectId);
  const isOwner = ctx.can('mail_senders');

  let campaign = null;
  let check = null;
  let options = null;
  let draft = null;
  let saveTimer = null;
  let pending = false;
  let chain = Promise.resolve();
  // С телефона письмо и смотрят как на телефоне: уменьшенная копия
  // компьютерной вёрстки на узком экране не читается.
  let device = window.matchMedia('(max-width: 640px)').matches ? 'phone' : 'desktop';
  let previewName = '';
  let previewKey = '';
  let nameTimer = null;
  let contentHeight = 0;
  let resizeObserver = null;
  let delivery = null;
  let pollTimer = null;
  let sendsOpen = false;
  let sendsFilter = '';
  let sendsPage = 1;

  // Узлы, которые обновляются после сохранения, не трогая форму.
  const stateHost = el('div', 'mail-slot');
  const layout = el('div', 'mail-editor');
  const main = el('fieldset', 'mail-editor__main');
  const side = el('div', 'mail-editor__side');
  layout.append(main, side);
  const loading = skeleton(360);

  const subjectHint = el('span', 'field__hint');
  const audienceHost = el('div', 'mail-audience');
  const blocksHost = el('div', 'mail-blocks');
  const addHost = el('div', 'mail-add');
  const checksHost = el('div', 'mail-checks');
  const inbox = el('div', 'mail-inbox');
  const viewport = el('div', 'mail-preview__viewport');
  const sizer = el('div', 'mail-preview__sizer');
  const frame = el('iframe', 'mail-preview__frame');
  const includeHost = el('div', 'mail-picks');
  const excludeHost = el('div', 'mail-picks');
  const senderHint = el('span', 'field__hint');
  const fromNameInput = input('');
  const sendsHost = el('div', 'mail-slot');
  const reportHost = el('div', 'mail-slot');
  let reportRequested = false;

  ctx.setTopbar({ title: 'Рассылка', subtitle: 'Письмо' });
  root.append(backLink('Письма', '#/mail'), stateHost, reportHost, sendsHost, loading);

  window.addEventListener('hashchange', onLeave);
  window.addEventListener('beforeunload', onUnload);
  load();
  return root;

  /* ------------------------------ данные ------------------------------ */

  async function load() {
    let payload;
    try {
      payload = await api.mailCampaign(id);
    } catch (err) {
      toast(err.message, 'danger');
      if (err.status === 404) location.hash = '#/mail';
      return;
    }
    adopt(payload);
    draft = {
      title: campaign.title,
      subject: campaign.subject,
      preheader: campaign.preheader,
      fromName: campaign.fromName,
      replyTo: campaign.replyTo,
      senderId: campaign.senderId,
      blocks: campaign.blocks.map((b) => ({ ...b, items: b.items ? [...b.items] : undefined })),
      include: campaign.lists.include.map((l) => l.id),
      exclude: campaign.lists.exclude.map((l) => l.id),
    };
    loading.replaceWith(layout);
    buildMain();
    buildSide();
    renderState();
  }

  function adopt(payload) {
    const before = campaign;
    campaign = payload.campaign;
    check = payload.check;
    options = payload.options;
    delivery = payload.delivery || null;
    if (before && ['review', 'approved'].includes(before.status) && campaign.status === 'draft' && !campaign.reviewNote) {
      toast('Текст изменён — письмо снова черновик: нужно новое пробное письмо и утверждение', 'warn');
    }
  }

  function snapshot() {
    return {
      title: draft.title,
      subject: draft.subject,
      preheader: draft.preheader,
      fromName: draft.fromName,
      replyTo: draft.replyTo,
      senderId: draft.senderId,
      blocks: draft.blocks,
      lists: { include: draft.include, exclude: draft.exclude },
    };
  }

  function scheduleSave(delay = 700) {
    pending = true;
    saveState('Есть несохранённые правки');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush(), delay);
  }

  /** Сохранения идут цепочкой: два одновременных PUT могли бы лечь в базу в обратном порядке. */
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    chain = chain.then(saveNow);
    return chain;
  }

  async function saveNow() {
    if (!pending) return;
    pending = false;
    saveState('Сохраняю…');
    try {
      adopt(await api.updateMailCampaign(campaign.id, snapshot()));
      // Ушли с экрана до ответа — правка сохранена, а чужую шапку не трогаем.
      if (!root.isConnected) return;
      renderState();
      if (!pending) saveState(`Сохранено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (err) {
      pending = true;
      saveState('Не сохранено');
      toast(err.message, 'danger');
    }
  }

  function saveState(text) {
    if (root.isConnected) ctx.setSaveState(text);
  }

  function onLeave() {
    window.removeEventListener('hashchange', onLeave);
    window.removeEventListener('beforeunload', onUnload);
    resizeObserver?.disconnect();
    clearTimeout(pollTimer);
    if (pending) flush();
  }

  /** Идущая рассылка обновляется сама: счётчики и прогноз меняются каждые несколько секунд. */
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!['scheduled', 'sending', 'paused'].includes(campaign.status)) return;
    pollTimer = setTimeout(async () => {
      if (!root.isConnected) return;
      try {
        adopt(await api.mailCampaign(campaign.id));
        renderState();
        if (sendsOpen) loadSends();
      } catch {
        schedulePoll();
      }
    }, 10000);
  }

  function onUnload(e) {
    if (!pending) return;
    flush();
    e.preventDefault();
    e.returnValue = '';
  }

  /* ------------------------------ шапка и шаги ------------------------------ */

  function renderState() {
    const tested = campaign.testedCurrent;
    const clean = !check.blockers.length;
    const editable = campaign.editable;
    main.disabled = !editable;

    // Действия — в шапке: она прилипает сверху и видна из любого места письма.
    const actions = [];
    const testButton = button('Пробное письмо', { iconName: 'send', onClick: () => openTest() });
    testButton.disabled = !editable;
    actions.push(testButton);
    const primary = primaryAction(clean, tested);
    if (primary) actions.push(primary);
    ctx.setTopbar({ title: 'Рассылка', subtitle: `Письмо · ${draft.title || 'без названия'}`, actions });
    if (pending) saveState('Есть несохранённые правки');

    // Открытый вопрос «Кому отправить пробное» переживает автосохранение.
    const openAsk = stateHost.querySelector('.mail-ask');
    stateHost.textContent = '';
    const box = el('section', 'panel mail-status');
    const head = el('div', 'mail-status__head');
    head.append(el('span', `tag ${CAMPAIGN_TAG[campaign.status] || ''}`.trim(), campaign.statusTitle), el('span', 'mail-status__text', statusText()));
    box.append(head);

    if (campaign.reviewNote && campaign.status === 'draft') {
      box.append(note('warn', 'Владелец вернул письмо на доработку', campaign.reviewNote));
    }

    if (editable) {
      const steps = el('ol', 'mail-steps');
      steps.append(
        step(clean, 'Письмо без ошибок', clean ? 'проверка пройдена' : `${plural(check.blockers.length, ['ошибка', 'ошибки', 'ошибок'])} — список внизу, в «Проверке»`),
        step(tested, 'Пробное письмо этой версии', tested ? 'ушло — посмотрите его в почте, не только здесь' : 'отправьте себе и откройте в Gmail и на телефоне'),
        step(
          campaign.status === 'approved',
          isOwner ? 'Утверждено' : 'Согласовано владельцем',
          campaign.status === 'approved'
            ? `${campaign.approvedBy || ''}${campaign.approvedAt ? `, ${day(campaign.approvedAt)}` : ''}`.replace(/^, /, '')
            : campaign.status === 'review'
              ? 'ждёт владельца'
              : isOwner
                ? 'кнопка «Утвердить» наверху'
                : 'кнопка «На согласование» наверху'
        )
      );
      box.append(steps);
    }

    if (campaign.pauseReason && campaign.status === 'paused') box.append(note('warn', 'Рассылка на паузе', campaign.pauseReason));
    const deliveryNode = deliveryBox();
    if (deliveryNode) box.append(deliveryNode);

    const extra = el('div', 'mail-actions');
    if (isOwner && ['review', 'approved'].includes(campaign.status)) {
      extra.append(button('Вернуть на доработку', { variant: 'quiet', onClick: () => openReject(box) }));
    }
    if (extra.childNodes.length) box.append(extra);
    if (openAsk) box.append(openAsk);
    stateHost.append(box);
    schedulePoll();
    // Отчёт — один раз при открытии: он ходит за заявками в админку школы, и
    // дёргать её каждые десять секунд незачем. Обновляется кнопкой.
    if (campaign.progress && !reportRequested) {
      reportRequested = true;
      loadReport();
    }

    renderChecks();
    renderAudience();
    renderInbox();
    refreshPreview();
  }

  function step(done, title, sub) {
    const li = el('li', `mail-step${done ? ' mail-step--done' : ''}`);
    const mark = el('span', 'mail-step__mark');
    if (done) mark.append(icon('check', { size: 14 }));
    const text = el('div', 'mail-step__text');
    text.append(el('div', 'mail-step__title', title), el('div', 'mail-step__sub', sub));
    li.append(mark, text);
    return li;
  }

  function statusText() {
    switch (campaign.status) {
      case 'draft':
        return isOwner ? 'Уберите ошибки, отправьте себе пробное письмо и утвердите.' : 'Уберите ошибки, отправьте себе пробное письмо и передайте владельцу на согласование.';
      case 'review':
        return isOwner
          ? 'Просят согласовать. Откройте пробное письмо в почте и утвердите или верните с замечанием.'
          : 'Ждёт владельца. Правка текста вернёт письмо в черновик.';
      case 'approved':
        return isOwner
          ? 'Готово к отправке: выберите время или разошлите сейчас. Правка текста вернёт письмо в черновик, базы можно менять.'
          : 'Готово к отправке: выберите время. Правка текста вернёт письмо в черновик, базы можно менять.';
      case 'scheduled':
        return 'Письмо в расписании. Чтобы что-то поправить — снимите его с расписания.';
      case 'sending':
        return 'Письма уходят по одному, с паузой 4–12 секунд, в окне отправки ящика и в пределах его потолка на сутки.';
      case 'paused':
        return 'Не ушедшие письма ждут. Продолжите, когда причина паузы устранена.';
      case 'done':
        return 'Рассылка завершена. Письмо можно скопировать и отправить снова — другим базам или позже.';
      case 'cancelled':
        return 'Рассылка отменена: ушедшие письма остались у получателей, остальные не уйдут.';
      default:
        return '';
    }
  }

  /* ------------------------------ отправка ------------------------------ */

  function deliveryBox() {
    const status = campaign.status;
    if (!['approved', 'scheduled', 'sending', 'paused', 'done', 'cancelled'].includes(status)) return null;
    const box = el('div', 'mail-delivery');
    box.append(el('div', 'mail-delivery__title', 'Отправка'));
    const progress = campaign.progress;

    if (status === 'approved') {
      const row = el('div', 'mail-delivery__row');
      const when = input(localValue(nextHour()), { type: 'datetime-local' });
      when.min = localValue(new Date());
      const whenField = field('Когда начать', when, 'По времени вашего компьютера');
      const planButton = button('Запланировать', {
        iconName: 'clock',
        onClick: () => {
          const at = new Date(when.value);
          if (Number.isNaN(at.getTime())) return toast('Выберите дату и время', 'danger');
          run(() => api.scheduleMailCampaign(campaign.id, at.toISOString()), `Рассылка запланирована: ${whenText(at.toISOString())}`);
        },
      });
      row.append(whenField, planButton);
      if (isOwner) {
        row.append(
          button('Разослать сейчас', {
            variant: 'primary',
            iconName: 'send',
            onClick: () => {
              const n = check.audience.recipients;
              const finish = delivery?.forecast ? `\nПоследнее письмо уйдёт примерно ${whenText(delivery.forecast.finishAt)}.` : '';
              if (!confirm(`Разослать «${campaign.title}» сейчас?\n\nПолучат ${plural(n, ADDRESSES)}.${finish}\n\nПисьма уходят по одному; остановить можно паузой или отменой.`)) return;
              run(() => api.scheduleMailCampaign(campaign.id, null), 'Рассылка началась');
            },
          })
        );
      }
      box.append(row, forecastLine(check.audience.recipients));
      return box;
    }

    if (status === 'scheduled') {
      const soon = Date.parse(campaign.scheduledAt) <= Date.now() + 60000;
      box.append(
        el('div', 'mail-delivery__lead', `${soon ? 'Начнётся в течение минуты' : `Начнётся ${whenText(campaign.scheduledAt)}`} · получат около ${plural(check.audience.recipients, ADDRESSES)}`),
        forecastLine(check.audience.recipients)
      );
      const actions = el('div', 'mail-actions');
      actions.append(button('Снять с расписания', { variant: 'quiet', onClick: () => run(() => api.unscheduleMailCampaign(campaign.id), 'Снято с расписания') }));
      if (isOwner) actions.append(button('Отменить рассылку', { variant: 'danger', onClick: () => cancel() }));
      box.append(actions);
      return box;
    }

    if (progress) box.append(progressNode(progress));
    if (['sending', 'paused'].includes(status)) {
      const hold = holdText();
      if (hold && status === 'sending') box.append(el('div', 'mail-delivery__hold', hold));
      if (delivery?.forecast && status === 'sending') box.append(el('div', 'mail-sub', `Последнее письмо уйдёт примерно ${whenText(delivery.forecast.finishAt)}`));
      const actions = el('div', 'mail-actions');
      if (status === 'sending') actions.append(button('Пауза', { iconName: 'pause', onClick: () => run(() => api.pauseMailCampaign(campaign.id), 'Рассылка на паузе') }));
      else actions.append(button('Продолжить', { variant: 'primary', iconName: 'play', onClick: () => run(() => api.resumeMailCampaign(campaign.id), 'Рассылка продолжена') }));
      if (isOwner) actions.append(button('Отменить рассылку', { variant: 'danger', onClick: () => cancel() }));
      box.append(actions);
    } else {
      box.append(el('div', 'mail-sub', `${status === 'done' ? 'Завершена' : 'Отменена'} ${whenText(campaign.finishedAt)}`));
    }
    if (isOwner && progress?.unknown && ['sending', 'paused', 'done'].includes(status)) {
      const retry = button(`Повторить неизвестные (${num(progress.unknown)})`, {
        variant: 'quiet',
        iconName: 'refresh',
        onClick: () => {
          const sure = confirm(
            `Отправить заново ${plural(progress.unknown, ['письмо', 'письма', 'писем'])} с неизвестной судьбой?\n\nGoogle не ответил на их отправку, но часть из них, скорее всего, уже дошла — эти люди получат письмо дважды. Повторяйте, только если сбой был явно до отправки (например, пропал интернет у сервера).`
          );
          if (sure) run(() => api.retryUnknownMail(campaign.id), 'Письма с неизвестной судьбой снова в очереди');
        },
      });
      retry.classList.add('btn--sm', 'mail-delivery__toggle');
      box.append(retry);
    }
    if (isOwner && progress) {
      const toggle = button(sendsOpen ? 'Скрыть адреса' : 'Кому ушло — поимённо', {
        variant: 'quiet',
        onClick: () => {
          sendsOpen = !sendsOpen;
          if (sendsOpen) loadSends();
          else sendsHost.textContent = '';
          renderState();
        },
      });
      toggle.classList.add('btn--sm', 'mail-delivery__toggle');
      box.append(toggle);
    }
    return box;
  }

  function progressNode(p) {
    const wrap = el('div', 'mail-progress-box');
    const done = p.sent + p.failed + p.skipped + p.unknown + p.cancelled;
    const head = el('div', 'mail-delivery__lead');
    head.append(el('b', 'num', num(p.sent)), el('span', null, ` из ${num(p.total)} ушло`));
    const meter = el('div', 'meter');
    const fill = el('div', 'meter__fill');
    fill.style.setProperty('--value', String(p.total ? done / p.total : 0));
    meter.append(fill);
    const facts = el('div', 'mail-counts');
    for (const [key, label, tone] of [
      ['queued', 'в очереди', ''],
      ['failed', 'не ушло', 'danger'],
      ['skipped', 'пропущено — отписались', ''],
      ['unknown', 'судьба неизвестна', 'warn'],
      ['cancelled', 'отменено', ''],
    ]) {
      const n = key === 'queued' ? p.queued + p.sending : p[key];
      if (!n) continue;
      const item = el('span', `mail-count${tone ? ` mail-count--${tone}` : ''}`);
      item.append(el('b', 'num', num(n)), el('span', null, ` ${label}`));
      facts.append(item);
    }
    wrap.append(head, meter);
    if (facts.childNodes.length) wrap.append(facts);
    if (p.unknown) wrap.append(el('div', 'mail-sub', 'Судьба неизвестна — Google не ответил на отправку. Такие письма не повторяются сами: лучше не дослать, чем прислать дважды.'));
    return wrap;
  }

  function forecastLine(recipients) {
    const line = el('div', 'mail-sub');
    if (!delivery || !recipients) return line;
    const parts = [];
    if (delivery.forecast) parts.push(`${campaign.status === 'scheduled' ? 'Закончится' : 'Если начать сейчас, закончится'} примерно ${whenText(delivery.forecast.finishAt)}`);
    parts.push(`окно ящика ${delivery.window.from}–${delivery.window.to} по Киеву`);
    parts.push(`на сутки осталось ${num(delivery.capLeft)} из ${num(delivery.cap)}`);
    if (delivery.ahead) parts.push(`впереди в очереди ящика ${plural(delivery.ahead, ['письмо', 'письма', 'писем'])} других рассылок`);
    line.textContent = parts.join(' · ');
    return line;
  }

  /** Что сейчас держит идущую рассылку — словами, иначе «ничего не происходит» выглядит поломкой. */
  function holdText() {
    if (!delivery) return '';
    if (delivery.holdUntil) return `Google попросил притормозить — продолжим ${whenText(delivery.holdUntil)}${delivery.holdReason ? ` (${delivery.holdReason})` : ''}`;
    if (!delivery.window.open) return `Окно отправки закрыто — продолжим ${whenText(delivery.window.opensAt)}`;
    if (delivery.capLeft <= 0) return `Потолок ящика на сутки исчерпан (${num(delivery.cap)}) — продолжим, когда освободится`;
    return '';
  }

  async function cancel() {
    const left = campaign.progress ? campaign.progress.queued : check.audience.recipients;
    if (!confirm(`Отменить рассылку «${campaign.title}»?\n\nНе ушедшие письма (${num(left)}) не уйдут. Ушедшие останутся у получателей. Вернуть отменённую рассылку нельзя — только сделать копию письма.`)) return;
    run(() => api.cancelMailCampaign(campaign.id), 'Рассылка отменена');
  }

  async function loadSends() {
    let data;
    try {
      data = await api.mailCampaignSends(campaign.id, { status: sendsFilter, page: sendsPage });
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    if (!root.isConnected || !sendsOpen) return;
    sendsHost.textContent = '';
    const box = panel('Письма рассылки');
    const chips = el('div', 'chips chips--wrap');
    const p = campaign.progress || {};
    chips.append(chip(`Все · ${num(p.total || 0)}`, !sendsFilter, () => pickSends('')));
    for (const [key, title] of Object.entries(data.statuses)) {
      if (!p[key]) continue;
      chips.append(chip(`${title} · ${num(p[key])}`, sendsFilter === key, () => pickSends(key)));
    }
    box.append(chips);
    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table mail-table');
    const hr = el('tr');
    for (const text of ['Адрес', 'Состояние', 'Когда', 'Причина']) hr.append(el('th', null, text));
    const thead = el('thead');
    thead.append(hr);
    const tbody = el('tbody');
    for (const s of data.sends) {
      const tr = el('tr');
      const who = el('td', 'mail-name-cell');
      who.append(el('div', 'mail-name', s.email));
      if (s.name) who.append(el('div', 'mail-sub', s.name));
      const tone = { sent: 'tag--ok', failed: 'tag--danger', unknown: 'tag--warn', sending: 'tag--gold' }[s.status] || '';
      const state = el('td');
      state.append(el('span', `tag ${tone}`.trim(), s.statusTitle));
      tr.append(who, state, el('td', 'table__time', s.sentAt ? whenText(s.sentAt) : '—'), el('td', 'mail-sub-cell', s.error || ''));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    box.append(wrap);
    const pages = Math.ceil(data.total / data.pageSize);
    if (pages > 1) {
      const pager = el('div', 'mail-pager');
      const prev = button('Назад', { variant: 'quiet', onClick: () => turnSends(-1) });
      prev.disabled = sendsPage <= 1;
      const next = button('Дальше', { variant: 'quiet', onClick: () => turnSends(1) });
      next.disabled = sendsPage >= pages;
      prev.classList.add('btn--sm');
      next.classList.add('btn--sm');
      pager.append(prev, el('span', null, `${sendsPage} из ${pages}`), next);
      box.append(pager);
    }
    sendsHost.append(box);
  }

  /* ------------------------------ результаты ------------------------------ */

  async function loadReport() {
    let data;
    try {
      data = await api.mailCampaignReport(campaign.id);
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    if (!root.isConnected) return;
    reportHost.textContent = '';
    const box = panel(null);
    box.classList.add('mail-report');
    const head = el('div', 'panel__head');
    const refresh = button('Обновить', { variant: 'quiet', iconName: 'refresh', onClick: () => loadReport() });
    refresh.classList.add('btn--sm');
    head.append(el('h2', null, 'Результаты'), el('span', 'spacer'), refresh);
    box.append(head);

    const p = data.progress;
    const funnel = el('div', 'jsum mail-funnel');
    funnel.append(
      tile('Ушло', num(p.sent), `из ${num(p.total)} в снимке${p.failed ? ` · не ушло ${num(p.failed)}` : ''}`, ''),
      tile('Переходы', num(data.clicks), data.clickRate === null ? 'писем ещё не ушло' : `${num(data.clickRate)} % от ушедших`, data.clicks ? 'ok' : ''),
      tile('Заявки', data.leads ? num(data.leads.count) : '—', data.leads ? `по метке ${data.tag}` : data.leadsError || 'ещё не считали', data.leads?.count ? 'gold' : ''),
      tile('Отписались', num(data.unsubscribed), data.unsubscribeRate === null ? 'по этому письму' : `${num(data.unsubscribeRate)} % от ушедших${data.resubscribed ? ` · вернулись ${num(data.resubscribed)}` : ''}`, data.unsubscribed ? 'warn' : '')
    );
    box.append(funnel);

    if (data.links.length) {
      const table = el('table', 'table mail-table');
      const hr = el('tr');
      hr.append(el('th', null, 'Ссылка в письме'), el('th', 'mail-num', 'Переходов'));
      const thead = el('thead');
      thead.append(hr);
      const tbody = el('tbody');
      for (const link of data.links) {
        const tr = el('tr');
        const cell = el('td', 'mail-name-cell');
        cell.append(el('div', 'mail-name', link.label), el('div', 'mail-sub', link.url.replace(/^https?:\/\//, '')));
        tr.append(cell, el('td', 'mail-num num', num(link.clicks)));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      const wrap = el('div', 'scroll-x');
      wrap.append(table);
      box.append(wrap);
    }

    if (data.leads?.items?.length) {
      box.append(el('div', 'eyebrow', 'Заявки по письму'));
      const list = el('div', 'mail-members');
      for (const lead of data.leads.items) {
        const item = el('div', 'mail-member');
        item.append(el('span', 'mail-name', lead.name || 'без имени'), el('span', 'dim small', [lead.source, lead.status, lead.createdAt ? day(lead.createdAt) : ''].filter(Boolean).join(' · ')));
        list.append(item);
      }
      box.append(list);
    }

    if (data.failures.length) {
      box.append(el('div', 'eyebrow', 'Почему не ушло'));
      const ul = el('ul', 'mail-issues__list');
      for (const f of data.failures) ul.append(el('li', null, `${f.reason} — ${num(f.n)}`));
      box.append(ul);
    }

    box.append(
      el(
        'p',
        'field__hint',
        'Открытий нет намеренно: пиксель слежения — признак рекламной рассылки для фильтров, а Gmail всё равно грузит картинки через свой прокси. Переходы считаются без роботов, но проверка ссылок почтовым фильтром может выглядеть как человек. Заявка привязывается к письму, если человек пришёл на сайт по ссылке из него.'
      )
    );
    reportHost.append(box);
  }

  function pickSends(status) {
    sendsFilter = status;
    sendsPage = 1;
    loadSends();
  }

  function turnSends(delta) {
    sendsPage += delta;
    loadSends();
  }

  function primaryAction(clean, tested) {
    const why = !clean ? 'Сначала исправьте ошибки из «Проверки»' : !tested ? 'Сначала отправьте себе пробное письмо этой версии' : '';
    let b = null;
    if (isOwner && ['draft', 'review'].includes(campaign.status)) {
      b = button('Утвердить', { variant: 'primary', iconName: 'check', onClick: () => run(() => api.approveMailCampaign(campaign.id), 'Письмо утверждено') });
    } else if (!isOwner && campaign.status === 'draft') {
      b = button('На согласование', { variant: 'primary', onClick: () => run(() => api.submitMailCampaign(campaign.id), 'Письмо передано владельцу') });
    }
    if (b && why) {
      b.disabled = true;
      b.title = why;
    }
    return b;
  }

  async function run(action, done) {
    await flush();
    try {
      adopt(await action());
      toast(done, 'ok');
    } catch (err) {
      toast(err.message, 'danger');
    }
    renderState();
  }

  function openTest() {
    const box = stateHost.querySelector('.mail-status');
    const sender = options.senders.find((s) => s.id === draft.senderId);
    ask(box, {
      placeholder: `Кому — через запятую, до 5 адресов; пусто — на ${sender?.email || 'ящик отправителя'}`,
      confirmLabel: 'Отправить пробное',
      onConfirm: (value) => sendTest(value),
    });
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function sendTest(value) {
    await flush();
    const to = value
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const out = await api.testMailCampaign(campaign.id, to);
      adopt(out);
      if (out.sent.length) toast(`Пробное письмо ушло на ${out.sent.map((s) => s.email).join(', ')} — проверьте «Входящие» и «Спам»`, 'ok');
      if (out.failed.length) toast(`Не ушло: ${out.failed[0].email} — ${out.failed[0].error}`, 'danger');
    } catch (err) {
      toast(err.message, 'danger');
    }
    renderState();
  }

  function openReject(box) {
    ask(box, {
      placeholder: 'Что поправить — это увидит автор письма',
      confirmLabel: 'Вернуть',
      required: true,
      onConfirm: (text) => run(() => api.rejectMailCampaign(campaign.id, text), 'Письмо возвращено на доработку'),
    });
  }

  /* ------------------------------ левая колонка ------------------------------ */

  function buildMain() {
    main.textContent = '';
    main.append(envelopePanel(), recipientsPanel(), contentPanel(), checksPanel());
  }

  function envelopePanel() {
    const box = panel('Конверт');
    const grid = el('div', 'mail-form__grid mail-envelope');

    const title = bindText(input(draft.title, { placeholder: 'Например: Набор в сентябре' }), 'title', () => ctx.setSubtitle(`Письмо · ${draft.title || 'без названия'}`));
    const subject = bindText(input(draft.subject, { placeholder: 'Что увидят во «Входящих»' }), 'subject', () => {
      updateSubjectHint();
      renderInbox();
    });
    const preheader = bindText(input(draft.preheader, { placeholder: 'Продолжение темы серым' }), 'preheader', renderInbox);
    fromNameInput.value = draft.fromName;
    bindText(fromNameInput, 'fromName', renderInbox);
    updateFromPlaceholder();

    const senderSelect = select(
      [
        ['', 'не выбран'],
        ...options.senders.map((s) => [String(s.id), `${s.email}${SENDER_STATE[s.state] ? ` — ${SENDER_STATE[s.state]}` : ''}`]),
      ],
      draft.senderId ? String(draft.senderId) : ''
    );
    senderSelect.addEventListener('change', () => {
      draft.senderId = senderSelect.value ? Number(senderSelect.value) : null;
      updateSenderHint();
      updateFromPlaceholder();
      renderInbox();
      scheduleSave(0);
    });
    updateSenderHint();

    // Адрес для ответов сохраняется по уходу из поля: на полуслове он всегда
    // «не похож на адрес», и ошибка сыпалась бы на каждую букву.
    const replyTo = input(draft.replyTo, { type: 'email', placeholder: 'пусто — ответы придут в ящик отправителя' });
    replyTo.addEventListener('change', () => {
      draft.replyTo = replyTo.value.trim();
      scheduleSave(0);
    });

    updateSubjectHint();
    const subjectField = field('Тема', subject);
    subjectField.append(subjectHint);
    const senderField = field('Ящик', senderSelect);
    senderField.append(senderHint);
    grid.append(
      subjectField,
      field('Прехедер', preheader, 'Строка рядом с темой во «Входящих»'),
      field('Имя отправителя', fromNameInput),
      senderField,
      field('Ответы на адрес', replyTo),
      field('Название для себя', title, 'Видно только в панели')
    );
    box.append(grid);
    return box;
  }

  function bindText(node, key, after = null) {
    node.addEventListener('input', () => {
      draft[key] = node.value;
      after?.();
      scheduleSave();
    });
    return node;
  }

  function updateSubjectHint() {
    const len = draft.subject.length;
    subjectHint.textContent = len > SUBJECT_WARN ? `${len} знаков — на телефоне обрежется после ~${SUBJECT_WARN}` : `${len} из ~${SUBJECT_WARN} знаков, что видно на телефоне`;
    subjectHint.classList.toggle('field__hint--warn', len > SUBJECT_WARN);
  }

  function updateSenderHint() {
    const sender = options.senders.find((s) => s.id === draft.senderId);
    senderHint.textContent = sender ? `за последние сутки ушло ${num(sender.sent24h)} из ${num(sender.cap)}` : options.senders.length ? '' : 'Ящик подключает владелец во вкладке «Ящики»';
  }

  function updateFromPlaceholder() {
    fromNameInput.placeholder = fromNameDefault();
  }

  function fromNameDefault() {
    return project?.title || 'Название школы';
  }

  function recipientsPanel() {
    const box = panel('Получатели');
    const grid = el('div', 'mail-recipients');
    const inc = el('div', 'field');
    inc.append(el('span', 'field__label', 'Кому — базы'), includeHost);
    const exc = el('div', 'field');
    exc.append(el('span', 'field__label', 'Кроме тех, кто есть в базах'), excludeHost);
    grid.append(inc, exc);
    renderPicks();
    box.append(grid, audienceHost);
    return box;
  }

  function renderPicks() {
    includeHost.textContent = '';
    excludeHost.textContent = '';
    if (!options.lists.length) {
      includeHost.append(el('span', 'field__hint', 'Баз ещё нет — их загружает владелец во вкладке «Базы»'));
      excludeHost.append(el('span', 'field__hint', '—'));
      return;
    }
    for (const list of options.lists) {
      includeHost.append(pick(list, 'include'));
      excludeHost.append(pick(list, 'exclude'));
    }
  }

  function pick(list, mode) {
    const other = mode === 'include' ? 'exclude' : 'include';
    const label = el('label', 'check mail-pick');
    const box = el('input', 'mail-check');
    box.type = 'checkbox';
    box.checked = draft[mode].includes(list.id);
    box.disabled = draft[other].includes(list.id);
    box.addEventListener('change', () => {
      draft[mode] = box.checked ? [...draft[mode], list.id] : draft[mode].filter((x) => x !== list.id);
      renderPicks();
      scheduleSave(0);
    });
    label.append(box, el('span', 'mail-pick__name', list.name), el('span', 'mail-pick__count num', num(list.active)));
    if (box.disabled) label.title = mode === 'include' ? 'База уже в исключениях' : 'База уже среди получателей';
    return label;
  }

  function renderAudience() {
    audienceHost.textContent = '';
    const a = check.audience;
    if (!draft.include.length) {
      audienceHost.append(el('span', 'dim', 'Отметьте хотя бы одну базу'));
      return;
    }
    const value = el('div', 'mail-audience__value');
    value.append(el('span', 'dim', 'Получат '), el('b', 'num', num(a.recipients)), el('span', 'dim', ` ${plural(a.recipients, ADDRESSES).split(' ').pop()}`));
    const parts = [];
    if (a.unsubscribed) parts.push(`отписались ${num(a.unsubscribed)}`);
    if (a.undeliverable) parts.push(`не доставить ${num(a.undeliverable)}`);
    if (a.excluded) parts.push(`исключено ${num(a.excluded)}`);
    if (a.recent) parts.push(`получали письмо меньше ${a.gapDays} дн. назад ${num(a.recent)}`);
    audienceHost.append(value, el('span', 'mail-sub', parts.length ? `${parts.join(' · ')} — им письма не будет` : 'человек в нескольких базах получит одно письмо'));
  }

  /* ------------------------------ блоки ------------------------------ */

  function contentPanel() {
    const box = panel('Содержание');
    const hint = el('p', 'field__hint', 'Шапка с логотипом и подвал с отпиской добавляются сами. Письмо — на украинском: так его прочитают родители.');
    box.append(hint, blocksHost, addHost);
    renderBlocks();
    return box;
  }

  function renderBlocks() {
    blocksHost.textContent = '';
    draft.blocks.forEach((block, index) => blocksHost.append(blockCard(block, index)));
    if (!draft.blocks.length) blocksHost.append(el('div', 'mail-blocks__empty', 'Блоков нет — добавьте заголовок и текст'));

    addHost.textContent = '';
    addHost.append(el('span', 'mail-add__label', 'Добавить'));
    const chips = el('div', 'mail-add__chips');
    for (const type of ADD_ORDER) {
      const b = button(BLOCKS[type].title, { variant: 'quiet', iconName: 'plus', onClick: () => addBlock(type) });
      b.classList.add('btn--sm');
      if (type === 'hero' && draft.blocks.some((x) => x.type === 'hero')) {
        b.disabled = true;
        b.title = 'Главная картинка в письме одна — она стоит первой';
      }
      chips.append(b);
    }
    addHost.append(chips);
  }

  function addBlock(type) {
    const block = { id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type, ...NEW_BLOCK[type]() };
    if (type === 'hero') draft.blocks.unshift(block);
    else draft.blocks.push(block);
    renderBlocks();
    scheduleSave(0);
    const card = blocksHost.querySelector(`[data-block="${block.id}"]`);
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card?.querySelector('input, textarea, button.mail-image__pick')?.focus({ preventScroll: true });
  }

  function moveBlock(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= draft.blocks.length) return;
    const [block] = draft.blocks.splice(index, 1);
    draft.blocks.splice(to, 0, block);
    renderBlocks();
    scheduleSave(0);
    blocksHost.querySelector(`[data-block="${block.id}"] .mail-block__move--${delta < 0 ? 'up' : 'down'}`)?.focus();
  }

  function removeBlock(index) {
    const block = draft.blocks[index];
    const hasContent = [block.text, block.title, block.note, ...(block.items || [])].some((v) => String(v || '').trim()) || block.mediaId;
    if (hasContent && !confirm(`Убрать блок «${BLOCKS[block.type].title}» вместе с содержимым?`)) return;
    draft.blocks.splice(index, 1);
    renderBlocks();
    scheduleSave(0);
  }

  function blockCard(block, index) {
    const card = el('section', `mail-block mail-block--${block.type}`);
    card.dataset.block = block.id;

    const head = el('div', 'mail-block__head');
    head.append(el('span', 'mail-block__num num', String(index + 1)), el('span', 'mail-block__title', BLOCKS[block.type].title), el('span', 'spacer'));
    const up = iconButton('chevronLeft', { title: 'Выше', onClick: () => moveBlock(index, -1) });
    up.classList.add('mail-block__move', 'mail-block__move--up');
    up.disabled = index === 0 || (draft.blocks[index - 1]?.type === 'hero');
    const down = iconButton('chevronLeft', { title: 'Ниже', onClick: () => moveBlock(index, 1) });
    down.classList.add('mail-block__move', 'mail-block__move--down');
    down.disabled = index === draft.blocks.length - 1 || block.type === 'hero';
    head.append(up, down, iconButton('trash', { title: 'Убрать блок', onClick: () => removeBlock(index) }));
    card.append(head);

    const body = el('div', 'mail-block__body');
    const set = (key) => (node) => {
      node.addEventListener('input', () => {
        block[key] = node.value;
        scheduleSave();
      });
      return node;
    };

    switch (block.type) {
      case 'eyebrow':
      case 'heading':
      case 'subheading': {
        const node = set('text')(input(block.text || '', { placeholder: block.type === 'eyebrow' ? 'Новий навчальний рік' : '' }));
        node.setAttribute('aria-label', BLOCKS[block.type].title);
        body.append(node);
        if (BLOCKS[block.type].hint) body.append(el('span', 'field__hint', BLOCKS[block.type].hint));
        break;
      }
      case 'text': {
        const area = set('text')(textarea(block.text || '', 6));
        area.setAttribute('aria-label', 'Текст');
        body.append(textBar(area), area, el('span', 'field__hint', '**жирный**, _курсив_, [текст ссылки](https://…). Пустая строка — новый абзац. {{name|Друже}} — имя получателя или «Друже», если имени нет.'));
        break;
      }
      case 'bullets': {
        const area = textarea((block.items || []).join('\n'), 4);
        area.setAttribute('aria-label', 'Пункты списка');
        area.addEventListener('input', () => {
          block.items = area.value.split('\n');
          scheduleSave();
        });
        body.append(area, el('span', 'field__hint', 'Один пункт — одна строка. Галочки перед пунктами добавятся сами.'));
        break;
      }
      case 'button': {
        const grid = el('div', 'mail-form__grid');
        grid.append(
          field('Надпись', set('text')(input(block.text || '', { placeholder: 'Записатися на пробне заняття' }))),
          field('Ссылка', set('href')(input(block.href || '', { type: 'url', placeholder: 'https://…' })), 'Прямая, без сокращателей')
        );
        const noteField = field('Подпись под кнопкой', set('note')(input(block.note || '', { placeholder: 'Необязательно' })));
        noteField.classList.add('mail-form__wide');
        grid.append(noteField);
        body.append(grid);
        break;
      }
      case 'callout': {
        body.append(
          field('Заголовок врезки', set('title')(input(block.title || '', { placeholder: 'Залишились питання?' }))),
          field('Текст', set('text')(textarea(block.text || '', 3)))
        );
        break;
      }
      case 'hero':
      case 'image': {
        body.append(imageField(block));
        const grid = el('div', 'mail-form__grid');
        grid.append(
          field('Описание картинки', set('alt')(input(block.alt || '', { placeholder: 'Діти на занятті з програмування' })), 'Покажут, если картинки в почте выключены'),
          field('Ссылка по нажатию', set('href')(input(block.href || '', { type: 'url', placeholder: 'https://… — необязательно' })))
        );
        body.append(grid);
        break;
      }
      case 'divider':
        body.append(el('span', 'field__hint', 'Тонкая линия между частями письма.'));
        break;
      default:
        break;
    }
    card.append(body);
    return card;
  }

  function textarea(value, rows) {
    const node = el('textarea', 'textarea mail-textarea');
    node.rows = rows;
    node.value = value;
    return node;
  }

  /** Кнопки разметки: не все помнят звёздочки, а ошибка в скобках ссылки ломает её молча. */
  function textBar(area) {
    const bar = el('div', 'mail-textbar');
    const wrap = (before, after, placeholder) => {
      const { selectionStart: s, selectionEnd: e, value } = area;
      const inner = value.slice(s, e) || placeholder;
      area.setRangeText(`${before}${inner}${after}`, s, e, 'end');
      area.setSelectionRange(s + before.length, s + before.length + inner.length);
      area.focus();
      area.dispatchEvent(new Event('input'));
    };
    const insert = (text) => {
      area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
      area.focus();
      area.dispatchEvent(new Event('input'));
    };
    for (const [label, title, action] of [
      ['Ж', 'Жирный', () => wrap('**', '**', 'важне')],
      ['К', 'Курсив', () => wrap('_', '_', 'текст')],
      ['Ссылка', 'Ссылка: выделите слова и нажмите', () => wrap('[', '](https://)', 'текст посилання')],
      ['Имя', 'Имя получателя; если имени нет — «Друже»', () => insert('{{name|Друже}}')],
    ]) {
      const b = button(label, { variant: 'quiet', title, onClick: action });
      b.classList.add('btn--sm', 'mail-textbar__btn');
      bar.append(b);
    }
    return bar;
  }

  function imageField(block) {
    const wrap = el('div', 'mail-image');
    const file = block.mediaId ? campaign.media[block.mediaId] : null;
    const picker = el('input', 'mail-drop__input');
    picker.type = 'file';
    picker.accept = 'image/jpeg,image/png,image/webp';
    picker.addEventListener('change', () => {
      if (picker.files?.[0]) upload(block, picker.files[0], wrap);
    });

    if (file && !file.purged) {
      const thumb = el('img', 'mail-image__thumb');
      thumb.src = api.mailMediaUrl(file.name);
      thumb.alt = '';
      const meta = el('div', 'mail-image__meta');
      meta.append(el('div', 'mail-name', `${file.width} × ${file.height} px`), el('div', 'mail-sub', `${humanBytes(file.bytes)}${file.originalName ? ` · ${file.originalName}` : ''}`));
      const actions = el('div', 'mail-actions');
      const replace = button('Заменить', { variant: 'quiet', iconName: 'upload', onClick: () => picker.click() });
      replace.classList.add('btn--sm', 'mail-image__pick');
      const drop = button('Убрать картинку', {
        variant: 'quiet',
        onClick: () => {
          block.mediaId = null;
          renderBlocks();
          scheduleSave(0);
        },
      });
      drop.classList.add('btn--sm');
      actions.append(replace, drop);
      meta.append(actions);
      wrap.append(thumb, meta, picker);
    } else {
      const pickButton = el('button', 'mail-image__empty mail-image__pick');
      pickButton.type = 'button';
      pickButton.append(icon('image', { size: 22 }), el('span', 'mail-name', 'Загрузить картинку'), el('span', 'mail-sub', BLOCKS[block.type].hint));
      pickButton.addEventListener('click', () => picker.click());
      wrap.append(pickButton, picker);
    }
    wireDrop(wrap, (dropped) => upload(block, dropped, wrap));
    return wrap;
  }

  function wireDrop(target, onFile) {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      target.classList.add('mail-image--over');
    });
    target.addEventListener('dragleave', () => target.classList.remove('mail-image--over'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('mail-image--over');
      const dropped = e.dataTransfer?.files?.[0];
      if (dropped && !main.disabled) onFile(dropped);
    });
  }

  async function upload(block, file, wrap) {
    wrap.classList.add('mail-image--busy');
    wrap.setAttribute('aria-busy', 'true');
    try {
      const { blob, name } = await prepareImage(file);
      const { media } = await api.uploadMailCampaignImage(campaign.id, blob, name);
      campaign.media[media.id] = media;
      block.mediaId = media.id;
      renderBlocks();
      scheduleSave(0);
      toast(`Картинка загружена: ${media.width} × ${media.height}, ${humanBytes(media.bytes)}`, 'ok');
    } catch (err) {
      toast(err.message, 'danger');
      wrap.classList.remove('mail-image--busy');
      wrap.removeAttribute('aria-busy');
    }
  }

  /* ------------------------------ проверка ------------------------------ */

  function checksPanel() {
    const box = panel('Проверка');
    box.append(checksHost);
    return box;
  }

  function renderChecks() {
    checksHost.textContent = '';
    const { blockers, warnings, stats } = check;
    if (!blockers.length && !warnings.length) {
      checksHost.append(note('ok', 'Ошибок и замечаний нет', 'Осталось посмотреть пробное письмо в почте — рамка справа показывает вёрстку, но не то, как письмо разберёт Gmail.'));
    }
    if (blockers.length) checksHost.append(issueList('danger', 'Не пустят дальше', blockers));
    if (warnings.length) checksHost.append(issueList('warn', 'Стоит посмотреть', warnings));
    const facts = el('div', 'mail-sub mail-weight');
    facts.textContent = `Вес письма ${humanBytes(stats.totalBytes)} · текст и вёрстка ${humanBytes(stats.htmlBytes)} из 95 КБ, после которых Gmail обрезает письмо · ${plural(stats.images, ['картинка', 'картинки', 'картинок'])}`;
    checksHost.append(facts);
  }

  function issueList(kind, title, items) {
    const box = el('div', `mail-issues mail-issues--${kind}`);
    box.append(el('div', 'mail-issues__title', `${title} · ${items.length}`));
    const ul = el('ul', 'mail-issues__list');
    for (const text of items) ul.append(el('li', null, text));
    box.append(ul);
    return box;
  }

  /* ------------------------------ предпросмотр ------------------------------ */

  function buildSide() {
    side.textContent = '';
    const box = el('section', 'panel mail-preview');
    const head = el('div', 'panel__head');
    const chips = el('div', 'chips');
    const deviceChips = [];
    for (const [value, title] of [
      ['desktop', 'Компьютер'],
      ['phone', 'Телефон'],
    ]) {
      const c = chip(title, device === value, () => {
        device = value;
        for (const [v, node] of deviceChips) node.setAttribute('aria-pressed', String(v === device));
        measure();
      });
      deviceChips.push([value, c]);
      chips.append(c);
    }
    const open = el('a', 'btn btn--quiet btn--icon');
    open.target = '_blank';
    open.rel = 'noopener';
    open.title = 'Открыть письмо в новой вкладке';
    open.setAttribute('aria-label', open.title);
    open.append(icon('eye', { size: 17 }));
    open.addEventListener('click', () => {
      open.href = api.mailCampaignPreviewUrl(campaign.id, { v: Date.now(), name: previewName });
    });
    head.append(el('h2', null, 'Предпросмотр'), el('span', 'spacer'), chips, open);

    const name = input('', { placeholder: 'Ірина' });
    name.addEventListener('input', () => {
      previewName = name.value.trim();
      clearTimeout(nameTimer);
      nameTimer = setTimeout(refreshPreview, 400);
    });
    const nameField = field('Имя получателя в примере', name, 'Пусто — как у адреса без имени');
    nameField.classList.add('mail-preview__name');

    frame.title = 'Предпросмотр письма';
    // Без скриптов: письму они не нужны, а рамка — часть панели. Тот же
    // источник нужен, чтобы измерить высоту письма и не держать вторую прокрутку.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.addEventListener('load', measure);
    sizer.append(frame);
    viewport.append(sizer);

    box.append(head, inbox, viewport, nameField);
    side.append(box);

    resizeObserver = new ResizeObserver(() => layoutPreview());
    resizeObserver.observe(viewport);
  }

  function renderInbox() {
    inbox.textContent = '';
    const sender = options.senders.find((s) => s.id === draft.senderId);
    const from = draft.fromName.trim() || fromNameDefault();
    const top = el('div', 'mail-inbox__top');
    top.append(el('span', 'mail-inbox__from', from), el('span', 'mail-inbox__addr', sender ? sender.email : 'ящик не выбран'));
    inbox.append(
      top,
      el('div', `mail-inbox__subject${draft.subject.trim() ? '' : ' mail-inbox__subject--empty'}`, draft.subject.trim() || 'Тема не написана'),
      el('div', 'mail-inbox__pre', draft.preheader.trim() || 'Прехедера нет — здесь окажется начало письма')
    );
  }

  function refreshPreview() {
    if (!campaign) return;
    const key = `${campaign.contentHash}|${draft.include[0] || ''}|${previewName}`;
    if (key === previewKey) return;
    previewKey = key;
    viewport.setAttribute('aria-busy', 'true');
    frame.src = api.mailCampaignPreviewUrl(campaign.id, { v: `${String(campaign.contentHash).slice(0, 12)}${draft.include[0] || ''}`, name: previewName });
  }

  /** Высота письма при текущей ширине: на телефоне оно длиннее — текст переносится чаще. */
  function measure() {
    frame.style.width = `${PREVIEW_WIDTH[device]}px`;
    try {
      const doc = frame.contentDocument;
      frame.style.height = '0px';
      contentHeight = doc.documentElement.scrollHeight;
    } catch {
      contentHeight = 1800;
    }
    frame.style.height = `${contentHeight}px`;
    viewport.removeAttribute('aria-busy');
    layoutPreview();
  }

  function layoutPreview() {
    const width = PREVIEW_WIDTH[device];
    const available = viewport.clientWidth;
    if (!available) return;
    const scale = Math.min(1, available / width);
    frame.style.transform = `scale(${scale})`;
    frame.style.left = `${Math.max(0, (available - width * scale) / 2)}px`;
    sizer.style.height = `${Math.ceil(contentHeight * scale)}px`;
  }
}

/* ------------------------------ время ------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

/** Значение для `<input type="datetime-local">` — местное время без зоны. */
function localValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Ближайший круглый час, но не раньше чем через 15 минут: время на последний взгляд. */
function nextHour() {
  const d = new Date(Date.now() + 15 * 60000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** «сегодня в 14:00», «завтра в 08:00», «17 сентября в 10:30». */
function whenText(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `сегодня в ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `завтра в ${time}`;
  return `${day(iso)} в ${time}`;
}

/* ------------------------------ картинка в браузере ------------------------------ */

/**
 * Картинка для письма: не шире 1200 px, JPEG — если нет прозрачности. Ужимаем
 * в браузере: телефонное фото на 6 МБ иначе упрётся в предел 2 МБ, а WebP
 * почта показывает не везде. Подходящий файл уходит как есть.
 */
async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Картинка не открылась — нужен JPEG или PNG');
  }
  const { width, height } = bitmap;
  const known = file.type === 'image/jpeg' || file.type === 'image/png';
  if (known && width <= IMAGE_MAX_WIDTH && file.size <= KEEP_BYTES) {
    bitmap.close();
    return { blob: file, name: file.name };
  }
  const scale = Math.min(1, IMAGE_MAX_WIDTH / width);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const keepPng = file.type === 'image/png' && hasAlpha(g, w, h);
  if (!keepPng) {
    // У JPEG нет прозрачности: подкладываем белое, как фон письма, а не чёрное.
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
  }
  const type = keepPng ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
  if (!blob) throw new Error('Не получилось подготовить картинку — попробуйте другой файл');
  const base = (file.name || 'image').replace(/\.[^.]+$/, '');
  return { blob, name: `${base}.${keepPng ? 'png' : 'jpg'}` };
}

function hasAlpha(g, w, h) {
  const { data } = g.getImageData(0, 0, w, h);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}
