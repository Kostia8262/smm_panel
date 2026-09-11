/**
 * Календарь недели — главный экран.
 *
 * Задача экрана одна: понять, что выйдет на неделе, **не открывая посты**.
 * Отсюда миниатюра кадра прямо в карточке: текст поста в трёх строках не
 * читается, а картинку человек узнаёт мгновенно.
 *
 * Перенос дня — перетаскиванием: это единственное действие, которое СММщик
 * делает десятки раз, и оно не должно стоить открытия поста.
 */

import { api } from '../api.js';
import { icon, iconMarkup } from '../icons.js';
import {
  el, button, iconButton, note, skeleton, toast,
  startOfWeek, dowLabel, humanRange, dateKey, dbStamp,
} from '../ui.js';

const STATUS_MARK = {
  published: { cls: 'mark--published', title: 'опубликовано' },
  failed: { cls: 'mark--failed', title: 'ошибка' },
  pending: { cls: '', title: 'ждёт' },
};

export function calendarView(ctx) {
  let weekStart = startOfWeek(ctx.state.weekStart || new Date());
  let posts = [];
  let loading = true;

  const root = el('div', 'view');
  const grid = el('div', 'week');
  root.append(grid);

  ctx.setTopbar({
    title: 'Календарь',
    subtitle: '',
    actions: [
      iconButton('chevronLeft', { title: 'Предыдущая неделя', onClick: () => shift(-7) }),
      button('Сегодня', { onClick: () => { weekStart = startOfWeek(new Date()); load(); } }),
      iconButton('chevronRight', { title: 'Следующая неделя', onClick: () => shift(7) }),
      button('Новый пост', { variant: 'primary', iconName: 'plus', onClick: () => createOn(new Date()) }),
    ],
  });

  function shift(days) {
    weekStart = new Date(weekStart.getTime() + days * 86400000);
    load();
  }

  async function load() {
    ctx.state.weekStart = weekStart;
    loading = true;
    render();
    const from = `${dateKey(weekStart)} 00:00:00`;
    const to = `${dateKey(new Date(weekStart.getTime() + 6 * 86400000))} 23:59:59`;
    try {
      const data = await api.posts(from, to);
      posts = data.posts;
    } catch (err) {
      toast(err.message, 'danger');
      posts = [];
    }
    loading = false;
    render();
  }

  async function createOn(date) {
    const at = new Date(date);
    if (at.toDateString() === new Date().toDateString()) {
      // Сегодняшний пост по умолчанию — через час, а не в прошлое.
      at.setHours(at.getHours() + 1, 0, 0, 0);
    } else {
      at.setHours(10, 0, 0, 0);
    }
    try {
      const { post } = await api.createPost({
        title: '',
        body: '',
        scheduled_at: dbStamp(at),
        targets: [{ platform: 'telegram', format_id: 'any' }],
      });
      location.hash = `#/post/${post.id}`;
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function movePost(id, date) {
    const post = posts.find((p) => p.id === id);
    if (!post) return;
    const time = post.scheduled_at ? post.scheduled_at.slice(11, 16) : '10:00';
    const stamp = `${dateKey(date)} ${time}:00`;
    try {
      await api.updatePost(id, { scheduled_at: stamp });
      toast('Пост перенесён', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function render() {
    grid.textContent = '';
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
    ctx.setSubtitle(humanRange(weekStart, weekEnd));

    if (loading) {
      for (let i = 0; i < 7; i++) {
        const col = el('div', 'day');
        const inner = el('div', 'day__list');
        inner.append(skeleton(52), skeleton(52));
        col.append(inner);
        grid.append(col);
      }
      return;
    }

    const todayKey = dateKey(new Date());

    for (let i = 0; i < 7; i++) {
      const date = new Date(weekStart.getTime() + i * 86400000);
      const key = dateKey(date);
      const dayPosts = posts
        .filter((p) => (p.scheduled_at || '').slice(0, 10) === key)
        .sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));

      const col = el('section', `day${key === todayKey ? ' day--today' : ''}`);

      const head = el('div', 'day__head');
      head.append(el('span', 'day__num', String(date.getDate())));
      head.append(el('span', 'day__dow', dowLabel(date)));
      if (dayPosts.length) head.append(el('span', 'day__count', String(dayPosts.length)));
      col.append(head);

      const list = el('div', 'day__list');
      for (const post of dayPosts) list.append(postCard(post));
      col.append(list);

      const add = el('button', 'day__add');
      add.type = 'button';
      add.innerHTML = iconMarkup('plus', 14);
      add.append(el('span', null, 'Пост'));
      add.addEventListener('click', () => createOn(date));
      col.append(add);

      // Перенос дня перетаскиванием
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('day--drop');
      });
      col.addEventListener('dragleave', () => col.classList.remove('day--drop'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('day--drop');
        const id = Number(e.dataTransfer.getData('text/plain'));
        if (id) movePost(id, date);
      });

      grid.append(col);
    }

    const undated = posts.filter((p) => !p.scheduled_at);
    root.querySelector('.drafts')?.remove();
    if (undated.length) {
      const box = el('section', 'panel drafts');
      const head = el('div', 'panel__head');
      head.append(el('h2', null, 'Черновики без даты'));
      head.append(el('span', 'day__count', String(undated.length)));
      box.append(head);
      const list = el('div', 'media');
      for (const post of undated) {
        const card = postCard(post);
        card.style.width = '260px';
        list.append(card);
      }
      box.append(list);
      root.append(box);
    }

    // Пустая неделя: подсказка строкой, а не отдельным экраном под сеткой.
    // Сетка сама и есть главный жест — в ней и должны появиться кнопки «Пост».
    root.querySelector('.empty-hint')?.remove();
    if (!posts.length) {
      const hint = note(
        'info',
        'На этой неделе пусто',
        'Наведите на день и нажмите «Пост». Текст пишется один раз, а превью сразу покажет, как он ляжет в каждую сеть.'
      );
      hint.classList.add('empty-hint');
      grid.before(hint);
      for (const add of grid.querySelectorAll('.day__add')) add.style.opacity = '1';
    }
  }

  function postCard(post) {
    const card = el('button', 'post');
    card.type = 'button';
    card.draggable = true;

    // Пост без медиа не получает пустую рамку: текстовая карточка честнее
    // и не занимает высоту, которой нечего показать.
    const first = (post.media || [])[0];
    if (first) {
      const thumb = el('div', 'post__thumb');
      if (first.kind === 'video') {
        thumb.append(icon('video', { size: 20 }));
      } else {
        const img = el('img');
        img.src = `/media/${first.stored_name}`;
        img.alt = '';
        img.loading = 'lazy';
        thumb.append(img);
      }
      if (post.media.length > 1) {
        const badge = el('span', 'post__kind');
        badge.innerHTML = iconMarkup('layers', 12);
        badge.title = `файлов в посте: ${post.media.length}`;
        thumb.append(badge);
      }
      card.append(thumb);
    } else {
      card.classList.add('post--text');
    }

    const body = el('div', 'post__body');
    const top = el('div', 'post__top');
    top.append(el('span', `dot dot--${statusDot(post)}`));
    top.append(el('time', 'post__time', post.scheduled_at ? post.scheduled_at.slice(11, 16) : 'без даты'));
    body.append(top);
    // Ждущий утверждения виден сразу: иначе владелец узнаёт о нём, только
    // открыв пост, и пост стоит в очереди до вечера просто так.
    if (post.status === 'review') top.append(el('span', 'tag tag--gold', 'ждёт'));
    body.append(el('div', 'post__title', post.title || firstLine(post.body) || 'Без названия'));

    const marks = el('div', 'post__marks');
    for (const t of post.targets || []) {
      const mark = el('span', `mark ${STATUS_MARK[t.status]?.cls || ''}`);
      mark.innerHTML = iconMarkup(t.platform, 11);
      mark.title = `${t.platform}: ${STATUS_MARK[t.status]?.title || t.status}`;
      marks.append(mark);
    }
    body.append(marks);
    card.append(body);

    card.addEventListener('click', () => {
      location.hash = `#/post/${post.id}`;
    });
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(post.id));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('post--dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('post--dragging'));

    return card;
  }

  load();
  return root;
}

function statusDot(post) {
  if (post.status === 'published') return 'ok';
  if (post.status === 'failed') return 'danger';
  if (post.status === 'partial' || post.status === 'scheduled') return 'warn';
  if (post.status === 'review') return 'warn';
  return 'idle';
}

function firstLine(text) {
  return (text || '').split('\n').find((l) => l.trim()) || '';
}
