/**
 * Композер поста — отдельный экран, а не окно поверх календаря.
 *
 * Модальное окно здесь было бы ленью: работа с постом идёт минутами, к ней
 * возвращаются по ссылке, и её нельзя запирать в слой поверх списка.
 *
 * Правая колонка — превью. Она отвечает на два вопроса, ради которых панель
 * и затевалась: не срежет ли интерфейс площадки главное в кадре и что
 * увидит подписчик под картинкой.
 */

import { api } from '../api.js';
import { icon, iconMarkup } from '../icons.js';
import {
  el, button, iconButton, note, toast, panel,
  toLocalInput, fromLocalInput, humanBytes,
} from '../ui.js';

export function composerView(ctx, postId) {
  let post = null;
  let specs = ctx.state.specs;
  let previewKey = null;
  let showZones = true;
  let saveTimer = null;

  const root = el('div', 'view');
  const layout = el('div', 'composer');
  const left = el('div', 'composer__col');
  const right = el('aside', 'preview');
  layout.append(left, right);
  root.append(layout);

  load();
  return root;

  /* ------------------------------ данные ------------------------------ */

  async function load() {
    try {
      if (!specs) {
        specs = (await api.specs()).platforms;
        ctx.state.specs = specs;
      }
      post = (await api.post(postId)).post;
    } catch (err) {
      toast(err.message, 'danger');
      location.hash = '#/';
      return;
    }
    previewKey = keyOf(post.targets[0]);
    renderTopbar();
    renderAll();
  }

  async function reload() {
    post = (await api.post(postId)).post;
    renderAll();
  }

  /** Сохранение по паузе в наборе: человек не должен помнить про кнопку. */
  function autosave() {
    clearTimeout(saveTimer);
    ctx.setSaveState('изменения не сохранены');
    saveTimer = setTimeout(() => save({ quiet: true }), 900);
  }

  async function save({ quiet = false } = {}) {
    clearTimeout(saveTimer);
    ctx.setSaveState('сохраняю…');
    try {
      const data = await api.updatePost(post.id, {
        title: root.querySelector('#title')?.value ?? post.title,
        body: root.querySelector('#body')?.value ?? post.body,
        scheduled_at: fromLocalInput(root.querySelector('#when')?.value || ''),
        targets: post.targets,
      });
      post = data.post;
      ctx.setSaveState('сохранено');
      if (!quiet) toast('Сохранено', 'ok');
      renderIssues();
      renderCounters();
      return true;
    } catch (err) {
      ctx.setSaveState('не сохранилось');
      toast(err.message, 'danger');
      return false;
    }
  }

  /* ------------------------------ шапка ------------------------------ */

  function renderTopbar() {
    ctx.setTopbar({
      title: 'Пост',
      subtitle: '',
      back: '#/',
      actions: [
        button('Опубликовать сейчас', {
          iconName: 'send',
          onClick: async () => {
            if (!(await save({ quiet: true }))) return;
            if (!confirm('Опубликовать во все выбранные площадки прямо сейчас?')) return;
            try {
              const res = await api.publishNow(post.id);
              const failed = (res.result?.results || []).filter((r) => r.error);
              if (failed.length) toast(`Не ушло: ${failed.map((f) => f.platform).join(', ')}`, 'danger');
              else toast('Опубликовано', 'ok');
              reload();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        }),
        button('В очередь', {
          variant: 'primary',
          iconName: 'clock',
          onClick: async () => {
            if (!(await save({ quiet: true }))) return;
            try {
              const res = await api.schedule(post.id);
              for (const w of res.warnings || []) toast(`${w.platform}: ${w.message}`);
              toast('Пост в очереди', 'ok');
              location.hash = '#/';
            } catch (err) {
              toast(err.message, 'danger');
              reload();
            }
          },
        }),
      ],
    });
  }

  /* ------------------------------ отрисовка ------------------------------ */

  function renderAll() {
    left.textContent = '';
    left.append(sectionText(), sectionTargets(), sectionMedia(), sectionWhen(), sectionIssues());
    renderPreview();
  }

  function sectionText() {
    const p = panel('Текст');
    const title = el('input', 'input');
    title.id = 'title';
    title.placeholder = 'Название поста — видно только нам';
    title.value = post.title || '';
    title.addEventListener('input', autosave);

    const body = el('textarea', 'textarea');
    body.id = 'body';
    body.rows = 8;
    body.placeholder = 'Текст поста. Где не влезает — переопределим под площадку.';
    body.value = post.body || '';
    body.addEventListener('input', () => {
      renderCounters();
      renderPreview();
      autosave();
    });

    const counters = el('div', 'counters');
    counters.id = 'counters';

    p.append(title, body, counters);
    queueMicrotask(renderCounters);
    return p;
  }

  function renderCounters() {
    const host = root.querySelector('#counters');
    if (!host) return;
    host.textContent = '';
    const text = root.querySelector('#body')?.value ?? post.body ?? '';
    const hasMedia = (post.media || []).length > 0;

    for (const t of post.targets) {
      const spec = specs.find((s) => s.id === t.platform);
      if (!spec) continue;
      const limit = hasMedia ? spec.text.limitWithMedia : spec.text.limit;
      const over = text.length > limit;
      const near = !over && text.length > limit * 0.9;
      const chip = el('span', `counter${over ? ' counter--over' : near ? ' counter--warn' : ''}`);
      chip.innerHTML = iconMarkup(t.platform, 12);
      chip.append(el('span', null, `${text.length}/${limit}`));
      chip.title = `${spec.title}: предел ${limit} символов`;
      host.append(chip);
    }
  }

  function sectionTargets() {
    const p = panel('Куда публикуем');
    const list = el('div', 'targets');

    for (const spec of specs) {
      const active = post.targets.find((t) => t.platform === spec.id);
      const row = el('div', `target ${active ? 'target--on' : 'target--off'}`);

      const sw = el('label', 'switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = Boolean(active);
      input.setAttribute('aria-label', `Публиковать в ${spec.title}`);
      const box = el('span', 'switch__box');
      box.innerHTML = iconMarkup('check', 12);
      sw.append(input, box);
      input.addEventListener('change', async () => {
        if (input.checked) post.targets.push({ platform: spec.id, format_id: spec.formats[0].id });
        else post.targets = post.targets.filter((t) => t.platform !== spec.id);
        await save({ quiet: true });
        renderAll();
      });
      row.append(sw);

      const name = el('div', 'target__name');
      const mark = el('span', 'mark');
      mark.innerHTML = iconMarkup(spec.id, 12);
      name.append(mark, el('span', null, spec.title));
      row.append(name);

      const meta = el('div', 'target__meta');
      const conn = ctx.state.connections?.find((c) => c.id === spec.id);
      if (conn && !conn.configured) {
        const tag = el('span', 'tag tag--warn', 'нет токена');
        tag.title = `Не хватает: ${conn.missing.join(', ')}`;
        meta.append(tag);
      }
      const select = el('select', 'select');
      select.setAttribute('aria-label', `Раскладка для ${spec.title}`);
      for (const f of spec.formats) {
        // Без размеров: они есть в «Ограничениях площадки», а здесь режутся на телефоне
        const opt = el('option', null, f.title);
        opt.value = f.id;
        if (active && active.format_id === f.id) opt.selected = true;
        select.append(opt);
      }
      select.disabled = !active;
      select.addEventListener('change', async () => {
        active.format_id = select.value;
        previewKey = keyOf(active);
        await save({ quiet: true });
        renderAll();
      });
      meta.append(select);
      row.append(meta);

      list.append(row);
    }

    p.append(list);
    return p;
  }

  function sectionMedia() {
    const p = panel('Медиа');

    const zone = el('div', 'dropzone');
    zone.append(icon('upload', { size: 24 }));
    zone.append(el('div', 'dropzone__title', 'Перетащите мастер-файл'));
    const hint = el('p', 'small muted');
    hint.textContent = 'Один файл в максимальном качестве — нарезки под площадки посчитаются сами. ';
    const pick = el('button', 'btn btn--sm');
    pick.type = 'button';
    pick.textContent = 'Выбрать файл';
    hint.append(document.createElement('br'), pick);
    zone.append(hint);

    const input = el('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*';
    input.hidden = true;
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', () => upload([...input.files]));

    for (const evt of ['dragenter', 'dragover']) {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        zone.classList.add('dropzone--hot');
      });
    }
    for (const evt of ['dragleave', 'drop']) {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        zone.classList.remove('dropzone--hot');
      });
    }
    zone.addEventListener('drop', (e) => upload([...e.dataTransfer.files]));

    p.append(zone, input);

    if ((post.media || []).length) {
      const list = el('div', 'media');
      for (const m of post.media) {
        const item = el('div', 'media__item');
        if (m.kind === 'video') {
          const v = el('video');
          v.src = m.url;
          v.muted = true;
          item.append(v);
        } else {
          const img = el('img');
          img.src = m.url;
          img.alt = m.original_name;
          item.append(img);
        }
        const del = el('button', 'media__del');
        del.type = 'button';
        del.title = 'Удалить файл';
        del.innerHTML = iconMarkup('x', 13);
        del.addEventListener('click', async () => {
          await api.deleteMedia(m.id);
          await reload();
        });
        item.append(del);
        item.append(
          el('div', 'media__meta', `${m.width && m.height ? `${m.width}×${m.height}` : m.kind} · ${humanBytes(m.bytes)}`)
        );
        list.append(item);
      }
      p.append(list);
    }

    return p;
  }

  async function upload(files) {
    if (!files.length) return;
    ctx.setSaveState('загружаю файлы…');
    try {
      const data = await api.uploadMedia(post.id, files);
      post = data.post;
      ctx.setSaveState('загружено');
      renderAll();
    } catch (err) {
      toast(err.message, 'danger');
      ctx.setSaveState('');
    }
  }

  function sectionWhen() {
    const p = panel('Когда');
    const field = el('div', 'field');
    const input = el('input', 'input');
    input.id = 'when';
    input.type = 'datetime-local';
    input.value = toLocalInput(post.scheduled_at);
    input.addEventListener('change', autosave);
    field.append(input);
    field.append(el('span', 'field__hint', 'Пусто — пост останется черновиком без даты.'));
    p.append(field);
    return p;
  }

  function sectionIssues() {
    const p = panel('Проверка');
    const box = el('div', 'issues');
    box.id = 'issues';
    p.append(box);
    queueMicrotask(renderIssues);
    return p;
  }

  function renderIssues() {
    const host = root.querySelector('#issues');
    if (!host) return;
    host.textContent = '';
    const v = post.validation || { blockers: [], warnings: [] };

    if (!v.blockers.length && !v.warnings.length) {
      host.append(note('ok', 'Всё сходится', 'Пост можно ставить в очередь.'));
      return;
    }
    for (const b of v.blockers) {
      host.append(note('danger', titleOf(b.platform), b.message));
    }
    for (const w of v.warnings) {
      host.append(note('warn', titleOf(w.platform), w.message));
    }
  }

  function titleOf(platformId) {
    return specs.find((s) => s.id === platformId)?.title || 'Пост';
  }

  /* ------------------------------- превью ------------------------------- */

  function renderPreview() {
    right.textContent = '';
    if (!post.targets.length) {
      right.append(panel('Превью', note('info', 'Площадки не выбраны', 'Отметьте хотя бы одну — здесь появится кадр.')));
      return;
    }
    if (!post.targets.some((t) => keyOf(t) === previewKey)) previewKey = keyOf(post.targets[0]);

    const tabs = el('div', 'preview__tabs');
    for (const t of post.targets) {
      const spec = specs.find((s) => s.id === t.platform);
      const format = spec?.formats.find((f) => f.id === t.format_id);
      if (!spec || !format) continue;
      const tab = el('button', 'chip');
      tab.type = 'button';
      tab.setAttribute('aria-pressed', String(keyOf(t) === previewKey));
      tab.innerHTML = iconMarkup(spec.id, 13);
      tab.append(el('span', null, format.title));
      tab.addEventListener('click', () => {
        previewKey = keyOf(t);
        renderPreview();
      });
      tabs.append(tab);
    }

    // Тумблер зон живёт в том же ряду: он про этот же кадр, а не про экран.
    const zonesToggle = el('button', 'chip');
    zonesToggle.type = 'button';
    zonesToggle.setAttribute('aria-pressed', String(showZones));
    zonesToggle.style.marginLeft = 'auto';
    zonesToggle.innerHTML = iconMarkup('crop', 13);
    zonesToggle.append(el('span', null, 'Зоны'));
    zonesToggle.title = 'Показать, что перекроют кнопки площадки';
    zonesToggle.addEventListener('click', () => {
      showZones = !showZones;
      renderPreview();
    });
    tabs.append(zonesToggle);
    right.append(tabs);

    const [platformId, formatId] = previewKey.split(':');
    const spec = specs.find((s) => s.id === platformId);
    const format = spec.formats.find((f) => f.id === formatId);
    const media = (post.media || [])[0];
    const text = root.querySelector('#body')?.value ?? post.body ?? '';

    const stage = el('div', 'preview__stage');
    const frame = el('div', 'frame');
    const crop = el('div', 'frame__crop focus-pick');
    crop.style.aspectRatio = `${format.w} / ${format.h}`;

    if (media) {
      const node = media.kind === 'video' ? el('video') : el('img');
      node.className = 'frame__media';
      node.src = media.url;
      if (media.kind === 'video') {
        node.muted = true;
        node.loop = true;
        node.autoplay = true;
        node.playsInline = true;
      }
      node.style.objectPosition = `${(media.focus_x ?? 0.5) * 100}% ${(media.focus_y ?? 0.5) * 100}%`;
      crop.append(node);

      // Точка фокуса: клик назначает, что обязано остаться в кадре при обрезке.
      const dot = el('span', 'focus-pick__dot');
      dot.style.left = `${(media.focus_x ?? 0.5) * 100}%`;
      dot.style.top = `${(media.focus_y ?? 0.5) * 100}%`;
      crop.append(dot);
      crop.title = 'Клик — назначить точку, которая не должна уехать при обрезке';
      crop.addEventListener('click', async (e) => {
        const rect = crop.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
        media.focus_x = x;
        media.focus_y = y;
        node.style.objectPosition = `${x * 100}% ${y * 100}%`;
        dot.style.left = `${x * 100}%`;
        dot.style.top = `${y * 100}%`;
        try {
          await api.setFocus(media.id, x, y);
        } catch (err) {
          toast(err.message, 'danger');
        }
      });
    } else {
      const holder = el('div', 'frame__empty');
      holder.append(icon('image', { size: 26 }));
      holder.append(el('span', null, 'Загрузите мастер-файл — здесь появится кадр'));
      crop.append(holder);
    }

    if (showZones) {
      for (const z of format.safeZones || []) {
        const zone = el('div', 'zone');
        zone.style.top = `${z.top}%`;
        zone.style.left = `${z.left}%`;
        zone.style.width = `${z.width}%`;
        zone.style.height = `${z.height}%`;
        zone.append(el('span', 'zone__label', z.label));
        crop.append(zone);
      }
    }

    if (format.gridCrop) {
      const side = (format.w / format.h) * 100;
      const box = el('div', 'grid-crop');
      box.style.height = `${side}%`;
      box.style.top = `${(100 - side) / 2}%`;
      box.title = format.gridCrop.note;
      crop.append(box);
    }

    frame.append(crop);
    if (text) {
      frame.append(el('div', 'frame__caption', text.slice(0, 240) + (text.length > 240 ? '…' : '')));
    }
    stage.append(frame);
    right.append(stage);

    right.append(limitsPanel(spec, format));
  }

  function limitsPanel(spec, format) {
    const p = panel('Ограничения площадки');
    const list = el('div', 'limits');
    const hasMedia = (post.media || []).length > 0;

    addLimit(list, 'Кадр', `${format.w}×${format.h}`);
    addLimit(list, 'Текст', `до ${hasMedia ? spec.text.limitWithMedia : spec.text.limit} знаков`);
    addLimit(list, 'Картинки', spec.media.image.types.map((t) => t.toUpperCase()).join(', '));
    addLimit(
      list,
      'Видео',
      spec.media.video.maxSeconds ? `до ${spec.media.video.maxSeconds} с` : 'без предела длины'
    );
    addLimit(list, 'Файлов за раз', String(spec.media.groupMax));
    if (format.gridCrop) addLimit(list, 'В сетке профиля', format.gridCrop.note);
    p.append(list);

    if (spec.notes?.length) {
      const notes = el('ul', 'platform__notes');
      for (const n of spec.notes) notes.append(el('li', null, n));
      p.append(notes);
    }
    return p;
  }

  function addLimit(host, key, value) {
    const row = el('div', 'limit');
    row.append(el('span', 'limit__key', key));
    row.append(el('span', 'limit__val', value));
    host.append(row);
  }
}

function keyOf(target) {
  return target ? `${target.platform}:${target.format_id}` : null;
}
