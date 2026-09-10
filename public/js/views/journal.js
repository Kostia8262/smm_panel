/**
 * Журнал попыток. Отвечает на «почему не ушло» без логов PM2 —
 * их ротирует logrotate, а разбираться приходится через неделю.
 */

import { api } from '../api.js';
import { el, panel, empty, skeleton, toast } from '../ui.js';
import { iconMarkup } from '../icons.js';

const LEVEL = {
  error: { cls: 'tag--danger', text: 'ошибка' },
  warn: { cls: 'tag--warn', text: 'внимание' },
  info: { cls: '', text: 'событие' },
};

export function journalView(ctx) {
  const root = el('div', 'view');
  const host = panel('Последние события');
  root.append(host);

  ctx.setTopbar({ title: 'Журнал', subtitle: 'Что происходило с постами' });

  const loadingBox = el('div', 'issues');
  loadingBox.append(skeleton(34), skeleton(34), skeleton(34));
  host.append(loadingBox);

  load();
  return root;

  async function load() {
    let rows = [];
    try {
      rows = (await api.journal()).log;
    } catch (err) {
      toast(err.message, 'danger');
    }
    loadingBox.remove();

    if (!rows.length) {
      host.append(empty('journal', 'Пока пусто', 'Здесь появятся записи о публикациях, ошибках и входах.'));
      return;
    }

    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Когда', 'Уровень', 'Площадка', 'Событие']) hr.append(el('th', null, h));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      tr.append(el('td', 'table__time', row.created_at));

      const level = LEVEL[row.level] || LEVEL.info;
      const tdLevel = el('td');
      tdLevel.append(el('span', `tag ${level.cls}`, level.text));
      tr.append(tdLevel);

      const tdPlatform = el('td');
      if (row.platform) {
        const mark = el('span', 'mark');
        mark.innerHTML = iconMarkup(row.platform, 11);
        mark.title = row.platform;
        tdPlatform.append(mark);
      } else {
        tdPlatform.append(el('span', 'dim', '—'));
      }
      tr.append(tdPlatform);

      const tdMsg = el('td');
      // Если номер поста уже назван в сообщении, второй раз его не печатаем —
      // делаем ссылкой само сообщение.
      if (row.post_id) {
        const link = el('a');
        link.href = `#/post/${row.post_id}`;
        link.textContent = row.message;
        link.style.color = 'inherit';
        tdMsg.append(link);
      } else {
        tdMsg.append(el('span', null, row.message));
      }
      tr.append(tdMsg);

      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    host.append(wrap);
  }
}
