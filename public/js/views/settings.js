/** Настройки: пока одно — смена пароля. Вход admin/admin временный. */

import { api } from '../api.js';
import { el, button, panel, note, toast } from '../ui.js';

export function settingsView(ctx) {
  const root = el('div', 'view');
  ctx.setTopbar({ title: 'Настройки', subtitle: 'Доступ к панели' });

  const p = panel('Смена пароля');

  if (ctx.state.user?.mustChange) {
    p.append(
      note(
        'warn',
        'Сейчас работает пароль по умолчанию',
        'admin / admin знает каждый, кто видел этот репозиторий. Смените, прежде чем отдавать панель в работу.'
      )
    );
  }

  const form = el('form', 'login__form');
  form.style.maxWidth = '380px';
  form.style.marginTop = '16px';

  const current = field('Текущий пароль', 'current-password');
  const next = field('Новый пароль', 'new-password');
  const repeat = field('Ещё раз', 'new-password');
  form.append(current.wrap, next.wrap, repeat.wrap);

  const submit = button('Сменить пароль', { variant: 'primary' });
  submit.type = 'submit';
  form.append(submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (next.input.value !== repeat.input.value) {
      toast('Новые пароли не совпадают', 'danger');
      return;
    }
    if (next.input.value.length < 8) {
      toast('Новый пароль короче восьми символов', 'danger');
      return;
    }
    submit.disabled = true;
    try {
      await api.changePassword(current.input.value, next.input.value);
      toast('Пароль изменён — войдите заново', 'ok');
      // Смена пароля обрывает все сессии, включая эту: это защита, а не помеха.
      setTimeout(() => (location.href = '/login'), 900);
    } catch (err) {
      toast(err.message, 'danger');
      submit.disabled = false;
    }
  });

  p.append(form);
  p.append(
    el(
      'p',
      'field__hint',
      'Смена пароля закрывает все открытые входы, включая этот — если пароль утёк, оставить чужую сессию значит не сменить ничего.'
    )
  );
  root.append(p);
  return root;
}

function field(label, autocomplete) {
  const wrap = el('div', 'field');
  const input = el('input', 'input');
  input.type = 'password';
  input.autocomplete = autocomplete;
  input.required = true;
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}
