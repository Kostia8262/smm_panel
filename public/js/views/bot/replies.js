/**
 * «Реплики»: что бот пишет на каждом шаге воронки (docs/бот.md, §5b).
 *
 * Первое наполнение — черновики из Figma-файла сценариев; бот берёт текст
 * только отсюда. Пометка «черновик» снимается кнопкой «Согласовано», а не
 * сама при правке: правка и согласование — разные решения.
 */

import { api } from '../../api.js';
import { el, button, panel, note, toast, projectTabs } from '../../ui.js';

const ORIGIN = { figma: 'из Figma', translation: 'перевод, в Figma нет', own: 'своя правка' };

export function repliesView(ctx, { tabs } = {}) {
  const box = el('div', 'view');
  let rows = [];
  let editing = null;

  ctx.setTopbar({
    title: 'Бот-консультант',
    subtitle: 'Реплики воронки: возраст → цена и пробное → контакты → человек',
    actions: [button('Настройки бота', { iconName: 'settings', onClick: () => (location.hash = '#/bot/settings') })],
  });
  box.append(projectTabs({ projects: ctx.state.projects, current: ctx.state.projectId, onPick: (id) => ctx.switchProject(id) }));
  if (tabs) box.append(tabs);
  const host = el('div', 'stack');
  box.append(host);
  load();
  return box;

  async function load() {
    try {
      rows = (await api.botReplies()).replies;
    } catch (err) {
      host.textContent = '';
      host.append(note('danger', 'Реплики не прочитались', err.message));
      return;
    }
    render();
  }

  function render() {
    host.textContent = '';
    const drafts = rows.filter((r) => r.draft).length;
    if (drafts) {
      host.append(note('warn', `Черновиков: ${drafts} из ${rows.length}`, 'Тексты на вычитке. Бот уже может ими отвечать — включение бота решает владелец в настройках. Где в Figma «уточнити у власника», бот не отвечает, а передаёт диалог человеку.'));
    }
    let group = '';
    let p = null;
    for (const r of rows) {
      if (r.step !== group) {
        group = r.step;
        p = panel(group || 'Прочее');
        p.append(el('div', 'stack'));
        host.append(p);
      }
      p.lastChild.append(card(r));
    }
  }

  function card(r) {
    const c = el('div', 'bot-card');
    const head = el('div', 'bot-card__head');
    head.append(el('span', 'bot-card__title', r.title));
    head.append(el('span', 'tag', r.lang === 'ru' ? 'Рус' : 'Укр'));
    head.append(el('span', `tag ${r.draft ? 'tag--warn' : 'tag--ok'}`, r.draft ? 'черновик' : 'согласовано'));
    head.append(el('span', 'bot-card__src', ORIGIN[r.origin] || r.origin));
    head.append(el('span', 'bot-card__spacer'));
    c.append(head);

    if (editing === r.id) {
      const area = el('textarea', 'textarea');
      area.rows = Math.min(10, Math.max(3, r.text.split('\n').length + 1));
      area.value = r.text;
      c.append(area);
      if (r.text.includes('{age}')) c.append(el('div', 'field__hint', '{age} — сюда бот подставит возраст, который назвал клиент'));
      const row = el('div', 'bot-actions');
      row.append(button('Сохранить', { variant: 'primary', onClick: () => save(r, { text: area.value }) }));
      row.append(button('Отмена', { variant: 'quiet', onClick: () => { editing = null; render(); } }));
      c.append(row);
    } else {
      c.append(el('div', 'bot-card__body', r.text));
      const row = el('div', 'bot-actions');
      row.append(button('Править', { variant: 'quiet', iconName: 'settings', onClick: () => { editing = r.id; render(); } }));
      row.append(r.draft
        ? button('Согласовано', { variant: 'quiet', iconName: 'check', onClick: () => save(r, { draft: false }) })
        : button('Вернуть в черновики', { variant: 'quiet', onClick: () => save(r, { draft: true }) }));
      c.append(row);
    }
    return c;
  }

  async function save(r, body) {
    try {
      const { reply } = await api.updateBotReply(r.id, body);
      rows = rows.map((x) => (x.id === reply.id ? reply : x));
      editing = null;
      toast('Сохранено', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
}
