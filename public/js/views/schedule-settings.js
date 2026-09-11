/**
 * Настройки расписания и связи с заявками.
 *
 * Живут отдельным файлом от общих настроек: это две разные темы — «мой
 * доступ» и «как работает проект», и смешивать их в одном модуле значит
 * потом искать нужное среди чужого.
 */

import { api } from '../api.js';
import { el, button, panel, note, toast } from '../ui.js';
import { iconMarkup } from '../icons.js';

/**
 * Слоты и рубрики. Сетка задаётся один раз на проект: выбирать время
 * у каждого поста руками — самая частая лишняя операция за день.
 */
export function schedulePanel() {
  const p = panel('Расписание проекта');
  const body = el('div');
  p.append(body);
  load();
  return p;

  async function load() {
    let data;
    try {
      data = await api.schedule();
    } catch (err) {
      body.textContent = '';
      body.append(note('danger', 'Не удалось прочитать расписание', err.message));
      return;
    }
    render(data);
  }

  function render(data) {
    body.textContent = '';
    body.append(
      el(
        'p',
        'field__hint',
        'Пост кладётся в ближайший свободный слот одной кнопкой. Слот с рубрикой принимает только её.'
      )
    );

    const grid = el('div', 'slotgrid');
    for (let day = 1; day <= 7; day++) {
      const col = el('div', 'slotgrid__day');
      col.append(el('span', 'eyebrow', data.weekdays[day - 1]));
      const list = el('div', 'slotgrid__list');
      const todays = data.slots.filter((s) => s.weekday === day);
      for (const slot of todays) {
        const chip = el('span', 'slot');
        if (slot.categoryColor) chip.style.borderColor = slot.categoryColor;
        chip.append(el('b', null, slot.time));
        if (slot.categoryTitle) chip.append(el('span', 'dim small', slot.categoryTitle));
        chip.append(removeButton('Убрать слот', async () => {
          await api.removeSlot(slot.id);
          load();
        }));
        list.append(chip);
      }
      if (!todays.length) list.append(el('span', 'dim small', '—'));
      col.append(list);
      grid.append(col);
    }
    body.append(grid);

    body.append(slotForm(data));
    body.append(el('div', 'eyebrow', 'Рубрики'));
    body.append(categoryList(data));
    body.append(categoryForm());
  }

  function slotForm(data) {
    const form = el('form', 'target__meta');
    form.style.justifyContent = 'flex-start';
    form.style.marginTop = '16px';

    const day = el('select', 'select');
    data.weekdays.forEach((title, i) => day.append(new Option(title, String(i + 1))));

    const time = el('input', 'input');
    time.type = 'time';
    time.value = '10:00';
    time.style.maxWidth = '130px';

    const cat = el('select', 'select');
    cat.append(new Option('любая рубрика', ''));
    for (const c of data.categories) cat.append(new Option(c.title, String(c.id)));

    const add = button('Добавить слот', { variant: 'primary', iconName: 'plus' });
    add.type = 'submit';
    form.append(day, time, cat, add);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.addSlot({
          weekday: Number(day.value),
          time: time.value,
          categoryId: cat.value ? Number(cat.value) : null,
        });
        load();
      } catch (err) {
        toast(err.message, 'danger');
      }
    });
    return form;
  }

  function categoryList(data) {
    const wrap = el('div', 'plat-picker');
    for (const c of data.categories) {
      const chip = el('span', 'slot');
      chip.style.borderColor = c.color;
      chip.append(el('b', null, c.title));
      if (c.evergreen) chip.append(el('span', 'tag tag--gold', 'вечнозелёная'));
      chip.append(removeButton('Удалить рубрику', async () => {
        if (!confirm(`Удалить рубрику «${c.title}»? Слоты с ней станут общими.`)) return;
        await api.removeCategory(c.id);
        load();
      }));
      wrap.append(chip);
    }
    if (!data.categories.length) wrap.append(el('span', 'dim small', 'рубрик пока нет'));
    return wrap;
  }

  function categoryForm() {
    const form = el('form', 'target__meta');
    form.style.justifyContent = 'flex-start';

    const title = el('input', 'input');
    title.placeholder = 'Новая рубрика';
    title.style.maxWidth = '220px';

    const ever = el('label', 'switch');
    const everInput = el('input');
    everInput.type = 'checkbox';
    everInput.setAttribute('aria-label', 'Вечнозелёная рубрика');
    const everBox = el('span', 'switch__box');
    everBox.innerHTML = iconMarkup('check', 12);
    ever.append(everInput, everBox);

    const add = button('Добавить', { iconName: 'plus' });
    add.type = 'submit';

    form.append(title, ever, el('span', 'dim small', 'вечнозелёная — вернётся в оборот'), add);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.createCategory({ title: title.value, evergreen: everInput.checked });
        title.value = '';
        everInput.checked = false;
        load();
      } catch (err) {
        toast(err.message, 'danger');
      }
    });
    return form;
  }

  function removeButton(title, onClick) {
    const b = el('button', 'slot__x');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = iconMarkup('x', 11);
    b.addEventListener('click', onClick);
    return b;
  }
}

/**
 * Доступ к заявкам школы. Ради этого отчёта панель и делалась своими руками:
 * сервисы планирования не знают, сколько учеников пришло с поста.
 */
export function leadsPanel() {
  const p = panel('Связь с заявками школы');
  const body = el('div');
  p.append(body);

  api
    .leadsSettings()
    .then((cfg) => {
      body.textContent = '';
      body.append(
        el(
          'p',
          'field__hint',
          'Ссылки на наши сайты в постах подменяются короткими: они считают переходы и проставляют метки, а сайт кладёт метки в заявку.'
        )
      );

      const form = el('form', 'plan-form__grid');
      const url = field('Адрес админки', cfg.url || 'https://mycomputer.education');
      const token = field('Админ-токен', '');
      token.input.type = 'password';
      token.input.placeholder = cfg.hasToken ? 'сохранён — пустое поле не меняет' : 'нужен для чтения заявок';
      const domains = field('Наши домены', cfg.ownDomains || '');
      domains.wrap.append(el('span', 'field__hint', 'Через запятую. Ссылки на чужие сайты не трогаем.'));

      const foot = el('div', 'target__meta');
      foot.style.justifyContent = 'flex-start';
      const save = button('Сохранить', { variant: 'primary' });
      save.type = 'submit';
      foot.append(save);

      form.append(url.wrap, token.wrap, domains.wrap, foot);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          await api.saveLeadsSettings({
            url: url.input.value,
            token: token.input.value,
            ownDomains: domains.input.value,
          });
          toast('Сохранено', 'ok');
          token.input.value = '';
        } catch (err) {
          toast(err.message, 'danger');
        } finally {
          save.disabled = false;
        }
      });
      body.append(form);
    })
    .catch((err) => {
      body.textContent = '';
      body.append(note('danger', 'Настройки не прочитались', err.message));
    });

  return p;
}

function field(label, value) {
  const wrap = el('div', 'field');
  const input = el('input', 'input');
  input.value = value || '';
  const id = `ls-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}
