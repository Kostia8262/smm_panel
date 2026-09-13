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

    // Продление руками — только там, где площадка это умеет. У Facebook и
    // Instagram кнопки нет намеренно: их токен страницы меняется не здесь,
    // а выпуском от системного пользователя в Business Manager.
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
    soon: [watch.left <= 3 ? 'tag--danger' : 'tag--warn', `${watch.left} дн.`],
    expired: ['tag--danger', 'истёк'],
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
  line.textContent = watch.checkedAt
    ? `Сторож проверял ${stampToLocal(watch.checkedAt)}${renew}${watch.error ? ` · срок не прочитан (${watch.error})` : ''}`
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
