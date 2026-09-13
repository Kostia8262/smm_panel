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
import { el, button, iconButton, note, toast, panel, humanBytes } from '../ui.js';
import { makeThumb } from '../thumbs.js';
import { dateTimeField } from '../datetime.js';
import { withSignature } from '../signature.js';

/** Как называется состояние поста и каким цветом его показывать. */
const STATE = {
  draft: { title: 'Черновик', cls: '' },
  review: { title: 'Ждёт утверждения', cls: 'state--review' },
  scheduled: { title: 'В очереди', cls: 'state--scheduled' },
  publishing: { title: 'Публикуется', cls: 'state--scheduled' },
  published: { title: 'Опубликован', cls: 'state--published' },
  partial: { title: 'Ушло не всюду', cls: 'state--partial' },
  failed: { title: 'Не ушло', cls: 'state--failed' },
};

export function composerView(ctx, postId) {
  let post = null;
  let specs = ctx.state.specs;
  let schedule = null; // рубрики и слоты проекта
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
      schedule = await api.schedule();
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
    renderTopbar();
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
        scheduled_at: post.scheduled_at,
        category_id: post.category_id ?? null,
        recycle: post.recycle ? 1 : 0,
        skip_signature: post.skip_signature ? 1 : 0,
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
    const isOwner = ctx.state.user.role === 'owner';
    const state = STATE[post.status] || STATE.draft;
    const actions = [];

    // Уже опубликованное не редактируется кнопками очереди: пост ушёл,
    // и «поставить в очередь» второй раз означало бы дубль в пяти сетях.
    if (post.status === 'review' && isOwner) {
      actions.push(
        button('Вернуть на доработку', {
          iconName: 'x',
          onClick: async () => {
            const note = prompt('Что поправить? Это увидит автор поста.');
            if (!note) return;
            try {
              post = (await api.reject(post.id, note)).post;
              toast('Возвращён на доработку', 'ok');
              renderTopbar();
              renderAll();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
      actions.push(
        button('Утвердить и в очередь', {
          variant: 'primary',
          iconName: 'check',
          onClick: async () => {
            try {
              post = (await api.approve(post.id)).post;
              toast('Утверждён — уйдёт по расписанию', 'ok');
              location.hash = '#/';
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
    } else if (post.status === 'scheduled' || post.status === 'review') {
      actions.push(
        button('Снять с очереди', {
          iconName: 'x',
          onClick: async () => {
            try {
              post = (await api.unschedule(post.id)).post;
              toast('Снят с очереди, снова черновик', 'ok');
              renderTopbar();
              renderAll();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
    } else if (post.status !== 'published') {
      if (isOwner) {
        actions.push(
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
          })
        );
      }
      actions.push(
        button(isOwner ? 'В очередь' : 'Отправить на утверждение', {
          variant: 'primary',
          iconName: 'clock',
          onClick: async () => {
            if (!(await save({ quiet: true }))) return;
            try {
              const res = await api.enqueue(post.id);
              for (const w of res.warnings || []) toast(`${w.platform}: ${w.message}`);
              toast(res.review ? 'Отправлен владельцу на утверждение' : 'Пост в очереди', 'ok');
              location.hash = '#/';
            } catch (err) {
              toast(err.message, 'danger');
              reload();
            }
          },
        })
      );
    }

    // Повтор того, что не ушло, — отдельным действием: публиковать заново
    // весь пост значит продублировать его там, где он уже вышел.
    if (post.status === 'partial' || post.status === 'failed') {
      actions.push(
        button('Повторить неудачные', {
          variant: 'primary',
          iconName: 'refresh',
          onClick: async () => {
            try {
              const res = await api.publishNow(post.id);
              const failed = (res.result?.results || []).filter((r) => r.error);
              toast(failed.length ? `Снова не ушло: ${failed.length}` : 'Всё ушло', failed.length ? 'danger' : 'ok');
              reload();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        })
      );
    }

    const badge = el('span', `state ${state.cls}`);
    badge.append(el('span', `dot dot--${dotFor(post.status)}`));
    badge.append(el('span', null, state.title));

    ctx.setTopbar({
      title: 'Пост',
      subtitle: '',
      back: '#/',
      actions: [badge, ...actions, deleteButton()],
    });
  }

  function deleteButton() {
    return iconButton('trash', {
      title: 'Удалить пост',
      variant: 'danger',
      onClick: async () => {
        if (!confirm('Удалить пост? Отменить это нельзя.')) return;
        try {
          await api.deletePost(post.id);
          toast('Пост удалён', 'ok');
          location.hash = '#/';
        } catch (err) {
          toast(err.message, 'danger');
        }
      },
    });
  }

  function dotFor(status) {
    if (status === 'published') return 'ok';
    if (status === 'failed' || status === 'partial') return 'danger';
    if (status === 'scheduled' || status === 'review') return 'warn';
    return 'idle';
  }

  /* ------------------------------ отрисовка ------------------------------ */

  function renderAll() {
    left.textContent = '';
    const blocks = [
      reviewNote(),
      sectionFailures(),
      sectionProject(),
      sectionText(),
      sectionTargets(),
      sectionMedia(),
      sectionWhen(),
      sectionReport(),
      sectionIssues(),
    ].filter(Boolean);
    left.append(...blocks);
    renderPreview();
  }

  /** Замечание владельца при возврате: без него автор не знает, что чинить. */
  function reviewNote() {
    if (!post.review_note) return null;
    const p = el('div');
    p.append(note('warn', 'Возвращён на доработку', post.review_note));
    return p;
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

    p.append(title, body, counters, signatureBlock());
    queueMicrotask(renderCounters);
    return p;
  }

  /**
   * Итоговый текст — тот же, что уйдёт в сеть. Счётчики, превью и проверка
   * обязаны смотреть на одно значение, иначе пост пройдёт здесь и отвалится
   * у площадки.
   */
  function finalText(target = null) {
    const own = target?.text_override ?? root.querySelector('#body')?.value ?? post.body ?? '';
    return withSignature(own, post.skip_signature ? '' : post.signature);
  }

  function renderCounters() {
    const host = root.querySelector('#counters');
    if (!host) return;
    host.textContent = '';
    const hasMedia = (post.media || []).length > 0;

    for (const t of post.targets) {
      const spec = specs.find((s) => s.id === t.platform);
      if (!spec) continue;
      const limit = hasMedia ? spec.text.limitWithMedia : spec.text.limit;
      const text = finalText(t);
      const over = text.length > limit;
      const near = !over && text.length > limit * 0.9;
      const chip = el('span', `counter${over ? ' counter--over' : near ? ' counter--warn' : ''}`);
      chip.innerHTML = iconMarkup(t.platform, 12);
      chip.append(el('span', null, `${text.length}/${limit}`));
      chip.title = `${spec.title}: предел ${limit} символов`;
      host.append(chip);
    }
  }

  /**
   * Подпись проекта показывается прямо под текстом, а не прячется в
   * настройках: человек должен видеть, что именно уйдёт в сеть, до того
   * как нажмёт «в очередь».
   */
  function signatureBlock() {
    if (!post.signatureEnabled) return el('span');
    const box = el('div', 'signature');

    const head = el('div', 'signature__head');
    head.append(icon('drafts', { size: 14 }));
    head.append(el('span', 'field__label', 'Подпись проекта'));

    const off = el('label', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !post.skip_signature;
    input.setAttribute('aria-label', 'Добавлять подпись к этому посту');
    const mark = el('span', 'switch__box');
    mark.innerHTML = iconMarkup('check', 12);
    off.append(input, mark);
    input.addEventListener('change', async () => {
      post.skip_signature = input.checked ? 0 : 1;
      await save({ quiet: true });
      renderAll();
    });
    head.append(el('span', 'spacer'));
    head.append(off);
    box.append(head);

    const text = el('pre', 'signature__text', post.projectSignature || '');
    if (post.skip_signature) text.classList.add('signature__text--off');
    box.append(text);
    box.append(
      el(
        'span',
        'field__hint',
        post.skip_signature
          ? 'У этого поста подписи не будет.'
          : 'Уйдёт в конце поста. Правится в карточке проекта, ссылка в ней тоже считает переходы.'
      )
    );
    return box;
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

      // Переопределение текста. Нужно прежде всего Threads с его 500 знаками:
      // общий текст туда не влезает, а резать его во всех сетях — терять смысл.
      if (active) {
        const hasOverride = active.text_override !== null && active.text_override !== undefined;
        const toggle = el('button', 'chip');
        toggle.type = 'button';
        toggle.setAttribute('aria-pressed', String(hasOverride));
        toggle.textContent = hasOverride ? 'Свой текст' : 'Свой текст…';
        toggle.title = 'Написать для этой площадки отдельный текст';
        toggle.addEventListener('click', async () => {
          active.text_override = hasOverride ? null : (post.body || '');
          await save({ quiet: true });
          renderAll();
        });
        meta.append(toggle);
      }

      row.append(meta);
      list.append(row);

      if (active && active.text_override !== null && active.text_override !== undefined) {
        list.append(overrideBox(spec, active));
      }
    }

    p.append(list);
    return p;
  }

  function overrideBox(spec, target) {
    const box = el('div', 'override');
    const head = el('div', 'override__head');
    head.append(el('span', 'field__label', `Текст только для ${spec.title}`));
    const counter = el('span', 'counter');
    head.append(counter);
    box.append(head);

    const area = el('textarea', 'textarea');
    area.value = target.text_override || '';
    const limit = (post.media || []).length ? spec.text.limitWithMedia : spec.text.limit;
    const refresh = () => {
      counter.textContent = `${area.value.length}/${limit}`;
      counter.className = `counter${area.value.length > limit ? ' counter--over' : ''}`;
    };
    refresh();
    area.addEventListener('input', () => {
      target.text_override = area.value;
      refresh();
      autosave();
    });
    box.append(area);
    return box;
  }

  /** Что именно не ушло — в самом посте, а не только в общем журнале. */
  function sectionFailures() {
    const failed = (post.targets || []).filter((t) => t.status === 'failed' && t.error);
    if (!failed.length) return null;
    const p = panel('Не ушло');
    for (const t of failed) {
      const spec = specs.find((s) => s.id === t.platform);
      p.append(note('danger', spec ? spec.title : t.platform, `${t.error} · попыток: ${t.attempts}`));
    }
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
        // Файл опубликованного поста снимается с диска (retention.js). Есть
        // миниатюра — показываем её с пометкой; нет (кадр загружен до
        // миниатюр) — заглушку, а не битую картинку.
        if (m.purged && m.thumbUrl) {
          const img = el('img');
          img.src = m.thumbUrl;
          img.alt = m.original_name;
          item.append(img);
          item.append(el('span', 'media__badge', 'снят с сервера'));
        } else if (m.purged) {
          const gone = el('div', 'media__gone');
          gone.append(icon('check', { size: 18 }));
          gone.append(el('span', null, 'снят после публикации'));
          item.append(gone);
        } else if (m.thumbUrl) {
          // Для карточки в сто пикселей хватает миниатюры: тянуть сюда
          // многомегабайтный оригинал, а тем более видео, незачем.
          const img = el('img');
          img.src = m.thumbUrl;
          img.alt = m.original_name;
          item.append(img);
          if (m.kind === 'video') {
            const mark = el('span', 'media__play');
            mark.innerHTML = iconMarkup('video', 14);
            item.append(mark);
          }
        } else if (m.kind === 'video') {
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
    files = [...files];
    ctx.setSaveState('готовлю миниатюры…');
    // Миниатюры — до загрузки и все разом: каждая занимает миллисекунды для
    // картинки и до пары секунд для видео. Не получилась — файл уйдёт без неё.
    const thumbs = await Promise.all(files.map((f) => makeThumb(f)));
    ctx.setSaveState('загружаю файлы…');
    try {
      const data = await api.uploadMedia(post.id, files, thumbs);
      post = data.post;
      ctx.setSaveState('загружено');
      renderAll();
    } catch (err) {
      toast(err.message, 'danger');
      ctx.setSaveState('');
    }
  }

  /**
   * В каком проекте живёт пост. Стоит первым и отдельно: от этого зависит,
   * в чьи аккаунты он уйдёт и какая подпись к нему приклеится. Менять можно,
   * пока пост никуда не ушёл — потом в сетях осталась бы запись от одной
   * школы, а в панели числилась бы другая.
   */
  function sectionProject() {
    const project = ctx.state.projects.find((pr) => pr.id === post.project_id);
    const published = (post.targets || []).some((t) => t.status === 'published');

    const p = panel('Проект');
    if (published) {
      const row = el('div', 'target__name');
      if (project) {
        const dot = el('span', 'projsw__dot');
        dot.style.background = project.accent;
        row.append(dot);
      }
      row.append(el('span', null, project ? project.title : 'не указан'));
      p.append(row);
      p.append(el('span', 'field__hint', 'Пост уже публиковался — проект менять поздно.'));
      return p;
    }

    const select = el('select', 'select');
    for (const pr of ctx.state.projects) {
      const opt = new Option(pr.title, String(pr.id));
      if (pr.id === post.project_id) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', async () => {
      const next = Number(select.value);
      if (!confirm('Пост уйдёт в аккаунты другой школы, а рубрика сбросится. Продолжить?')) {
        select.value = String(post.project_id);
        return;
      }
      try {
        const data = await api.updatePost(post.id, { project_id: next });
        post = data.post;
        schedule = await api.schedule();
        toast('Пост переведён в другой проект', 'ok');
        renderTopbar();
        renderAll();
      } catch (err) {
        select.value = String(post.project_id);
        toast(err.message, 'danger');
      }
    });
    p.append(select);
    p.append(
      el('span', 'field__hint', 'Определяет аккаунты, расписание и подпись. Рубрика принадлежит проекту и при переезде сбрасывается.')
    );
    return p;
  }

  function sectionWhen() {
    const p = panel('Когда и что это');

    // Рубрика решает две вещи сразу: в какой слот пост ложится и вернётся ли
    // он в оборот. Поэтому она стоит рядом со временем, а не в другом углу.
    const catWrap = el('div', 'field');
    catWrap.append(el('label', 'field__label', 'Рубрика'));
    const cat = el('select', 'select');
    cat.append(new Option('— без рубрики —', ''));
    for (const c of schedule?.categories || []) {
      const opt = new Option(c.evergreen ? `${c.title} · вечнозелёная` : c.title, String(c.id));
      if (post.category_id === c.id) opt.selected = true;
      cat.append(opt);
    }
    cat.addEventListener('change', async () => {
      post.category_id = cat.value ? Number(cat.value) : null;
      await save({ quiet: true });
      renderAll();
    });
    catWrap.append(cat);
    p.append(catWrap);

    const current = (schedule?.categories || []).find((c) => c.id === post.category_id);
    if (current?.evergreen) {
      const row = el('div', 'target');
      row.classList.add('target--on');
      const sw = el('label', 'switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = Boolean(post.recycle);
      input.setAttribute('aria-label', 'Повторять пост');
      const box = el('span', 'switch__box');
      box.innerHTML = iconMarkup('check', 12);
      sw.append(input, box);
      input.addEventListener('change', async () => {
        post.recycle = input.checked;
        await save({ quiet: true });
      });
      const label = el('div');
      label.append(el('div', 'target__name', 'Пустить по второму кругу'));
      label.append(
        el('div', 'dim small', `После публикации копия встанет в очередь через ${current.recycleDays} дней.`)
      );
      row.append(sw, label, el('span'));
      p.append(row);
    }

    p.append(
      dateTimeField({
        value: post.scheduled_at,
        label: 'Время публикации',
        onChange: (dbValue) => {
          post.scheduled_at = dbValue;
          save({ quiet: true });
        },
      })
    );

    // Ближайший свободный слот — чтобы не выбирать время у каждого поста.
    const slotRow = el('div', 'target__meta');
    slotRow.style.justifyContent = 'flex-start';
    slotRow.append(
      button('В ближайший слот', {
        iconName: 'clock',
        onClick: async () => {
          try {
            const res = await api.toSlot(post.id);
            post = res.post;
            toast(`Поставлен на ${res.scheduledAt.slice(0, 16)}`, 'ok');
            renderAll();
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      })
    );
    if (schedule?.nextFree) {
      slotRow.append(el('span', 'dim small', `ближайший свободный: ${schedule.nextFree.slice(0, 16)}`));
    } else {
      slotRow.append(el('span', 'dim small', 'сетка расписания пуста — задайте её в настройках'));
    }
    p.append(slotRow);
    return p;
  }

  /** Что пост принёс: переходы и заявки. Показываем только когда он вышел. */
  function sectionReport() {
    if (!['published', 'partial'].includes(post.status)) return null;
    const p = panel('Что принёс пост');
    const body = el('div', 'issues');
    body.append(el('span', 'dim small', 'считаю переходы и заявки…'));
    p.append(body);

    api
      .report(post.id)
      .then((r) => {
        body.textContent = '';
        const row = el('div', 'counters');
        row.append(el('span', 'counter', `переходов: ${r.clicks.total}`));
        for (const [platform, n] of Object.entries(r.clicks.byPlatform)) {
          const chip = el('span', 'counter');
          chip.innerHTML = iconMarkup(platform, 12);
          chip.append(el('span', null, String(n)));
          row.append(chip);
        }
        if (r.leads) row.append(el('span', 'counter', `заявок: ${r.leads.count}`));
        body.append(row);

        if (r.campaign) body.append(el('div', 'dim small', `метка: ${r.campaign}`));
        if (r.leadsError) body.append(note('warn', 'Заявки не посчитаны', r.leadsError));
        if (r.leads?.items?.length) {
          const list = el('ul', 'platform__notes');
          for (const lead of r.leads.items) {
            list.append(el('li', null, `${lead.name || 'без имени'} · ${lead.createdAt || ''}`));
          }
          body.append(list);
        }
      })
      .catch((err) => {
        body.textContent = '';
        body.append(note('danger', 'Отчёт не собрался', err.message));
      });

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
    const activeTarget = post.targets.find((t) => keyOf(t) === previewKey);
    const text = finalText(activeTarget);

    const stage = el('div', 'preview__stage');
    const frame = el('div', 'frame');
    const crop = el('div', 'frame__crop focus-pick');
    crop.style.aspectRatio = `${format.w} / ${format.h}`;

    if (media?.purged && media.thumbUrl) {
      // Оригинал снят, но миниатюра осталась: кадр видно, хоть и в малом
      // размере. Точку фокуса здесь не меняем — отправлять уже нечего.
      const node = el('img', 'frame__media');
      node.src = media.thumbUrl;
      node.alt = '';
      node.style.objectPosition = `${(media.focus_x ?? 0.5) * 100}% ${(media.focus_y ?? 0.5) * 100}%`;
      crop.append(node);
      crop.append(el('span', 'frame__note', 'Опубликован · файл снят с сервера, показана миниатюра'));
    } else if (media?.purged) {
      // Пост ушёл во все сети, и кадр снят с диска, чтобы не занимать место
      // общего с сайтами сервера. Сам пост живёт в сетях — там его и смотреть.
      const holder = el('div', 'frame__empty');
      holder.append(icon('check', { size: 26 }));
      holder.append(el('span', null, 'Пост опубликован, файл снят с сервера. Кадр — в самих сетях.'));
      crop.append(holder);
    } else if (media) {
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
