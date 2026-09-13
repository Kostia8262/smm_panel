/**
 * Звук Reels в композере: витрина трендов, поиск, прослушка, громкости.
 *
 * Звук прикрепляет сам Instagram при публикации (Audio API, июнь 2026) —
 * в файл ролика панель ничего не вшивает. Отсюда два честных ограничения,
 * которые компонент проговаривает, а не прячет: готовый ролик со звуком до
 * публикации не посмотреть, и с какого места пойдёт трек, решает площадка.
 *
 * Прослушка есть только у музыки: у оригинальных звуков из чужих Reels
 * площадка файла не отдаёт, только ссылку на страницу звука.
 */

import { api } from './api.js';
import { icon, iconMarkup } from './icons.js';
import { el, button, note, toast } from './ui.js';

const TABS = [
  { id: 'music', title: 'Музыка', hint: 'Бесплатная библиотека Meta — без претензий правообладателей.' },
  {
    id: 'original_sound',
    title: 'Оригинальные звуки',
    hint: 'Звуки из чужих Reels. Ролик попадёт на страницу звука — оттуда приходят зрители не из подписчиков.',
  },
];

/* ------------------------------ прослушка ------------------------------ */

// Один проигрыватель на всю панель: два трека разом слушать некому.
const player = new Audio();
player.preload = 'none';
let playingButton = null;

function stopPlayer() {
  player.pause();
  if (playingButton) setPlaying(playingButton, false);
  playingButton = null;
}

function setPlaying(btn, on) {
  btn.setAttribute('aria-pressed', String(on));
  btn.innerHTML = iconMarkup(on ? 'pause' : 'play', 14);
}

// Композер перерисовывает колонку целиком, и кнопка, запустившая трек,
// исчезает из документа — музыка не должна играть дальше без способа её
// остановить.
player.addEventListener('timeupdate', () => {
  if (playingButton && !playingButton.isConnected) stopPlayer();
});
player.addEventListener('ended', stopPlayer);
player.addEventListener('error', () => {
  if (playingButton) toast('Трек не проигрывается — ссылка на прослушку могла устареть', 'danger');
  stopPlayer();
});
window.addEventListener('hashchange', stopPlayer);

/** Свежая ссылка на прослушку: у выбранного трека её в базе нет — живёт полтора дня. */
const freshInfo = new Map();
async function previewUrlOf(audio, projectId) {
  if (audio.previewUrl) return audio.previewUrl;
  const hit = freshInfo.get(audio.id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.audio.previewUrl;
  const { audio: info } = await api.audioInfo(audio.id, projectId);
  freshInfo.set(audio.id, { at: Date.now(), audio: info });
  return info.previewUrl;
}

function playButton(audio, projectId) {
  const btn = el('button', 'btn btn--quiet btn--icon sound__play');
  btn.type = 'button';
  btn.setAttribute('aria-label', `Послушать ${label(audio)}`);
  setPlaying(btn, false);
  btn.addEventListener('click', async () => {
    if (playingButton === btn) {
      stopPlayer();
      return;
    }
    stopPlayer();
    try {
      const url = await previewUrlOf(audio, projectId);
      if (!url) {
        toast('У этого звука Instagram не отдаёт файл для прослушки', 'danger');
        return;
      }
      player.src = url;
      playingButton = btn;
      setPlaying(btn, true);
      await player.play();
    } catch (err) {
      stopPlayer();
      toast(err.message, 'danger');
    }
  });
  return btn;
}

/* ------------------------------ подписи ------------------------------ */

function label(audio) {
  return `«${audio.title || 'без названия'}»`;
}

function whoOf(audio) {
  if (audio.artist) return audio.artist;
  if (audio.username) return `@${audio.username}`;
  return '';
}

export function durationText(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Строка трека: обложка, название, автор, длина и прослушка. Её же берут тренды. */
export function trackLine(audio, projectId, { extra } = {}) {
  const row = el('div', 'sound__track');

  const cover = el('div', 'sound__cover');
  if (audio.cover) {
    const img = el('img');
    img.src = audio.cover;
    img.alt = '';
    img.loading = 'lazy';
    // Обложки на CDN Meta тоже живут не вечно: протухшая — значок вместо дыры.
    img.addEventListener('error', () => {
      cover.textContent = '';
      cover.append(icon('music', { size: 16 }));
    });
    cover.append(img);
  } else {
    cover.append(icon('music', { size: 16 }));
  }
  row.append(cover);

  const text = el('div', 'sound__text');
  text.append(el('div', 'sound__title', audio.title || 'без названия'));
  const meta = [whoOf(audio), durationText(audio.durationMs)].filter(Boolean).join(' · ');
  text.append(el('div', 'sound__meta', meta));
  row.append(text);

  if (audio.type === 'music' || audio.previewUrl) {
    row.append(playButton(audio, projectId));
  } else if (audio.pageUrl) {
    const link = el('a', 'btn btn--quiet btn--icon');
    link.href = audio.pageUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Открыть ${label(audio)} в Instagram`);
    link.title = 'Файла для прослушки у оригинальных звуков нет — откроется страница звука';
    link.innerHTML = iconMarkup('link', 14);
    row.append(link);
  }
  if (extra) row.append(extra);
  return row;
}

/* ------------------------------ компонент ------------------------------ */

/**
 * @param {object} opts
 * @param {number} opts.projectId
 * @param {object|null} opts.audio  звук цели (post_targets.audio)
 * @param {{kind: 'video'|'render'|null, why?: string}} opts.reel
 *   что уйдёт в Instagram: свой ролик, ролик из фото или вовсе не Reels
 * @param {(next: object|null, opts: {commit: boolean}) => void} opts.onChange
 *   commit — сохранить и перерисовать; иначе тихое автосохранение
 */
export function audioField({ projectId, audio, reel, onChange }) {
  const box = el('div', 'sound');
  let browsing = !audio?.id;
  let tab = audio?.type === 'original_sound' ? 'original_sound' : 'music';
  let query = '';
  let searchTimer = null;
  let requestNo = 0;

  render();
  return box;

  function render() {
    box.textContent = '';

    if (!reel?.kind) {
      box.append(
        note('info', 'Звук — только у Reels', reel?.why || 'Instagram прикрепляет звук из библиотеки только к Reels.')
      );
      if (audio) {
        box.append(button('Убрать звук', { variant: 'quiet', iconName: 'x', onClick: () => onChange(null, { commit: true }) }));
      }
      return;
    }

    if (audio?.missing) {
      box.append(note('danger', 'Звук пропал из библиотеки Instagram', 'С ним пост не выйдет — выберите другой трек.'));
    }

    if (audio?.id && !browsing) renderSelected();
    else renderBrowser();

    if (reel.kind === 'video' && !audio?.id) renderOwnName();
  }

  function renderSelected() {
    const actions = el('div', 'sound__actions');
    actions.append(
      button('Сменить', {
        variant: 'quiet',
        iconName: 'search',
        onClick: () => {
          stopPlayer();
          browsing = true;
          render();
        },
      }),
      button('Убрать', {
        variant: 'quiet',
        iconName: 'x',
        onClick: () => {
          stopPlayer();
          onChange(null, { commit: true });
        },
      })
    );
    box.append(trackLine(audio, projectId));
    box.append(actions);

    const levels = el('div', 'sound__levels');
    levels.append(slider('Громкость трека', 'audioVolume'));
    // У ролика из фото своего звука нет — ползунок был бы про пустоту.
    if (reel.kind === 'video') levels.append(slider('Звук самого ролика', 'videoVolume'));
    box.append(levels);

    box.append(
      el(
        'span',
        'field__hint',
        'Готовый ролик со звуком Instagram до публикации не показывает, а с какого места пойдёт трек, решает сам.'
      )
    );
  }

  function slider(title, key) {
    const wrap = el('label', 'sound__level');
    const head = el('span', 'sound__level-head');
    const value = el('output', 'sound__level-value tnum', `${audio[key] ?? 100}%`);
    head.append(el('span', 'field__label', title), value);
    const input = el('input', 'sound__range');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '5';
    input.value = String(audio[key] ?? 100);
    input.addEventListener('input', () => {
      value.textContent = `${input.value}%`;
      audio = { ...audio, [key]: Number(input.value) };
      onChange(audio, { commit: false });
    });
    wrap.append(head, input);
    return wrap;
  }

  function renderBrowser() {
    const tabs = el('div', 'chips');
    for (const t of TABS) {
      const chip = el('button', 'chip', t.title);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(tab === t.id));
      chip.addEventListener('click', () => {
        if (tab === t.id) return;
        tab = t.id;
        render();
      });
      tabs.append(chip);
    }
    const head = el('div', 'sound__head');
    head.append(tabs);
    if (audio?.id) {
      head.append(
        button('Отмена', {
          variant: 'quiet',
          onClick: () => {
            stopPlayer();
            browsing = false;
            render();
          },
        })
      );
    }
    box.append(head);
    box.append(el('span', 'field__hint', TABS.find((t) => t.id === tab).hint));

    const search = el('div', 'search sound__search');
    search.append(icon('search', { size: 15, className: 'search__icon' }));
    const input = el('input', 'input');
    input.type = 'search';
    input.value = query;
    input.placeholder = 'Название или автор. Пусто — то, что в тренде';
    input.setAttribute('aria-label', 'Поиск звука в библиотеке Instagram');
    search.append(input);
    box.append(search);

    const list = el('ul', 'sound__list');
    list.setAttribute('aria-live', 'polite');
    box.append(list);

    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = input.value.trim();
        load(list, { reset: true });
      }, 450);
    });

    load(list, { reset: true });
  }

  async function load(list, { reset = false, after = '' } = {}) {
    const my = ++requestNo;
    if (reset) {
      list.textContent = '';
      list.append(el('li', 'sound__status', query ? 'Ищу…' : 'Загружаю то, что в тренде…'));
    }
    try {
      const data = await api.audioSearch({ type: tab, q: query, after, projectId });
      if (my !== requestNo) return; // пока ждали, человек напечатал дальше
      list.querySelector('.sound__status')?.remove();
      list.querySelector('.sound__more')?.remove();
      if (reset && !data.items.length) {
        list.append(el('li', 'sound__status', query ? 'Ничего не нашлось — попробуйте по-английски' : 'Instagram не прислал трендов'));
        return;
      }
      for (const item of data.items) {
        const li = el('li');
        const pick = button('Выбрать', {
          variant: 'quiet',
          onClick: () => {
            stopPlayer();
            // Громкость переносится со старого трека: её выставляли под ролик.
            const next = {
              id: item.id,
              type: item.type,
              title: item.title,
              artist: item.artist,
              username: item.username,
              durationMs: item.durationMs,
              cover: item.cover,
              audioVolume: audio?.audioVolume ?? 100,
              videoVolume: audio?.videoVolume ?? (reel.kind === 'render' ? 0 : 100),
            };
            browsing = false;
            onChange(next, { commit: true });
          },
        });
        pick.classList.add('btn--sm');
        li.append(trackLine(item, projectId, { extra: pick }));
        list.append(li);
      }
      if (data.after) {
        const more = el('li', 'sound__more');
        more.append(button('Ещё', { variant: 'quiet', onClick: () => load(list, { after: data.after }) }));
        list.append(more);
      }
    } catch (err) {
      if (my !== requestNo) return;
      list.textContent = '';
      const li = el('li');
      li.append(note('danger', 'Звуки не загрузились', err.message));
      list.append(li);
    }
  }

  /**
   * Название собственного звука ролика. Если ролик станет популярным и его
   * звук возьмут другие, их Reels будут подписаны этим названием и вести к нам.
   */
  function renderOwnName() {
    const field = el('div', 'field sound__own');
    field.append(el('label', 'field__label', 'Или назовите собственный звук ролика'));
    const input = el('input', 'input');
    input.maxLength = 100;
    input.placeholder = 'Мій комп’ютер · тема ролика';
    input.value = audio?.ownName || '';
    input.addEventListener('input', () => {
      const name = input.value.trim();
      audio = name ? { ownName: name } : null;
      onChange(audio, { commit: false });
    });
    field.append(input);
    field.append(el('span', 'field__hint', 'Instagram разрешает назвать звук только один раз — потом не переименовать.'));
    box.append(field);
  }
}
