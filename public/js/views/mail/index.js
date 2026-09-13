/**
 * Раздел «Рассылка». Фаза 1 — базы адресов: список баз, содержимое, загрузка
 * с распознаванием. Письма, ящики и отправка появятся здесь же следующими
 * фазами (docs/рассылка.md, §17).
 */

import { el, panel, button } from '../../ui.js';
import { listsView } from './lists.js';
import { listView } from './list.js';
import { importView } from './import.js';

export function mailView(ctx) {
  const hash = location.hash;
  const listMatch = hash.match(/^#\/mail\/lists\/(all|\d+)/);
  const importMatch = hash.match(/^#\/mail\/import\/(new|\d+)/);

  // Адрес набирается руками, поэтому право проверяется и здесь: СММщику
  // нужен внятный ответ, а не экран, упавший на 403 от сервера.
  if ((listMatch || importMatch) && !ctx.can('mail_contacts')) return closedView(ctx);
  if (listMatch) return listView(ctx, listMatch[1]);
  if (importMatch) return importView(ctx, importMatch[1]);
  return listsView(ctx);
}

function closedView(ctx) {
  ctx.setTopbar({ title: 'Рассылка', subtitle: 'Адреса баз' });
  const box = el('div', 'view');
  const p = panel('Адреса баз видит владелец');
  const actions = el('div', 'mail-actions');
  actions.append(button('К базам', { variant: 'primary', onClick: () => (location.hash = '#/mail') }));
  p.append(
    el('p', 'field__hint', 'В разделе «Рассылка» вам доступны названия и размеры баз — этого хватает, чтобы выбрать базу для письма.'),
    actions
  );
  box.append(p);
  return box;
}
