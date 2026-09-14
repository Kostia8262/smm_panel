/**
 * Доступ админки школы к панели: ключи только на чтение.
 *
 * Админка показывает у себя подписчиков и статус подписки в карточке клиента.
 * Ключ показывается один раз — в панели остаётся только хвост; отзыв вместо
 * удаления, чтобы было видно, когда ключом пользовались последний раз.
 */

import { api } from '../api.js';
import { el, button, panel, note, toast } from '../ui.js';

const when = (iso) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' }) : '';

export function crmAccessPanel() {
  const p = panel('Доступ админки школы');
  const body = el('div', 'stack');
  p.append(body);
  load();
  return p;

  async function load(fresh = null) {
    try {
      render((await api.crmAccessKeys()).keys, fresh);
    } catch (err) {
      body.textContent = '';
      body.append(note('danger', 'Не прочиталось', err.message));
    }
  }

  function render(keys, fresh) {
    body.textContent = '';
    body.append(
      el(
        'p',
        'field__hint',
        'Админка школы читает отсюда подписчиков: адрес, состояние, базы, откуда пришёл и когда получал письма. Только чтение — менять что-либо ключом нельзя. Имён и текстов писем админка не получает.'
      )
    );

    if (fresh) {
      body.append(note('warn', 'Скопируйте ключ сейчас', 'Он показывается один раз. Вставьте его в админке школы, в чат не присылайте.'));
      body.append(el('div', 'token-value', fresh));
      const copy = el('div', 'target__meta');
      copy.style.justifyContent = 'flex-start';
      copy.append(
        button('Скопировать ключ', {
          variant: 'primary',
          iconName: 'check',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(fresh);
              toast('Ключ скопирован', 'ok');
            } catch {
              toast('Буфер недоступен — выделите ключ выше и скопируйте вручную');
            }
          },
        })
      );
      body.append(copy);
    }

    const list = el('div', 'mail-members');
    for (const k of keys) {
      const item = el('div', `mail-member${k.revokedAt ? ' mail-member--removed' : ''}`);
      item.append(
        el('span', 'mail-name', `${k.name} · …${k.tail}`),
        el('span', 'dim small', `выпущен ${when(k.createdAt)}${k.createdBy ? `, ${k.createdBy}` : ''}`),
        el('span', 'dim small', k.lastUsedAt ? `последний раз ${when(k.lastUsedAt)}` : 'ещё не использовался')
      );
      if (k.revokedAt) {
        item.append(el('span', 'tag', `отозван ${when(k.revokedAt)}`));
      } else {
        item.append(
          button('Отозвать', {
            variant: 'quiet',
            onClick: async () => {
              if (!confirm(`Отозвать ключ «${k.name}»? Админка школы перестанет видеть подписчиков, пока не вставят новый.`)) return;
              try {
                await api.revokeCrmAccessKey(k.id);
                toast('Ключ отозван', 'ok');
                load();
              } catch (err) {
                toast(err.message, 'danger');
              }
            },
          })
        );
      }
      list.append(item);
    }
    if (keys.length) body.append(list);

    const row = el('div', 'target__meta');
    row.style.justifyContent = 'flex-start';
    row.append(
      button('Выпустить ключ', {
        variant: keys.some((k) => !k.revokedAt) ? 'quiet' : 'primary',
        iconName: 'plus',
        onClick: async () => {
          try {
            const out = await api.issueCrmAccessKey({ name: 'Админка школы' });
            load(out.key);
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      })
    );
    body.append(row);
  }
}
