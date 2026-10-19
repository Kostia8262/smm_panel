/**
 * База знаний бота: список ответов, правка и проверка подбора.
 *
 * Экран устроен вокруг одной мысли: «ответ записан» и «бот его находит» —
 * разные вещи. Поэтому проверка вопроса стоит сверху, до списка, и после
 * каждой правки её видно сразу.
 */

import { api } from '../../api.js';
import { el, button, iconButton, panel, note, empty, toast, projectTabs } from '../../ui.js';
import { icon } from '../../icons.js';

const DECISION_LOOK = {
  answer: { tag: 'tag--ok', title: 'Ответит сам' },
  draft: { tag: 'tag--warn', title: 'Черновик человеку' },
  handoff: { tag: 'tag--warn', title: 'Позовёт человека' },
  stop: { tag: 'tag--danger', title: 'Стоп-тема' },
};

const LANG_TITLE = { any: 'Любой', uk: 'Укр', ru: 'Рус' };
const CHANNEL_TITLE = { any: 'Везде', direct: 'Direct', messenger: 'Messenger', comments: 'Комментарии' };

export function knowledgeView(ctx) {
  const box = el('div', 'view');
  let data = null;
  let specs = null;
  let editing = null; // id правимой записи или 'new'
  let filter = { archived: false, topic: '', search: '' };

  ctx.setTopbar({
    title: 'Бот-консультант',
    subtitle: 'База знаний: по ней бот отвечает клиентам',
    actions: [
      button('Настройки бота', { iconName: 'settings', onClick: () => (location.hash = '#/bot/settings') }),
    ],
  });

  box.append(
    projectTabs({
      projects: ctx.state.projects,
      current: ctx.state.projectId,
      onPick: (id) => ctx.switchProject(id),
    })
  );

  const host = el('div', 'stack');
  box.append(host);
  load();
  return box;

  async function load() {
    host.textContent = '';
    host.append(el('p', 'field__hint', 'Читаю базу знаний…'));
    try {
      [data, specs] = await Promise.all([api.botKnowledge(filterParams()), specs ? Promise.resolve(specs) : api.botSpecs()]);
    } catch (err) {
      host.textContent = '';
      host.append(note('danger', 'База знаний не прочиталась', err.message));
      return;
    }
    render();
  }

  function filterParams() {
    const p = {};
    if (filter.archived) p.archived = '1';
    if (filter.topic) p.topic = filter.topic;
    if (filter.search) p.search = filter.search;
    return p;
  }

  function render() {
    host.textContent = '';
    host.append(stateNote());
    host.append(tryPanel());
    if (editing) host.append(editorPanel());
    host.append(listPanel());
  }

  /* ----------------------------- состояние бота ----------------------------- */

  function stateNote() {
    const s = data.settings;
    const live = data.entries.filter((e) => e.active).length;
    if (!s.enabled) {
      return note(
        'warn',
        'Бот выключен — клиентам ничего не уходит',
        live
          ? `В базе ${live} ${plural(live, 'ответ', 'ответа', 'ответов')}. Проверьте их вопросами клиентов и включите бота в настройках.`
          : 'Заведите первые ответы — и включите бота в настройках, когда проверите подбор.'
      );
    }
    return note(
      'ok',
      s.autoReply ? 'Бот отвечает клиентам сам' : 'Бот готовит черновики',
      `${live} ${plural(live, 'ответ', 'ответа', 'ответов')} в работе. Стоп-темы и незнакомые вопросы уходят человеку.`
    );
  }

  /* ------------------------------- проверка -------------------------------- */

  function tryPanel() {
    const p = panel('Спросите как клиент');
    const body = el('div', 'stack');
    p.append(body);

    body.append(
      el(
        'p',
        'field__hint',
        'Напишите вопрос теми словами, какими его пишут в Direct, — увидите, какую запись бот выберет и что именно отправит. Наполнять базу вслепую нельзя: ответ может лежать и не находиться.'
      )
    );

    const row = el('div', 'bot-try');
    const input = el('textarea', 'textarea bot-try__text');
    input.rows = 2;
    input.placeholder = 'Скільки коштує курс для дитини 9 років?';

    const channel = el('select', 'select');
    for (const id of specs.channelList) {
      const opt = el('option', '', specs.channels[id].title);
      opt.value = id;
      channel.append(opt);
    }

    const resultHost = el('div', 'bot-try__result');

    const ask = button('Что ответит бот', {
      variant: 'primary',
      iconName: 'search',
      onClick: async () => {
        const text = input.value.trim();
        if (!text) return toast('Напишите вопрос');
        resultHost.textContent = '';
        resultHost.append(el('p', 'field__hint', 'Подбираю…'));
        try {
          renderTry(resultHost, await api.tryBot(text, channel.value));
        } catch (err) {
          resultHost.textContent = '';
          resultHost.append(note('danger', 'Не вышло', err.message));
        }
      },
    });

    input.addEventListener('keydown', (e) => {
      // Enter — спросить, Shift+Enter — перенос строки: вопросы проверяют
      // десятками подряд, и тянуться к мыши каждый раз незачем.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ask.click();
      }
    });

    const tools = el('div', 'bot-try__tools');
    tools.append(channel, ask);
    row.append(input, tools);
    body.append(row, resultHost);
    return p;
  }

  function renderTry(hostNode, res) {
    hostNode.textContent = '';
    const look = DECISION_LOOK[res.decision] || DECISION_LOOK.handoff;

    const head = el('div', 'bot-verdict');
    head.append(el('span', `tag ${look.tag}`, look.title));
    if (res.entry) head.append(el('span', 'bot-verdict__score', `счёт ${res.score} · ${res.why}`));
    else head.append(el('span', 'bot-verdict__score', res.why));
    if (res.lang) head.append(el('span', 'tag', res.lang === 'uk' ? 'Вопрос украинский' : 'Вопрос русский'));
    hostNode.append(head);

    if (res.willSend) {
      hostNode.append(el('div', 'bot-sent__label', 'Уйдёт клиенту:'));
      hostNode.append(el('div', 'bot-sent', res.willSend));
    } else {
      const why =
        res.decision === 'stop'
          ? 'Ничего не уйдёт: на стоп-темы бот молчит намеренно — «передам человеку» в ответ на жалобу читается как отписка.'
          : !res.settings.enabled
            ? 'Ничего не уйдёт: бот выключен. Запись подобрана — значит заработает, как включите.'
            : res.decision === 'draft'
              ? 'Ничего не уйдёт само: счёт ниже уверенного, ответ попадёт человеку черновиком. Добавьте эту формулировку в зацепки записи — и бот станет отвечать сам.'
              : res.decision === 'answer' && !res.settings.autoReply
                ? 'Ничего не уйдёт само: включён режим черновиков.'
                : 'Ничего не уйдёт: подходящей записи нет. Это и есть повод её завести.';
      hostNode.append(el('p', 'field__hint field__hint--warn', why));
    }

    if (res.entry) {
      const found = el('div', 'bot-found');
      found.append(el('div', 'bot-found__q', res.entry.question));
      if (res.entry.topic) found.append(el('span', 'chip', res.entry.topic));
      found.append(
        button('Править эту запись', {
          variant: 'quiet',
          onClick: () => {
            editing = res.entry.id;
            render();
          },
        })
      );
      hostNode.append(found);
    } else if (res.decision !== 'stop') {
      hostNode.append(
        button('Завести ответ на этот вопрос', {
          variant: 'primary',
          iconName: 'plus',
          onClick: () => {
            editing = 'new';
            render();
            const q = document.querySelector('.bot-form [name="question"]');
            if (q) q.focus();
          },
        })
      );
    }

    if (res.candidates?.length > 1) {
      const list = el('div', 'bot-cands');
      list.append(el('div', 'bot-cands__title', 'С чем конкурировало:'));
      for (const c of res.candidates.slice(1)) {
        list.append(el('div', 'bot-cands__row', `${c.score} — ${c.question} (${c.why})`));
      }
      hostNode.append(list);
    }
  }

  /* -------------------------------- редактор -------------------------------- */

  function editorPanel() {
    const entry = editing === 'new' ? null : data.entries.find((e) => e.id === editing);
    if (editing !== 'new' && !entry) {
      editing = null;
      return el('div');
    }

    const p = panel(entry ? 'Правка ответа' : 'Новый ответ');
    const form = el('div', 'stack bot-form');
    p.append(form);

    const fields = {};
    form.append(
      field('Вопрос клиента, как он называется у нас', (fields.question = input(entry?.question || '', 'Скільки коштує навчання', 'question'))),
      field('Ответ, который уйдёт клиенту', (fields.answer = textarea(entry?.answer || '', 5)), counterHint(fields.answer)),
      field(
        'Зацепки: как этот вопрос звучит в жизни — по одной в строке',
        (fields.triggers = textarea(entry?.triggers || '', 5, 'скільки коштує\nсколько стоит\nціна\nпрайс')),
        'Живые слова клиента, включая опечатки и латиницу. Это главное поле подбора: по нему бот и находит ответ.'
      )
    );

    const grid = el('div', 'bot-form__grid');
    grid.append(
      field('Рубрика', (fields.topic = input(entry?.topic || '', 'ціни')), hintTopics()),
      field('Язык ответа', (fields.lang = select(specs.langs, entry?.lang || 'any'))),
      field('Канал', (fields.channel = select({ any: { title: 'Везде' }, ...specs.channels }, entry?.channel || 'any'))),
      field('Приоритет', (fields.priority = numberInput(entry?.priority || 0)), 'При равном счёте выигрывает больший')
    );
    form.append(grid);

    const actions = el('div', 'bot-actions');
    actions.append(
      button(entry ? 'Сохранить' : 'Добавить ответ', {
        variant: 'primary',
        iconName: 'check',
        onClick: async () => {
          const body = {
            question: fields.question.value,
            answer: fields.answer.value,
            triggers: fields.triggers.value,
            topic: fields.topic.value,
            lang: fields.lang.value,
            channel: fields.channel.value,
            priority: Number(fields.priority.value) || 0,
          };
          try {
            if (entry) await api.updateBotEntry(entry.id, body);
            else await api.createBotEntry(body);
            toast(entry ? 'Ответ сохранён' : 'Ответ добавлен', 'ok');
            editing = null;
            await load();
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      }),
      button('Отмена', {
        onClick: () => {
          editing = null;
          render();
        },
      })
    );
    form.append(actions);
    return p;
  }

  /* --------------------------------- список --------------------------------- */

  function listPanel() {
    const p = panel(filter.archived ? 'Архив ответов' : 'Ответы');
    const head = p.querySelector('.panel__head');

    if (!filter.archived) {
      head.append(
        button('Новый ответ', {
          variant: 'primary',
          iconName: 'plus',
          onClick: () => {
            editing = 'new';
            render();
          },
        })
      );
    }
    head.append(
      button(filter.archived ? 'К рабочим' : 'Архив', {
        variant: 'quiet',
        iconName: 'archive',
        onClick: () => {
          filter = { ...filter, archived: !filter.archived, topic: '' };
          editing = null;
          load();
        },
      })
    );

    const body = el('div', 'stack');
    p.append(body);

    body.append(tools());

    if (!data.entries.length) {
      body.append(
        filter.archived || filter.search || filter.topic
          ? empty('search', 'Ничего не нашлось', 'Попробуйте другое слово или снимите фильтр')
          : empty(
              'chat',
              'База знаний пустая',
              'Начните с того, о чём спрашивают каждый день: цены, расписание, пробное занятие, возраст, адрес. Один вопрос — одна запись.'
            )
      );
      return p;
    }

    const table = el('table', 'table bot-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const [title, cls] of [['Вопрос', ''], ['Зацепок', 'num'], ['Язык', ''], ['Канал', ''], ['Спросили', 'num'], ['', '']]) {
      hr.append(el('th', cls, title));
    }
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    let topic = null;
    for (const entry of data.entries) {
      if (entry.topic !== topic) {
        topic = entry.topic;
        const tr = el('tr', 'bot-group');
        const td = el('td', '', topic || 'Без рубрики');
        td.colSpan = 6;
        tr.append(td);
        tbody.append(tr);
      }
      tbody.append(row(entry));
    }
    table.append(tbody);
    const wrap = el('div', 'scroll-x');
    wrap.append(table);
    body.append(wrap);
    return p;
  }

  function tools() {
    const row = el('div', 'bot-tools');

    const search = el('div', 'search');
    search.append(icon('search', { size: 16, className: 'search__icon' }));
    const input = el('input', 'input');
    input.placeholder = 'Поиск по вопросам и ответам';
    input.value = filter.search;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        filter = { ...filter, search: input.value.trim() };
        load();
      }, 300);
    });
    search.append(input);
    row.append(search);

    const chips = el('div', 'chips chips--wrap');
    const all = el('button', 'chip', 'Все рубрики');
    all.type = 'button';
    if (!filter.topic) all.setAttribute('aria-pressed', 'true');
    all.addEventListener('click', () => {
      filter = { ...filter, topic: '' };
      load();
    });
    chips.append(all);
    for (const t of data.topics) {
      const chip = el('button', 'chip', `${t.topic || 'без рубрики'} · ${t.total}`);
      chip.type = 'button';
      if (filter.topic === t.topic) chip.setAttribute('aria-pressed', 'true');
      chip.addEventListener('click', () => {
        filter = { ...filter, topic: t.topic };
        load();
      });
      chips.append(chip);
    }
    row.append(chips);
    return row;
  }

  function row(entry) {
    const tr = el('tr');
    if (!entry.active) tr.classList.add('bot-row--off');

    const tdQ = el('td');
    tdQ.append(el('div', 'bot-q', entry.question));
    tdQ.append(el('div', 'bot-a', entry.answer));
    tr.append(tdQ);

    tr.append(el('td', 'num', String(entry.triggerCount)));
    tr.append(el('td', '', LANG_TITLE[entry.lang] || entry.lang));
    tr.append(el('td', '', CHANNEL_TITLE[entry.channel] || entry.channel));
    tr.append(el('td', 'num', entry.hits ? String(entry.hits) : '—'));

    const tdActions = el('td');
    const actions = el('div', 'bot-row-actions');
    if (filter.archived) {
      actions.append(
        button('Вернуть', {
          variant: 'quiet',
          onClick: async () => {
            await api.archiveBotEntry(entry.id, false);
            toast('Ответ вернулся в работу', 'ok');
            load();
          },
        })
      );
    } else {
      actions.append(
        iconButton('settings', {
          title: 'Править',
          onClick: () => {
            editing = entry.id;
            render();
          },
        }),
        iconButton(entry.active ? 'pause' : 'play', {
          title: entry.active ? 'Выключить, не удаляя' : 'Включить',
          onClick: async () => {
            try {
              await api.updateBotEntry(entry.id, { active: !entry.active });
              load();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        }),
        iconButton('archive', {
          title: 'В архив',
          onClick: async () => {
            await api.archiveBotEntry(entry.id, true);
            toast('Ответ в архиве — его можно вернуть', 'ok');
            load();
          },
        })
      );
    }
    tdActions.append(actions);
    tr.append(tdActions);
    return tr;
  }

  /* --------------------------------- мелочи --------------------------------- */

  function hintTopics() {
    return `Можно своё. Обычные: ${specs.topicHints.slice(0, 6).join(', ')}`;
  }

  /**
   * Подсказка под ответом со живым счётчиком. Предел берём с сервера: он
   * задан пределом Direct, а не вкусом.
   */
  function counterHint(area) {
    const max = specs.limits.answerMax;
    const node = el('div', 'field__hint');
    const paint = () => {
      const len = area.value.length;
      node.textContent = `${len} из ${max} символов — дальше Direct обрежет`;
      node.classList.toggle('field__hint--warn', len > max);
    };
    area.addEventListener('input', paint);
    paint();
    return node;
  }

  function field(label, control, hint) {
    const f = el('div', 'field');
    f.append(el('label', 'field__label', label), control);
    if (hint instanceof Node) f.append(hint);
    else if (hint) f.append(el('div', 'field__hint', hint));
    return f;
  }

  function input(value, placeholder = '', name = '') {
    const node = el('input', 'input');
    node.value = value;
    node.placeholder = placeholder;
    if (name) node.name = name;
    return node;
  }

  function numberInput(value) {
    const node = el('input', 'input');
    node.type = 'number';
    node.value = String(value);
    return node;
  }

  function textarea(value, rows, placeholder = '') {
    const node = el('textarea', 'textarea');
    node.value = value;
    node.rows = rows;
    node.placeholder = placeholder;
    return node;
  }

  function select(options, current) {
    const node = el('select', 'select');
    for (const [id, cfg] of Object.entries(options)) {
      const opt = el('option', '', cfg.title || id);
      opt.value = id;
      if (id === current) opt.selected = true;
      node.append(opt);
    }
    return node;
  }
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
