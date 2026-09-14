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
import { el, button, iconButton, panel, note, toast, skeleton, humanDate } from '../ui.js';

export function projectsView(ctx) {
  const root = el('div', 'view');
  let projects = [];
  let openId = ctx.state.projectId;
  // Что сторож знает о сроках, по площадкам открытого проекта.
  let health = {};

  const recheck = button('Проверить токены', { iconName: 'refresh', onClick: runWatch });

  ctx.setTopbar({
    title: 'Проекты',
    subtitle: 'Аккаунты и доступы каждой школы',
    actions: [recheck, button('Новый проект', { iconName: 'plus', onClick: openCreate })],
  });

  const list = el('div', 'projects');
  root.append(list);
  const card = el('div', 'stack');
  root.append(card);

  const loading = el('div', 'issues');
  loading.append(skeleton(70));
  list.append(loading);

  load();
  reportOauthReturn();
  return root;

  /**
   * Возврат из окна согласия Threads: сервер кладёт итог в адрес страницы.
   * Показываем и сразу убираем из адреса — иначе обновление страницы
   * повторяло бы всплывашку, а ссылка с ошибкой гуляла бы по истории.
   */
  function reportOauthReturn() {
    const params = new URLSearchParams(location.search);
    const kind = params.get('oauth');
    if (kind !== 'threads' && kind !== 'facebook' && kind !== 'tiktok') return;
    history.replaceState(null, '', `${location.pathname}${location.hash}`);

    if (kind === 'tiktok') {
      const id = Number(params.get('project'));
      if (id) openId = id;
      if (params.get('result') !== 'ok') {
        toast(`TikTok не подключён: ${params.get('message') || 'неизвестная ошибка'}`, 'danger');
        return;
      }
      toast(`TikTok подключён${params.get('user') ? `: ${params.get('user')}` : ''}`, 'ok');
      const missing = (params.get('missing') || '').split(',').filter(Boolean);
      if (missing.length) toast(`TikTok выдал не все права: нет ${missing.join(', ')}. Переподключите и не снимайте галочки.`, 'warn');
      return;
    }

    if (kind === 'facebook') {
      const id = Number(params.get('project'));
      if (id) openId = id;
      if (params.get('result') === 'pick') pickFacebookPage(id, params.get('pending'));
      else toast(`Facebook не подключён, нынешние доступы не тронуты: ${params.get('message') || 'неизвестная ошибка'}`, 'danger');
      return;
    }

    if (params.get('result') === 'ok') {
      const missing = (params.get('missing') || '').split(',').filter(Boolean);
      toast(`Threads подключён: @${params.get('user') || '—'}`, 'ok');
      // Галочку права можно снять в окне согласия — и узнать об этом лучше
      // сейчас, чем при первой неудачной попытке снять пост.
      if (missing.length) toast(`Threads выдал не все права: нет ${missing.join(', ')}. Переподключите и не снимайте галочки.`, 'warn');
      const id = Number(params.get('project'));
      if (id) openId = id;
    } else {
      toast(`Threads не подключён: ${params.get('message') || 'неизвестная ошибка'}`, 'danger');
    }
  }

  /**
   * Выбор страницы после входа Facebook.
   *
   * До нажатия «Применить» карточка проекта не меняется вовсе. Страница, на
   * которую заменять нельзя (срочный токен, не хватает прав, нет права
   * публиковать), показывается с причиной и выбрать её нельзя: сервер всё
   * равно откажет, но человек должен понять почему ещё до нажатия.
   */
  async function pickFacebookPage(projectId, pendingId) {
    let data;
    try {
      data = await api.facebookPending(projectId, pendingId);
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }

    root.querySelector('.fb-pick')?.remove();
    const box = panel('Какую страницу подключить к проекту');
    box.classList.add('fb-pick');
    box.append(
      note(
        'info',
        'Пока вы не нажали «Применить», ничего не меняется',
        data.current.forever
          ? 'Сейчас у проекта бессрочный токен. Заменить его можно только таким же бессрочным и с теми же правами; прежние доступы уйдут в резервную копию.'
          : 'Прежние доступы Facebook и Instagram перед заменой уйдут в резервную копию.'
      )
    );

    const list = el('div', 'fb-pick__list');
    let chosen = null;
    const confirmWrap = el('label', 'fb-pick__confirm');
    const confirm = el('input');
    confirm.type = 'checkbox';
    confirmWrap.append(confirm, el('span', null, 'Да, сменить страницу проекта'));
    confirmWrap.hidden = true;

    for (const page of data.pages) {
      const row = el('label', `fb-pick__row${page.ok ? '' : ' fb-pick__row--blocked'}`);
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'fb-page';
      radio.disabled = !page.ok;
      radio.addEventListener('change', () => {
        chosen = page;
        confirmWrap.hidden = !page.needsConfirm;
        confirm.checked = false;
        apply.disabled = false;
      });
      row.append(radio);

      const body = el('div', 'fb-pick__body');
      const head = el('div', 'fb-pick__head');
      head.append(el('span', 'fb-pick__name', page.name));
      if (page.isCurrent) head.append(el('span', 'tag tag--gold', 'сейчас подключена'));
      head.append(el('span', `tag ${page.forever ? 'tag--ok' : 'tag--danger'}`, page.forever ? 'бессрочный' : 'срочный'));
      body.append(head);
      body.append(el('div', 'dim small', page.instagram ? `Instagram: @${page.instagram.username || page.instagram.id}` : 'Instagram не привязан'));
      for (const p of page.problems) body.append(el('div', 'fb-pick__problem', p));
      // У страницы, которую выбрать нельзя, предупреждения — шум поверх причин.
      if (page.ok) for (const w of page.warnings) body.append(el('div', 'fb-pick__warning', w));
      row.append(body);
      list.append(row);
    }
    box.append(list, confirmWrap);

    const foot = el('div', 'target__meta');
    foot.style.justifyContent = 'flex-start';
    const apply = button('Применить', {
      variant: 'primary',
      iconName: 'check',
      disabled: true,
      onClick: async () => {
        if (!chosen) return;
        if (chosen.needsConfirm && !confirm.checked) {
          toast('Это другая страница — отметьте подтверждение смены', 'warn');
          return;
        }
        apply.disabled = true;
        try {
          const res = await api.applyFacebookPending(projectId, pendingId, { pageId: chosen.pageId, confirmSwitch: confirm.checked });
          toast(`Подключено: ${res.page}${res.instagram ? `, Instagram @${res.instagram}` : ''}`, 'ok');
          for (const w of res.warnings || []) toast(w, 'warn');
          box.remove();
          load();
        } catch (err) {
          toast(err.message, 'danger');
          apply.disabled = false;
        }
      },
    });
    const cancel = button('Отмена', {
      onClick: async () => {
        await api.cancelFacebookPending(projectId, pendingId).catch(() => {});
        box.remove();
        toast('Подключение отменено, доступы не тронуты', 'ok');
      },
    });
    foot.append(apply, cancel);
    box.append(foot);
    root.prepend(box);
  }

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

  /**
   * Прогнать сторожа сейчас. Обычно он ходит сам раз в шесть часов, но после
   * замены токена ждать полдня, чтобы увидеть новый срок, незачем.
   */
  async function runWatch() {
    recheck.disabled = true;
    try {
      const res = await api.checkTokens();
      toast(`Сторож проверил подключений: ${res.checked}`, 'ok');
      await renderCard();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      recheck.disabled = false;
    }
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
      // Сроки читаются тем же заходом: показывать карточку без них значит
      // показывать «подключено» рядом с мёртвым токеном.
      const watch = await api.tokens(openId);
      health = Object.fromEntries(watch.tokens.map((t) => [t.platform, t]));
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
    head.append(signatureEditor(project));
    card.append(head);

    const grid = el('div', 'platforms');
    for (const account of data.accounts) grid.append(accountCard(project, account));
    card.append(grid);
  }

  /**
   * Подпись проекта. Живёт здесь, а не в общих настройках: у четырёх школ
   * разные сайты и телефоны, и общая приставка звала бы людей не туда.
   */
  function signatureEditor(project) {
    const box = el('div', 'field');
    const head = el('div', 'signature__head');
    head.append(el('span', 'field__label', 'Подпись ко всем постам проекта'));

    const sw = el('label', 'switch');
    const on = el('input');
    on.type = 'checkbox';
    on.checked = project.signatureEnabled;
    on.setAttribute('aria-label', 'Добавлять подпись');
    const mark = el('span', 'switch__box');
    mark.innerHTML = iconMarkup('check', 12);
    sw.append(on, mark);
    head.append(el('span', 'spacer'), sw);
    box.append(head);

    const area = el('textarea', 'textarea');
    area.rows = 4;
    area.value = project.signature || '';
    area.placeholder = 'Название школы, ссылка на сайт, телефон';
    box.append(area);
    box.append(
      el(
        'span',
        'field__hint',
        'Уходит в конце каждого поста и считается в лимитах площадок. Ссылка внутри подписи тоже считает переходы. У отдельного поста подпись можно снять.'
      )
    );

    const foot = el('div', 'target__meta');
    foot.style.justifyContent = 'flex-start';
    const save = button('Сохранить подпись', {
      iconName: 'check',
      onClick: async () => {
        try {
          await api.updateProject(project.id, {
            signature: area.value,
            signatureEnabled: on.checked,
          });
          toast('Подпись сохранена', 'ok');
          load();
        } catch (err) {
          toast(err.message, 'danger');
        }
      },
    });
    foot.append(save);
    box.append(foot);
    return box;
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

    const watch = health[account.platform];
    if (account.configured && watch) head.append(healthTag(watch));

    box.append(head);
    if (account.configured && watch) box.append(healthLine(watch));

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
          // Связь есть, а публикация может не пройти: id аккаунта в карточке
          // и у площадки бывают разными. Молчать об этом нельзя — зелёная
          // всплывашка тогда врёт.
          if (res.warning) toast(`${account.title}: ${res.warning}`, 'warn');
          else toast(`${account.title}: связь есть — ${res.account || res.chat || res.bot || 'ок'}`, 'ok');
        } catch (err) {
          toast(`${account.title}: ${err.message}`, 'danger');
        } finally {
          check.disabled = false;
        }
      },
    });
    foot.append(check);

    // Подключение кнопкой — у Threads. Генератор токенов в кабинете Meta
    // выдаёт фиксированный набор прав без удаления, а здесь права просим
    // явно, и токен с ID ложатся в карточку сами (13.09.2026).
    if (account.platform === 'threads') {
      const ready = account.fields.some((f) => f.key === 'appId' && f.filled) &&
        account.fields.some((f) => f.key === 'appSecret' && f.filled);
      const connect = button(account.configured ? 'Переподключить через Threads' : 'Подключить через Threads', {
        // Главной кнопка становится, только когда ей есть чем работать: пока
        // приложение не вписано, главное действие здесь — «Сохранить», и две
        // золотые кнопки подряд спорили бы за внимание.
        variant: ready && !account.configured ? 'primary' : '',
        iconName: 'threads',
        title: ready ? 'Откроется окно Threads — войдите под аккаунтом школы' : 'Сначала сохраните ID и секрет приложения Threads',
        onClick: async () => {
          connect.disabled = true;
          try {
            const { url } = await api.startThreadsOauth(project.id);
            // Уходим в Threads в этой же вкладке: окно согласия открывается
            // в сессии браузера, и отдельная вкладка ничего не меняет.
            location.href = url;
          } catch (err) {
            toast(err.message, 'danger');
            connect.disabled = false;
          }
        },
      });
      foot.append(connect);
    }

    // TikTok — только кнопкой: токен живёт сутки, refresh token выдаётся лишь
    // окном согласия, вписать их руками было бы бессмысленно (14.09.2026).
    if (account.platform === 'tiktok') {
      const ready = account.fields.some((f) => f.key === 'clientKey' && f.filled) &&
        account.fields.some((f) => f.key === 'clientSecret' && f.filled);
      const connect = button(account.configured ? 'Переподключить через TikTok' : 'Подключить через TikTok', {
        variant: ready && !account.configured ? 'primary' : '',
        iconName: 'tiktok',
        title: ready ? 'Откроется окно TikTok — войдите под аккаунтом школы' : 'Сначала сохраните Client key и Client secret приложения TikTok',
        onClick: async () => {
          connect.disabled = true;
          try {
            const { url } = await api.startTiktokOauth(project.id);
            location.href = url;
          } catch (err) {
            toast(err.message, 'danger');
            connect.disabled = false;
          }
        },
      });
      foot.append(connect);
    }

    // Facebook и Instagram подключаются одним входом: токен у них общий —
    // токен страницы, а Instagram находится по странице. Поэтому кнопка есть
    // в обеих карточках и ведёт в одно и то же окно.
    if (account.platform === 'facebook' || account.platform === 'instagram') {
      const connect = button('Подключить через Facebook', {
        iconName: 'facebook',
        title: 'Откроется окно Facebook. Нынешние токены не заменятся, пока вы не выберете страницу и панель не проверит замену',
        onClick: async () => {
          connect.disabled = true;
          try {
            const { url } = await api.startFacebookOauth(project.id);
            location.href = url;
          } catch (err) {
            toast(err.message, 'danger');
            connect.disabled = false;
          }
        },
      });
      foot.append(connect);
    }

    // Продление руками — только там, где площадка это умеет. У Facebook и
    // Instagram кнопки продления нет намеренно: их токен страницы бессрочный.
    if (account.configured && watch?.renewable) {
      const renew = button('Продлить токен', {
        iconName: 'refresh',
        title: 'Обычно сторож продлевает сам за две недели до смерти',
        onClick: async () => {
          renew.disabled = true;
          try {
            const res = await api.renewToken(project.id, account.platform);
            toast(`${account.title}: токен продлён до ${res.expiresAt?.slice(0, 10) || '—'}`, 'ok');
            await renderCard();
          } catch (err) {
            // Без приставки с названием: адаптер продления уже начинает
            // сообщение с площадки, и выходило «Threads: Threads продление…».
            toast(err.message, 'danger');
            renew.disabled = false;
          }
        },
      });
      foot.append(renew);
    }

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
        const res = await api.saveAccount(project.id, account.platform, payload);
        // Сервер мог сам поправить ID аккаунта по ответу площадки — сказать
        // об этом отдельно, иначе человек не поймёт, откуда в поле другое число.
        if (res.notice) toast(`${account.title}: ${res.notice}`, res.notice.startsWith('сохранено, но') ? 'warn' : 'ok');
        else toast(`${account.title}: сохранено`, 'ok');
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

/* ----------------------------- сроки токенов ----------------------------- */

/**
 * Плашка со сроком у названия площадки.
 *
 * Главное здесь — разница между «истёк» и «не отвечает». Первое лечится
 * новым токеном по сроку, второе означает, что доступ отобрали прямо сейчас:
 * сменили пароль, вышли из всех сеансов, сняли права приложению. Лечится это
 * по-разному, и валить их в одно «ошибка» значит отправить владельца искать
 * не там.
 */
function healthTag(watch) {
  const kinds = {
    ok: ['tag--ok', watch.expiresAt ? `ещё ${watch.left} дн.` : 'бессрочный'],
    // Порог тот же, что у подробностей ниже: жёлтая плашка над красной
    // запиской читается как «да ничего страшного» — ровно наоборот смыслу.
    soon: [watch.left <= 3 ? 'tag--danger' : 'tag--warn', watch.reason === 'data' ? `данные: ${watch.left} дн.` : `${watch.left} дн.`],
    // Кончился доступ к данным — не «истёк»: сам токен может быть бессрочным.
    expired: ['tag--danger', watch.reason === 'data' ? 'нет доступа к данным' : 'истёк'],
    broken: ['tag--danger', 'не отвечает'],
    unknown: ['', 'срок неизвестен'],
  };
  const [cls, text] = kinds[watch.state] || kinds.unknown;

  const tag = el('span', `tag ${cls}`.trim(), text);
  tag.style.marginLeft = 'auto';
  tag.title = watch.why || '';
  return tag;
}

/** Подробности под карточкой — только когда есть о чём беспокоиться. */
function healthLine(watch) {
  const when = watch.expiresAt ? humanDate(new Date(watch.expiresAt)) : null;
  // Расчётный срок так и называем: у Threads его негде спросить, и выдавать
  // догадку за точную дату — значит однажды подвести на день раньше.
  const guess = watch.estimated ? ' Срок посчитан от дня, когда токен вписали, а не прочитан у площадки.' : '';

  if (watch.state === 'broken') {
    return note(
      'danger',
      'Площадка не пускает с этим токеном',
      `${watch.error || 'проверка не прошла'}. Так выглядит отозванный доступ: смена пароля, выход из всех сеансов или снятые права приложению. Публикация туда не уйдёт.`
    );
  }
  // Доступ к данным (правило Meta, 90 дней без входа) лечится не продлением и
  // не перевыпуском токена, а входом кнопкой. Так и говорим — иначе человек
  // пойдёт менять токен, который в полном порядке.
  if (watch.reason === 'data' && (watch.state === 'expired' || watch.state === 'soon')) {
    const whenData = watch.dataAccessAt ? humanDate(new Date(watch.dataAccessAt)) : '';
    const cure = watch.reconnect
      ? `Продлевается входом: кнопка «${watch.reconnect}» здесь, в карточке. Нажать «Отмена» на экране выбора можно — сам вход уже продлевает срок, токен при этом не меняется.`
      : 'Продлевается повторным входом в приложение.';
    return watch.state === 'expired'
      ? note('danger', `Доступ к данным кончился ${whenData}`, `Правило Meta: 90 дней без входа в приложение. Публикация может перестать проходить. ${cure}`)
      : note(watch.left <= 3 ? 'danger' : 'warn', `Доступ к данным кончится ${whenData} — осталось дней: ${watch.left}`, `Правило Meta: 90 дней без входа в приложение. Сам токен при этом живой. ${cure}`);
  }
  if (watch.state === 'expired') {
    // Отдельно про продление: истёкший Threads продлить уже нельзя, и звать
    // человека жать кнопку «Продлить» здесь значит звать его впустую.
    const dead = watch.renewable ? ' Продлить его уже нельзя — выпускается только заново.' : '';
    return note('danger', `Токен истёк ${when}`, `Публикация на эту площадку не уйдёт — нужен новый токен.${dead}${guess}`);
  }
  if (watch.state === 'soon') {
    // Для площадки, которая продлевается сама, паника неуместна: сторож уже
    // пробовал и попробует снова через шесть часов. Но и молчать нельзя —
    // если он пробует и не может, человек должен об этом знать.
    const hint = watch.renewable
      ? `Сторож продлевает такой токен сам за две недели до смерти. Если срок не сдвинулся за сутки, продление не проходит — посмотрите журнал.${guess}`
      : `Выпустить новый лучше заранее: после смерти постинг встанет молча.${guess}`;
    return note(watch.left <= 3 ? 'danger' : 'warn', `Токен умрёт ${when} — осталось дней: ${watch.left}`, hint);
  }

  const line = el('div', 'dim small');
  const renew = watch.renewNote ? ` · ${watch.renewNote.toLowerCase()}` : '';
  // Второй срок — на виду и когда всё в порядке: 90 дней проходят незаметно.
  const data = watch.dataAccessAt ? ` · доступ к данным до ${humanDate(new Date(watch.dataAccessAt))}` : '';
  line.textContent = watch.checkedAt
    ? `Сторож проверял ${stampToLocal(watch.checkedAt)}${renew}${data}${watch.error ? ` · срок не прочитан (${watch.error})` : ''}`
    : 'Сторож ещё не проверял';
  return line;
}

/**
 * Отметка сторожа — в местное время.
 *
 * `checked_at` пишется через `datetime('now')`, а это UTC: показать её как
 * есть значит сообщить киевскому владельцу, что проверка была три часа назад,
 * когда она была только что. Время постов, наоборот, местное и правки не
 * требует — см. `toLocalInput`.
 */
function stampToLocal(stamp) {
  const d = new Date(`${stamp.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return stamp;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${humanDate(d)}, ${time}`;
}
