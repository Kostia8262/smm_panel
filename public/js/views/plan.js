/**
 * Контент-план: что снимаем и публикуем в ближайшее время.
 *
 * Экран устроен колонками по состоянию, а не списком: смысл плана в движении
 * идеи слева направо — предложили, утвердили, взяли в работу, вышло. Список
 * этого движения не показывает, и «утверждённое, но забытое» в нём теряется.
 */

import { api } from '../api.js';
import { icon, iconMarkup } from '../icons.js';
import { el, button, iconButton, panel, note, empty, toast, skeleton, projectTabs } from '../ui.js';

const COLUMNS = ['idea', 'approved', 'in_work', 'done'];

export function planView(ctx) {
  const root = el('div', 'view');
  let items = [];
  let statuses = [];
  let rubrics = [];
  const isOwner = ctx.state.user.role === 'owner';

  // Два взгляда на одно и то же. Доска отвечает «на каком этапе идея»,
  // лента — «что было, что сейчас, что впереди». Второе нужно, чтобы видеть
  // ритм публикаций и дыры в нём, а доска этого не показывает вовсе.
  let mode = localStorage.getItem('smm.plan.mode') === 'timeline' ? 'timeline' : 'board';

  function modeSwitch() {
    const chips = el('div', 'chips');
    for (const [id, title] of [['board', 'Доска'], ['timeline', 'Лента']]) {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.textContent = title;
      chip.setAttribute('aria-pressed', String(mode === id));
      chip.addEventListener('click', () => {
        mode = id;
        try {
          localStorage.setItem('smm.plan.mode', id);
        } catch {
          // приватное окно — просто не запомним
        }
        setTopbar();
        render();
      });
      chips.append(chip);
    }
    return chips;
  }

  function setTopbar() {
    ctx.setTopbar({
      title: 'Контент-план',
      subtitle: 'Идеи, из которых рождаются посты',
      actions: [
        modeSwitch(),
        button('Новая идея', { variant: 'primary', iconName: 'plus', onClick: () => openForm() }),
      ],
    });
  }

  setTopbar();

  // Вкладка «все проекты» — общий взгляд при планировании месяца: видно,
  // где густо, а где неделю пусто.
  let scope = ctx.state.projectId;
  const tabs = el('div');
  root.append(tabs);
  renderTabs();

  const board = el('div', 'board');
  root.append(board);

  function renderTabs() {
    tabs.textContent = '';
    tabs.append(
      projectTabs({
        projects: ctx.state.projects,
        current: scope,
        onPick: (id) => {
          scope = id;
          if (id !== 'all') ctx.switchProject(id);
          renderTabs();
          load();
        },
      })
    );
  }

  const loading = el('div', 'issues');
  loading.append(skeleton(64), skeleton(64));
  board.append(loading);

  load();
  return root;

  async function load() {
    try {
      const data = await api.plan(null, scope === 'all' ? 'all' : undefined);
      items = data.items;
      statuses = data.statuses;
      rubrics = data.rubrics;
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    render();
  }

  function render() {
    board.textContent = '';
    root.querySelector('.plan-timeline')?.remove();
    root.querySelectorAll('.panel.drafts-like').forEach((n) => n.remove());

    if (mode === 'timeline' && items.length) {
      board.hidden = true;
      root.append(renderTimeline());
      return;
    }
    board.hidden = false;

    if (!items.length) {
      const box = el('section', 'panel');
      box.append(
        empty(
          'layers',
          'План пуст',
          'Идея — это тема, рубрика и что нужно снять. Из утверждённой идеи пост создаётся одним нажатием, СММщику останется подложить картинку.',
          button('Новая идея', { variant: 'primary', iconName: 'plus', onClick: () => openForm() })
        )
      );
      board.append(box);
      return;
    }

    for (const status of COLUMNS) {
      const spec = statuses.find((s) => s.id === status);
      const list = items.filter((i) => i.status === status);
      const col = el('section', 'board__col');

      const head = el('div', 'board__head');
      head.append(el('span', 'board__title', spec?.title || status));
      head.append(el('span', 'day__count', String(list.length)));
      col.append(head);
      if (spec?.hint) col.append(el('span', 'board__hint', spec.hint));

      const body = el('div', 'board__list');
      for (const item of list) body.append(card(item));
      if (!list.length) body.append(el('div', 'board__empty', '—'));
      col.append(body);

      board.append(col);
    }

    const rejected = items.filter((i) => i.status === 'rejected');
    if (rejected.length) {
      const box = panel(`Отклонённые · ${rejected.length}`);
      const list = el('div', 'board__list');
      for (const item of rejected) list.append(card(item));
      box.append(list);
      root.append(box);
    }
  }

  /**
   * Лента по времени. Прошлое сжато и приглушено — оно нужно как память
   * «что мы уже говорили», а не как список дел; впереди подробнее.
   */
  function renderTimeline() {
    const wrap = el('div', 'plan-timeline');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dated = items.filter((i) => i.plannedFor);
    const undated = items.filter((i) => !i.plannedFor);

    const past = dated
      .filter((i) => new Date(i.plannedFor) < today || i.status === 'done')
      .sort((a, b) => b.plannedFor.localeCompare(a.plannedFor));
    const ahead = dated
      .filter((i) => new Date(i.plannedFor) >= today && i.status !== 'done')
      .sort((a, b) => a.plannedFor.localeCompare(b.plannedFor));
    const now = ahead.filter((i) => daysFrom(today, i.plannedFor) <= 7);
    const later = ahead.filter((i) => daysFrom(today, i.plannedFor) > 7);

    wrap.append(band('Сейчас', 'Ближайшая неделя', now, 'now'));
    wrap.append(band('Впереди', 'Дальше по плану', later.concat(undated), 'ahead'));
    wrap.append(band('Было', 'Память: о чём уже говорили', past, 'past'));
    return wrap;
  }

  function band(title, hint, list, kind) {
    const box = panel(null);
    box.classList.add('band', `band--${kind}`);

    const head = el('div', 'panel__head');
    head.append(el('h2', null, title));
    head.append(el('span', 'board__hint', hint));
    head.append(el('span', 'spacer'));
    head.append(el('span', 'day__count', String(list.length)));
    box.append(head);

    if (!list.length) {
      box.append(el('div', 'board__empty', kind === 'past' ? 'Пока ничего не выходило' : 'Пусто — значит, дыра в плане'));
      return box;
    }

    const grid = el('div', 'band__list');
    for (const item of list) grid.append(card(item));
    box.append(grid);
    return box;
  }

  function daysFrom(from, iso) {
    return Math.round((new Date(iso) - from) / 86400000);
  }

  function card(item) {
    const box = el('article', 'idea');

    const top = el('div', 'idea__top');
    if (item.rubric) top.append(el('span', 'tag', item.rubric));
    if (item.plannedFor) top.append(el('span', 'idea__date', item.plannedFor.slice(0, 10).split('-').reverse().join('.')));
    if (item.trendTitle) {
      const mark = el('span', 'tag tag--gold', 'из тренда');
      mark.title = item.trendTitle;
      top.append(mark);
    }
    box.append(top);

    if (scope === 'all') {
      const project = ctx.state.projects.find((p) => p.id === item.projectId);
      if (project) {
        const badge = el('span', 'idea__project');
        const dot = el('i');
        dot.style.background = project.accent;
        badge.append(dot, el('span', null, project.title));
        top.append(badge);
      }
    }
    box.append(el('h3', 'idea__title', item.title));
    if (item.idea) box.append(el('p', 'idea__text', item.idea));

    if (item.platforms?.length) {
      const marks = el('div', 'post__marks');
      for (const p of item.platforms) {
        const mark = el('span', 'mark');
        mark.innerHTML = iconMarkup(p, 11);
        mark.title = p;
        marks.append(mark);
      }
      box.append(marks);
    }

    // Что нужно от СММщика — главное поле этого экрана: по нему человек
    // понимает, что снимать, не спрашивая.
    if (item.needMedia) {
      const need = el('div', 'idea__need');
      need.append(icon('image', { size: 13 }));
      need.append(el('span', null, item.needMedia));
      box.append(need);
    }

    const foot = el('div', 'idea__foot');

    if (item.status === 'idea' && isOwner) {
      foot.append(
        button('Утвердить', {
          variant: 'primary',
          iconName: 'check',
          onClick: async () => {
            try {
              await api.approvePlan(item.id);
              toast('Идея утверждена', 'ok');
              load();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
      foot.append(
        button('Отклонить', {
          onClick: async () => {
            try {
              await api.updatePlan(item.id, { status: 'rejected' });
              load();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
    }

    if (item.status === 'approved') {
      foot.append(
        button('Создать пост', {
          variant: 'primary',
          iconName: 'send',
          onClick: async () => {
            try {
              const { postId } = await api.planToPost(item.id);
              toast('Пост-заготовка создан', 'ok');
              location.hash = `#/post/${postId}`;
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
    }

    if (item.postId) {
      const open = button('Открыть пост', {
        iconName: 'eye',
        onClick: () => (location.hash = `#/post/${item.postId}`),
      });
      foot.append(open);
    }

    foot.append(el('span', 'spacer'));
    foot.append(iconButton('settings', { title: 'Править идею', onClick: () => openForm(item) }));
    foot.append(
      iconButton('trash', {
        title: 'Удалить идею',
        variant: 'danger',
        onClick: async () => {
          if (!confirm(`Удалить идею «${item.title}»?`)) return;
          await api.deletePlan(item.id);
          load();
        },
      })
    );

    box.append(foot);
    return box;
  }

  /* ------------------------------ форма ------------------------------ */

  function openForm(existing = null) {
    root.querySelector('.plan-form')?.remove();
    const box = panel(existing ? 'Правка идеи' : 'Новая идея');
    box.classList.add('plan-form');

    const form = el('form', 'plan-form__grid');

    const title = textField('Тема', existing?.title || '', 'О чём пост в одну строку');
    const idea = areaField('Тезисы', existing?.idea || '', 'Что сказать, какой вывод, чем зацепить');
    const need = textField('Что нужно снять', existing?.needMedia || '', 'Например: фото ученика за компьютером');

    const rubricWrap = el('div', 'field');
    rubricWrap.append(el('label', 'field__label', 'Рубрика'));
    const rubric = el('select', 'select');
    rubric.append(new Option('— без рубрики —', ''));
    for (const r of rubrics) {
      const opt = new Option(r, r);
      if (existing?.rubric === r) opt.selected = true;
      rubric.append(opt);
    }
    rubricWrap.append(rubric);

    const dateWrap = el('div', 'field');
    dateWrap.append(el('label', 'field__label', 'Когда примерно'));
    const date = el('input', 'input');
    date.type = 'date';
    date.value = existing?.plannedFor ? existing.plannedFor.slice(0, 10) : '';
    dateWrap.append(date, el('span', 'field__hint', 'Только день — точное время выберете в посте.'));

    const platWrap = el('div', 'field');
    platWrap.append(el('label', 'field__label', 'Площадки'));
    const plats = el('div', 'plat-picker');
    const chosen = new Set(existing?.platforms || []);
    for (const spec of ctx.state.specs || []) {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(chosen.has(spec.id)));
      chip.innerHTML = iconMarkup(spec.id, 13);
      chip.append(el('span', null, spec.title));
      chip.addEventListener('click', () => {
        if (chosen.has(spec.id)) chosen.delete(spec.id);
        else chosen.add(spec.id);
        chip.setAttribute('aria-pressed', String(chosen.has(spec.id)));
      });
      plats.append(chip);
    }
    platWrap.append(plats);

    form.append(title.wrap, rubricWrap, idea.wrap, need.wrap, dateWrap, platWrap);

    const foot = el('div', 'target__meta');
    foot.style.justifyContent = 'flex-start';
    const submit = button(existing ? 'Сохранить' : 'Добавить в план', { variant: 'primary' });
    submit.type = 'submit';
    foot.append(submit, button('Отмена', { onClick: () => box.remove() }));
    form.append(foot);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        title: title.input.value,
        idea: idea.input.value,
        rubric: rubric.value,
        needMedia: need.input.value,
        plannedFor: date.value || null,
        platforms: [...chosen],
      };
      submit.disabled = true;
      try {
        if (existing) await api.updatePlan(existing.id, payload);
        else await api.createPlan(payload);
        box.remove();
        load();
        toast(existing ? 'Идея обновлена' : 'Идея добавлена', 'ok');
      } catch (err) {
        toast(err.message, 'danger');
        submit.disabled = false;
      }
    });

    box.append(form);
    root.prepend(box);
    title.input.focus();
  }
}

function textField(label, value, placeholder) {
  const wrap = el('div', 'field');
  const input = el('input', 'input');
  input.value = value;
  input.placeholder = placeholder || '';
  const id = `p-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}

function areaField(label, value, placeholder) {
  const wrap = el('div', 'field');
  const input = el('textarea', 'textarea');
  input.rows = 4;
  input.value = value;
  input.placeholder = placeholder || '';
  const id = `p-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}
