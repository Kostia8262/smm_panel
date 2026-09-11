/**
 * Площадки: что подключено, чего не хватает и что нужно знать про каждую.
 *
 * Экран нужен именно СММщику, а не только тому, кто вписывает токены: он
 * отвечает на вопрос «почему мой пост никуда не ушёл» без похода в консоль.
 */

import { api } from '../api.js';
import { icon, iconMarkup } from '../icons.js';
import { el, button, panel, note, toast } from '../ui.js';

export function platformsView(ctx) {
  const root = el('div', 'view');
  const grid = el('div', 'platforms');
  root.append(grid);

  ctx.setTopbar({ title: 'Площадки', subtitle: 'Подключения и ограничения' });

  render();
  return root;

  async function render() {
    grid.textContent = '';
    let connections = ctx.state.connections;
    if (!connections) {
      connections = (await api.status()).platforms;
      ctx.state.connections = connections;
    }

    const off = connections.filter((c) => !c.configured);
    root.querySelector('.summary')?.remove();
    if (off.length) {
      const n = note(
        'warn',
        `Не подключено площадок: ${off.length}`,
        `Посты в них встанут в очередь и будут ждать токенов: ${off.map((c) => c.title).join(', ')}. Порядок подключения — в docs/подключение.md.`
      );
      n.classList.add('summary');
      root.prepend(n);
    }

    for (const conn of connections) {
      grid.append(card(conn));
    }
  }

  function card(conn) {
    const p = panel(null);
    p.classList.add('platform');

    const head = el('div', 'platform__head');
    const logo = el('span', 'platform__logo');
    logo.innerHTML = iconMarkup(conn.id, 18);
    logo.style.color = conn.configured ? 'var(--gold)' : 'var(--ink-3)';
    head.append(logo);

    const nameBox = el('div');
    nameBox.append(el('div', 'platform__name', conn.title));
    const state = el('div', 'platform__state');
    state.append(el('span', `dot dot--${conn.configured ? 'ok' : 'idle'}`));
    state.append(el('span', null, conn.configured ? 'подключено' : 'нет токена'));
    nameBox.append(state);
    head.append(nameBox);
    p.append(head);

    if (!conn.configured && conn.missing?.length) {
      const missing = el('div', 'platform__missing', conn.missing.join('\n'));
      missing.style.whiteSpace = 'pre-line';
      p.append(missing);
    }

    if (conn.notes?.length) {
      const list = el('ul', 'platform__notes');
      for (const n of conn.notes) list.append(el('li', null, n));
      p.append(list);
    }

    const actions = el('div', 'panel__head');
    actions.style.margin = '0';
    const check = button('Проверить связь', {
      iconName: 'refresh',
      disabled: !conn.configured,
      onClick: async () => {
        check.disabled = true;
        const spinner = el('span', 'btn__spinner');
        check.prepend(spinner);
        try {
          const res = await api.checkPlatform(conn.id);
          toast(`${conn.title}: связь есть — ${res.account || res.chat || res.bot || 'ок'}`, 'ok');
        } catch (err) {
          toast(`${conn.title}: ${err.message}`, 'danger');
        } finally {
          spinner.remove();
          check.disabled = false;
        }
      },
    });
    if (!conn.configured) check.title = 'Сначала заполните поля доступов выше';
    actions.append(check);
    p.append(actions);

    return p;
  }
}
