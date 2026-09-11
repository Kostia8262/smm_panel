/**
 * Настройки. Две вещи: свой ключ от панели и правила работы.
 *
 * Тумблер согласования виден всем, но переключает его только владелец —
 * СММщику важно понимать, уйдёт его пост сразу или ляжет ждать.
 */

import { api } from '../api.js';
import { icon } from '../icons.js';
import { el, button, panel, note, toast } from '../ui.js';

export function settingsView(ctx) {
  const root = el('div', 'view');
  ctx.setTopbar({ title: 'Настройки', subtitle: 'Доступ и правила работы' });

  root.append(tokenPanel(), approvalPanel(ctx));
  return root;

  /* --------------------------- свой токен --------------------------- */

  function tokenPanel() {
    const p = panel('Мой ключ от панели');
    p.append(
      el(
        'p',
        'field__hint',
        'Токен открывает панель с любого устройства. Он же — единственный способ войти, пароля нет.'
      )
    );

    const value = el('div', 'token-value token-value--hidden');
    value.textContent = '••••••••••••••••••••••••••••••••••••••••••••••••';
    p.append(value);

    const row = el('div', 'target__meta');
    row.style.justifyContent = 'flex-start';
    row.style.marginTop = '12px';

    let shown = false;
    const reveal = button('Показать', {
      iconName: 'eye',
      onClick: async () => {
        if (shown) {
          value.textContent = '••••••••••••••••••••••••••••••••••••••••••••••••';
          value.classList.add('token-value--hidden');
          reveal.querySelector('span').textContent = 'Показать';
          shown = false;
          return;
        }
        try {
          const { token } = await api.myToken();
          value.textContent = token;
          value.classList.remove('token-value--hidden');
          reveal.querySelector('span').textContent = 'Скрыть';
          shown = true;
        } catch (err) {
          toast(err.message, 'danger');
        }
      },
    });

    const copyBtn = button('Скопировать', {
      iconName: 'check',
      onClick: async () => {
        try {
          const { token } = await api.myToken();
          await navigator.clipboard.writeText(token);
          toast('Токен скопирован', 'ok');
        } catch {
          toast('Буфер недоступен — нажмите «Показать» и скопируйте вручную');
        }
      },
    });

    const reissue = button('Перевыпустить', {
      variant: 'danger',
      iconName: 'refresh',
      onClick: async () => {
        if (!confirm('Старый токен перестанет работать сразу, и эта сессия закроется. Продолжить?')) return;
        try {
          const { token } = await api.reissueMyToken();
          value.textContent = token;
          value.classList.remove('token-value--hidden');
          toast('Новый токен выпущен — скопируйте его сейчас', 'ok');
          // Сессия уже оборвана: даём время скопировать и уводим на вход.
          setTimeout(() => (location.href = '/login'), 15000);
        } catch (err) {
          toast(err.message, 'danger');
        }
      },
    });

    row.append(reveal, copyBtn, reissue);
    p.append(row);
    p.append(
      el(
        'p',
        'field__hint',
        'Перевыпуск закрывает все открытые входы по старому токену — им и лечится утечка.'
      )
    );
    return p;
  }

  /* -------------------------- согласование -------------------------- */

  function approvalPanel(ctx) {
    const p = panel('Согласование постов');
    const body = el('div');
    p.append(body);

    api
      .settings()
      .then(({ requireApproval, canEdit }) => {
        body.textContent = '';

        const row = el('div', 'target');
        row.classList.add('target--on');
        row.style.gridTemplateColumns = '22px 1fr auto';

        const sw = el('label', 'switch');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = requireApproval;
        input.disabled = !canEdit;
        input.setAttribute('aria-label', 'Требовать утверждение владельцем');
        const box = el('span', 'switch__box');
        box.innerHTML = icon('check', { size: 12 }).outerHTML;
        sw.append(input, box);

        const label = el('div');
        label.append(el('div', 'target__name', 'Посты СММщика ждут утверждения'));
        label.append(
          el(
            'div',
            'dim small',
            'Включено: СММщик отправляет пост на согласование, в очередь его ставите вы. Выключено: посты уходят сразу.'
          )
        );

        row.append(sw, label, el('span'));
        body.append(row);

        input.addEventListener('change', async () => {
          try {
            await api.saveSettings({ requireApproval: input.checked });
            toast(input.checked ? 'Согласование включено' : 'Согласование выключено', 'ok');
          } catch (err) {
            input.checked = !input.checked;
            toast(err.message, 'danger');
          }
        });

        if (!canEdit) {
          body.append(
            note('info', 'Переключает владелец', 'Вам видно правило, но менять его может только он.')
          );
        }
      })
      .catch((err) => {
        body.textContent = '';
        body.append(note('danger', 'Не удалось прочитать настройки', err.message));
      });

    return p;
  }
}
