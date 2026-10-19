/**
 * Материалы бота: блоки, на которые он опирается.
 *
 * Отличие от ответов нарочно видно на экране: ответ уходит клиенту дословно,
 * материал — справка, из которой ответ делается кнопкой. Часть блоков
 * собирается с сайта школы, часть владелец пишет сам.
 */

import { api } from '../../api.js';
import { el, button, iconButton, panel, note, empty, toast } from '../../ui.js';
import { icon } from '../../icons.js';

export function materialsView(ctx, { tabs }) {
  const box = el('div', 'view');
  let data = null;
  let specs = null;
  let editing = null;
  let filter = { archived: false, section: '', search: '' };
  // Итог последнего сбора. Держим в состоянии: перерисовка после сбора иначе
  // стирала предложение завести ответы раньше, чем его успевали прочитать.
  let collected = null;

  const host = el('div', 'stack');
  box.append(tabs, host);
  load();
  return box;

  async function load() {
    host.textContent = '';
    host.append(el('p', 'field__hint', 'Читаю материалы…'));
    try {
      [data, specs] = await Promise.all([api.botMaterials(params()), specs ? Promise.resolve(specs) : api.botSpecs()]);
    } catch (err) {
      host.textContent = '';
      host.append(note('danger', 'Материалы не прочитались', err.message));
      return;
    }
    render();
  }

  function params() {
    const p = {};
    if (filter.archived) p.archived = '1';
    if (filter.section) p.section = filter.section;
    if (filter.search) p.search = filter.search;
    return p;
  }

  function render() {
    host.textContent = '';
    host.append(collectPanel());
    if (editing) host.append(editorPanel());
    host.append(listPanel());
  }

  /* ------------------------------ сбор с сайта ------------------------------ */

  function collectPanel() {
    const p = panel('Собрать с сайта школы');
    const body = el('div', 'stack');
    p.append(body);

    body.append(
      el(
        'p',
        'field__hint',
        `Сайт отдаёт курсы с возрастом и ценой, тарифы, частые вопросы на двух языках, телефоны и филиалы. Панель разложит это блоками. Собранное обновляется на месте при повторном сборе — ваши собственные блоки не трогает.`
      )
    );

    const row = el('div', 'bot-tools');
    row.append(el('span', 'field__hint', `Источник: ${data.siteUrl || 'не задан — впишите адрес в настройках бота'}`));
    if (data.canManage && data.siteUrl) {
      row.append(
        button('Собрать сейчас', {
          variant: 'primary',
          iconName: 'download',
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Собираю…';
            try {
              collected = await api.collectBotMaterials();
              toast(`Собрано: ${collected.stats.added} новых, ${collected.stats.updated} обновлено`, 'ok');
              await load();
            } catch (err) {
              toast(err.message, 'danger');
              btn.disabled = false;
              btn.textContent = 'Собрать сейчас';
            }
          },
        })
      );
    }
    body.append(row);
    if (collected) renderCollected(body, collected);
    return p;
  }

  function renderCollected(hostNode, res) {
    if (!res.answers?.length) return;

    // Вопросы с сайта — готовые пары «вопрос — ответ». Заводить их молча
    // нельзя: это текст, который уйдёт клиенту от имени школы.
    const box = el('div', 'stack bot-offer');
    box.append(
      note(
        'ok',
        `На сайте нашлось ${res.answers.length} готовых вопросов`,
        'Это частые вопросы с их же ответами. Можно сразу сделать из них ответы бота — потом отредактируете.'
      )
    );
    const list = el('div', 'bot-offer__list');
    for (const a of res.answers.slice(0, 12)) {
      list.append(el('div', 'bot-offer__row', `${a.lang === 'ru' ? 'RU' : 'UA'} · ${a.question}`));
    }
    box.append(list);
    const actions = el('div', 'bot-actions');
    actions.append(
      button(`Сделать ответами (${res.answers.length})`, {
        variant: 'primary',
        iconName: 'check',
        onClick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await api.createBotAnswers(res.answers);
            toast(`Заведено ответов: ${r.created}`, 'ok');
            location.hash = '#/bot';
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      }),
      button('Не сейчас', {
        onClick: () => {
          collected = null;
          box.remove();
        },
      })
    );
    box.append(actions);
    hostNode.append(box);
  }

  /* -------------------------------- редактор -------------------------------- */

  function editorPanel() {
    const material = editing === 'new' ? null : data.materials.find((m) => m.id === editing);
    if (editing !== 'new' && !material) {
      editing = null;
      return el('div');
    }

    const p = panel(material ? 'Правка блока' : 'Новый блок');
    const form = el('div', 'stack');
    p.append(form);

    const fields = {};
    const grid = el('div', 'bot-form__grid');
    grid.append(
      field('Раздел', (fields.section = sectionSelect(material?.section || filter.section || 'own'))),
      field('Ссылка на источник, если есть', (fields.sourceUrl = input(material?.sourceUrl || '', 'https://mycomputer.education/courses/python')))
    );
    form.append(
      field('Название блока', (fields.title = input(material?.title || '', 'Курс Python для підлітків'))),
      grid,
      field(
        'Содержание',
        (fields.body = textarea(material?.body || '', 8, 'Вік: 12–16\nТриває: 9 місяців\nЩо на виході: власний проєкт і портфоліо')),
        'Пишите фактами и строками — так из блока проще сделать короткий ответ клиенту.'
      )
    );

    const actions = el('div', 'bot-actions');
    actions.append(
      button(material ? 'Сохранить' : 'Добавить блок', {
        variant: 'primary',
        iconName: 'check',
        onClick: async () => {
          const body = {
            section: fields.section.value,
            title: fields.title.value,
            body: fields.body.value,
            sourceUrl: fields.sourceUrl.value,
          };
          try {
            if (material) await api.updateBotMaterial(material.id, body);
            else await api.createBotMaterial(body);
            toast(material ? 'Блок сохранён' : 'Блок добавлен', 'ok');
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
    const p = panel(filter.archived ? 'Архив блоков' : 'Блоки');
    const head = p.querySelector('.panel__head');
    if (!filter.archived) {
      head.append(
        button('Новый блок', {
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
          filter = { ...filter, archived: !filter.archived, section: '' };
          editing = null;
          load();
        },
      })
    );

    // Поиск и разделы — НАД списком: внизу, под двумя десятками блоков, их
    // просто не видно.
    const body = el('div', 'stack');
    p.append(tools(), body);

    if (!data.materials.length) {
      body.append(
        filter.search || filter.section || filter.archived
          ? empty('search', 'Ничего не нашлось', 'Другое слово или снимите фильтр')
          : empty(
              'layers',
              'Материалов пока нет',
              'Нажмите «Собрать сейчас» — панель заберёт курсы, цены, вопросы и контакты с сайта школы. Остальное допишете блоками.'
            )
      );
      return p;
    }

    let section = null;
    for (const m of data.materials) {
      if (m.section !== section) {
        section = m.section;
        body.append(el('div', 'bot-group bot-group--plain', m.sectionTitle));
      }
      body.append(card(m));
    }
    return p;
  }

  function tools() {
    const row = el('div', 'bot-tools');

    const search = el('div', 'search');
    search.append(icon('search', { size: 16, className: 'search__icon' }));
    const input = el('input', 'input');
    input.placeholder = 'Поиск по материалам';
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
    const all = el('button', 'chip', 'Все разделы');
    all.type = 'button';
    if (!filter.section) all.setAttribute('aria-pressed', 'true');
    all.addEventListener('click', () => {
      filter = { ...filter, section: '' };
      load();
    });
    chips.append(all);
    for (const s of data.sections) {
      if (!s.total) continue;
      const chip = el('button', 'chip', `${s.title} · ${s.total}`);
      chip.type = 'button';
      if (filter.section === s.id) chip.setAttribute('aria-pressed', 'true');
      chip.addEventListener('click', () => {
        filter = { ...filter, section: s.id };
        load();
      });
      chips.append(chip);
    }
    row.append(chips);
    return row;
  }

  function card(m) {
    const box = el('div', 'bot-card');

    const head = el('div', 'bot-card__head');
    head.append(el('div', 'bot-card__title', m.title));
    if (m.origin === 'site') head.append(el('span', 'tag', 'с сайта'));
    head.append(el('span', 'bot-card__spacer'));

    if (filter.archived) {
      head.append(
        button('Вернуть', {
          variant: 'quiet',
          onClick: async () => {
            await api.archiveBotMaterial(m.id, false);
            toast('Блок вернулся', 'ok');
            load();
          },
        })
      );
    } else {
      head.append(
        button('Сделать ответом', {
          variant: 'quiet',
          iconName: 'chat',
          title: 'Завести короткий ответ клиенту на основе этого блока',
          onClick: async () => {
            try {
              const { draft } = await api.botMaterialAnswer(m.id);
              sessionStorage.setItem('smm.bot.draft', JSON.stringify(draft));
              location.hash = '#/bot?draft=1';
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        }),
        iconButton('settings', {
          title: 'Править',
          onClick: () => {
            editing = m.id;
            render();
          },
        }),
        iconButton('archive', {
          title: 'В архив',
          onClick: async () => {
            await api.archiveBotMaterial(m.id, true);
            toast('Блок в архиве — его можно вернуть', 'ok');
            load();
          },
        })
      );
    }
    box.append(head);
    box.append(el('div', 'bot-card__body', m.body));

    if (m.sourceUrl) {
      const link = el('a', 'bot-card__src', m.sourceUrl);
      link.href = m.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      box.append(link);
    }
    return box;
  }

  /* --------------------------------- мелочи --------------------------------- */

  function field(label, control, hint) {
    const f = el('div', 'field');
    f.append(el('label', 'field__label', label), control);
    if (hint) f.append(el('div', 'field__hint', hint));
    return f;
  }

  function input(value, placeholder = '') {
    const node = el('input', 'input');
    node.value = value;
    node.placeholder = placeholder;
    return node;
  }

  function textarea(value, rows, placeholder = '') {
    const node = el('textarea', 'textarea');
    node.value = value;
    node.rows = rows;
    node.placeholder = placeholder;
    return node;
  }

  function sectionSelect(current) {
    const node = el('select', 'select');
    for (const [id, cfg] of Object.entries(specs.sections)) {
      const opt = el('option', '', cfg.title);
      opt.value = id;
      if (id === current) opt.selected = true;
      node.append(opt);
    }
    return node;
  }
}
