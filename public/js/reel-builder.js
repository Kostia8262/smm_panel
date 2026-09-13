/**
 * Блок «Reels из фото» у цели Instagram · Reels.
 *
 * Reels — это ролик, а у поста фото. Раньше это значило «в Reels не
 * опубликовать», а значит, и без звука: музыку Instagram прикрепляет только к
 * Reels. Блок собирает ролик из фото поста прямо в браузере и кладёт его
 * кадром цели.
 *
 * Порядок фото — как в «Медиа», кадрирование — по точке фокуса каждого фото.
 * Поменяли фото или фокус после сборки — проверка поста попросит пересобрать:
 * иначе в сеть ушёл бы ролик с вчерашними кадрами.
 */

import { api } from './api.js';
import { el, button, note, toast } from './ui.js';
import { makeThumb } from './thumbs.js';
import { renderReel, reelSupport, reelDuration, SECONDS_PER_SLIDE } from './reel-render.js';
import { durationText } from './audio.js';

const MAX_SLIDES = 10;

/** Фото, из которых можно собрать ролик: не видео, не снятые, не сами ролики. */
export function reelPhotos(post) {
  return (post.media || []).filter((m) => m.kind === 'image' && !m.derived && !m.purged);
}

/** Ролик из фото, выбранный у цели, — если он есть. */
export function currentReel(post, target) {
  const ids = Array.isArray(target?.media_ids) ? target.media_ids.map(Number) : [];
  return (post.media || []).find((m) => m.derived && ids.includes(Number(m.id))) || null;
}

/** Собран ли ролик из тех же фото и с тем же кадрированием, что сейчас. */
export function reelIsFresh(post, reel) {
  const d = parseDerived(reel);
  if (!d) return false;
  const photos = new Map(reelPhotos(post).map((m) => [Number(m.id), m]));
  return d.sources.every((s) => {
    const m = photos.get(Number(s.id));
    return m && Math.abs((m.focus_x ?? 0.5) - (s.focus_x ?? 0.5)) < 0.002 && Math.abs((m.focus_y ?? 0.5) - (s.focus_y ?? 0.5)) < 0.002;
  });
}

function parseDerived(m) {
  if (!m?.derived) return null;
  try {
    const d = typeof m.derived === 'string' ? JSON.parse(m.derived) : m.derived;
    return Array.isArray(d?.sources) ? d : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.post
 * @param {object} opts.target  цель instagram:reels
 * @param {(post: object) => void} opts.onBuilt  пост после загрузки ролика
 */
export function reelBuilder({ post, target, onBuilt }) {
  const box = el('div', 'reel');
  const photos = reelPhotos(post).slice(0, MAX_SLIDES);
  const reel = currentReel(post, target);
  const derived = parseDerived(reel);
  let seconds = derived?.secondsPerSlide || SECONDS_PER_SLIDE.default;
  let busy = false;

  render();
  return box;

  function render() {
    box.textContent = '';
    const head = el('div', 'reel__head');
    head.append(el('span', 'field__label', 'Reels из фото'));
    box.append(head);

    if (reel) {
      const fresh = reelIsFresh(post, reel);
      const parts = [`собран из ${derived?.sources.length || '?'} фото`];
      if (reel.duration) parts.push(durationText(reel.duration * 1000));
      box.append(el('span', 'field__hint', `Ролик ${parts.join(', ')}. Звук наложит Instagram — выберите трек ниже.`));
      if (!fresh) {
        box.append(note('warn', 'Фото поменялись после сборки', 'В ролике старые кадры или старое кадрирование — соберите заново.'));
      }
    } else if (!photos.length) {
      box.append(
        note('info', 'Нужен ролик или фото', 'Reels — это видео. Загрузите вертикальный ролик — или фото, и панель соберёт из них ролик под музыку.')
      );
      return;
    } else {
      box.append(
        el(
          'span',
          'field__hint',
          'У поста фото, а Reels — видео. Соберём ролик прямо здесь: кадры по порядку из «Медиа», кадрирование по точке фокуса, мягкие переходы.'
        )
      );
    }

    if (!photos.length) return;
    if (reelPhotos(post).length > MAX_SLIDES) {
      box.append(note('info', `В ролик войдут первые ${MAX_SLIDES} фото`, 'Остальные останутся в посте для других площадок.'));
    }

    const row = el('div', 'reel__row');
    const pace = el('label', 'reel__pace');
    pace.append(el('span', 'field__label', 'На фото'));
    const select = el('select', 'select');
    for (let s = SECONDS_PER_SLIDE.min; s <= SECONDS_PER_SLIDE.max; s++) {
      const opt = new Option(`${s} с`, String(s));
      if (s === Number(seconds)) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      seconds = Number(select.value);
      total.textContent = totalText();
    });
    pace.append(select);
    const total = el('span', 'dim small tnum', totalText());

    const go = button(reel ? 'Собрать заново' : 'Собрать ролик', {
      variant: reel && reelIsFresh(post, reel) ? '' : 'primary',
      iconName: 'video',
      onClick: build,
    });
    row.append(pace, total, el('span', 'spacer'), go);
    box.append(row);

    const progress = el('div', 'meter reel__meter');
    progress.hidden = true;
    const fill = el('div', 'meter__fill');
    progress.append(fill);
    box.append(progress);

    async function build() {
      if (busy) return;
      const support = await reelSupport();
      if (!support.ok) {
        toast(support.why, 'danger');
        return;
      }
      busy = true;
      go.disabled = true;
      select.disabled = true;
      progress.hidden = false;
      const setShare = (share) => fill.style.setProperty('--value', String(share));
      try {
        const { blob } = await renderReel({
          // Относительный адрес: публичный адрес файла может указывать на
          // боевой хост, а браузер качает кадр с того сервера, где открыта панель.
          slides: photos.map((m) => ({ url: new URL(m.url, location.href).pathname, focusX: m.focus_x, focusY: m.focus_y })),
          secondsPerSlide: seconds,
          onProgress: (share) => setShare(share * 0.85),
        });
        const file = new File([blob], 'Reels из фото.mp4', { type: 'video/mp4' });
        const thumb = await makeThumb(file).catch(() => null);
        setShare(0.9);
        const data = await api.uploadReel(post.id, {
          file,
          thumb,
          sources: photos.map((m) => m.id),
          secondsPerSlide: seconds,
        });
        setShare(1);
        toast('Ролик собран', 'ok');
        onBuilt(data.post);
      } catch (err) {
        toast(err.message, 'danger');
        busy = false;
        go.disabled = false;
        select.disabled = false;
        progress.hidden = true;
      }
    }
  }

  function totalText() {
    return `ролик ${durationText(reelDuration(photos.length, seconds) * 1000)}`;
  }
}
