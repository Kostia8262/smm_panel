/**
 * Настройки бота: включение, режим, каналы, ответ «не знаю», свои стоп-темы.
 *
 * Эти переключатели решают, что уйдёт клиенту без человека, поэтому они за
 * владельцем (право `bot_settings`), а СММщик видит их только на чтение.
 */

import { api } from '../../api.js';
import { el, button, panel, note, toast, projectTabs } from '../../ui.js';
import { icon } from '../../icons.js';

export function botSettingsView(ctx) {
  const box = el('div', 'view');
  let settings = null;
  let specs = null;
  let canManage = false;

  ctx.setTopbar({
    title: 'Настройки бота',
    subtitle: 'Что уходит клиенту без человека',
    actions: [button('К базе знаний', { iconName: 'chat', onClick: () => (location.hash = '#/bot') })],
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
    host.append(el('p', 'field__hint', 'Читаю настройки…'));
    try {
      const [cfg, sp] = await Promise.all([api.botSettings(), specs ? Promise.resolve(specs) : api.botSpecs()]);
      settings = cfg.settings;
      canManage = cfg.canManage;
      specs = sp;
    } catch (err) {
      host.textContent = '';
      host.append(note('danger', 'Настройки не прочитались', err.message));
      return;
    }
    render();
  }

  async function save(patch, word) {
    try {
      settings = (await api.saveBotSettings(patch)).settings;
      toast(word, 'ok');
      render();
    } catch (err) {
      toast(err.message, 'danger');
      render();
    }
  }

  function render() {
    host.textContent = '';
    if (!canManage) {
      host.append(
        note(
          'warn',
          'Настройки меняет владелец',
          'Вам видно, как бот настроен сейчас. База знаний открыта на правку — именно она решает, что бот отвечает.'
        )
      );
    }
    host.append(mainPanel(), textsPanel(), stopPanel());
  }

  /* ------------------------------ включение ------------------------------ */

  function mainPanel() {
    const p = panel('Работа бота');
    const body = el('div', 'stack');
    p.append(body);

    body.append(
      toggle({
        on: settings.enabled,
        title: 'Бот включён',
        hint: settings.enabled
          ? 'Бот разбирает сообщения клиентов и отвечает по базе знаний.'
          : 'Пока выключен, панель только собирает переписку — клиенту ничего не уходит. Так и надо, пока база знаний не наполнена.',
        onChange: (v) => save({ enabled: v }, v ? 'Бот включён' : 'Бот выключен'),
      })
    );

    body.append(
      toggle({
        on: settings.autoReply,
        title: 'Отвечать сразу, без подтверждения',
        hint: settings.autoReply
          ? 'Так клиент получает ответ за секунды — это и есть смысл бота. Стоп-темы и незнакомые вопросы всё равно уходят человеку.'
          : 'Режим черновиков: бот готовит ответ, человек жмёт «отправить». Безопаснее, но мгновенным ответ уже не будет.',
        onChange: (v) => save({ autoReply: v }, v ? 'Бот отвечает сам' : 'Только черновики'),
      })
    );

    const chans = el('div', 'field');
    chans.append(el('label', 'field__label', 'Где бот работает'));
    const chips = el('div', 'chips chips--wrap');
    for (const id of specs.channelList) {
      const on = settings.channels.includes(id);
      const chip = el('button', 'chip', specs.channels[id].title);
      chip.type = 'button';
      if (on) chip.setAttribute('aria-pressed', 'true');
      chip.disabled = !canManage;
      chip.addEventListener('click', () => {
        const next = on ? settings.channels.filter((c) => c !== id) : [...settings.channels, id];
        save({ channels: next }, 'Каналы сохранены');
      });
      chips.append(chip);
    }
    chans.append(chips);
    chans.append(
      el(
        'div',
        'field__hint',
        'В личных сообщениях Meta разрешает автоответ только сутки с последнего сообщения клиента — дальше отвечает человек. Под постами такого окна нет.'
      )
    );
    body.append(chans);

    return p;
  }

  /* -------------------------------- тексты -------------------------------- */

  function textsPanel() {
    const p = panel('Когда ответа нет в базе');
    const body = el('div', 'stack');
    p.append(body);

    const area = el('textarea', 'textarea');
    area.rows = 3;
    area.value = settings.fallbackText;
    area.placeholder = 'Дякую за запитання! Передаю його адміністратору — відповість найближчим часом.';
    area.disabled = !canManage;

    body.append(
      el(
        'p',
        'field__hint',
        'Короткая фраза на случай, когда подходящей записи нет. Пустое поле — бот молчит, и вопрос просто уходит человеку. Договорённость была такая: факта нет — «уточню и вернусь», но не выдумывать.'
      ),
      area
    );

    if (canManage) {
      const actions = el('div', 'bot-actions');
      actions.append(
        button('Сохранить', {
          variant: 'primary',
          iconName: 'check',
          onClick: () => save({ fallbackText: area.value }, 'Сохранено'),
        })
      );
      body.append(actions);
    }
    return p;
  }

  /* ------------------------------ стоп-темы ------------------------------ */

  function stopPanel() {
    const p = panel('Стоп-темы — всегда человеку');
    const body = el('div', 'stack');
    p.append(body);

    body.append(
      el(
        'p',
        'field__hint',
        'На этих темах бот молчит и зовёт человека, каким бы точным ни был подбор. Основу снять нельзя — это договорённость, а не настройка.'
      )
    );

    const list = el('div', 'chips chips--wrap');
    for (const t of specs.stopTopics) {
      const chip = el('span', 'chip', `${t.title} · ${t.count}`);
      chip.setAttribute('aria-pressed', 'true');
      list.append(chip);
    }
    body.append(list);

    const area = el('textarea', 'textarea');
    area.rows = 3;
    area.value = settings.stopExtra;
    area.placeholder = 'конкурент\nперенести оплату\nдоговір';
    area.disabled = !canManage;

    body.append(el('label', 'field__label', 'Свои стоп-слова — по одному в строке'), area);

    if (canManage) {
      const actions = el('div', 'bot-actions');
      actions.append(
        button('Сохранить', {
          variant: 'primary',
          iconName: 'check',
          onClick: () => save({ stopExtra: area.value }, 'Стоп-слова сохранены'),
        })
      );
      body.append(actions);
    }
    return p;
  }

  /* --------------------------------- мелочи --------------------------------- */

  function toggle({ on, title, hint, onChange }) {
    const row = el('div', `target ${on ? 'target--on' : 'target--off'}`);
    row.style.gridTemplateColumns = '22px 1fr';

    const sw = el('label', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = on;
    input.disabled = !canManage;
    input.setAttribute('aria-label', title);
    const face = el('span', 'switch__box');
    face.append(icon('check', { size: 12 }));
    sw.append(input, face);
    input.addEventListener('change', () => onChange(input.checked));

    const text = el('div');
    text.append(el('div', 'target__name', title), el('div', 'field__hint', hint));

    row.append(sw, text);
    return row;
  }
}
