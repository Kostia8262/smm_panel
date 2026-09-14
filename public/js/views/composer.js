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
import { emojiButton } from '../emoji.js';
import { audioField } from '../audio.js';
import { reelBuilder, reelPhotos } from '../reel-builder.js';
import { tiktokOptions } from '../tiktok-options.js';
// Общие с сервером: так счётчик и превью делят текст ровно как отправка.
import { withShortLinks } from '../shared/shortlink.js';
import { splitText, TEXT_LIMIT, CAPTION_LIMIT } from '../shared/text-split.js';

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
  let previewFrame = 0; // какой кадр серии или карусели показан в превью
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

  /**
   * Принять пост от сервера, сохранив объекты целей.
   *
   * Автосохранение не перерисовывает экран, а поля и кнопки держат ссылку на
   * объект своей цели. Подмена `post` целиком оставляла их с устаревшими
   * объектами: текст «Свой текст», дописанный после первого автосохранения,
   * терялся (найдено 13.09.2026) — следующее сохранение уходило со старым.
   */
  function adopt(next) {
    const old = new Map((post?.targets || []).map((t) => [keyOf(t), t]));
    next.targets = (next.targets || []).map((t) => {
      const mine = old.get(keyOf(t));
      return mine ? Object.assign(mine, t) : t;
    });
    post = next;
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
      adopt(data.post);
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
              for (const w of res.warnings || []) toast(`${w.label || w.platform}: ${w.message}`);
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
        // Панель прячет пост у себя, но в сетях он остаётся — об этом надо
        // сказать до удаления, а не после.
        const live = (post.targets || []).filter((t) => t.status === 'published').map(labelOf);
        const question = live.length
          ? `Пост остаётся в сетях: ${live.join(', ')}. Удаление в панели его оттуда не снимет — для этого «Снять из сети» в блоке «Где вышел». Всё равно убрать из панели?`
          : 'Удалить пост? Отменить это нельзя.';
        if (!confirm(question)) return;
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
      sectionLive(),
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
    // Кнопка вне #counters: тот пересобирается на каждый символ и унёс бы пикер
    const tools = el('div', 'text-tools');
    tools.append(counters, emojiButton(body));

    p.append(title, body, tools, signatureBlock());
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

  /** Текст таким, каким уйдёт: с подписью и нашими ссылками, ставшими короткими. */
  function sentText(target = null) {
    const text = finalText(target);
    return post.shortLink ? withShortLinks(text, post.shortLink) : text;
  }

  function renderCounters() {
    const host = root.querySelector('#counters');
    if (!host) return;
    host.textContent = '';
    const seen = new Set();

    for (const t of post.targets) {
      const spec = specs.find((s) => s.id === t.platform);
      if (!spec) continue;
      // Сторис текст не уносит, а ленте и Reels одной площадки текст общий —
      // счётчик один на площадку.
      if (formatOf(spec, t.format_id)?.noText || seen.has(spec.id)) continue;
      seen.add(spec.id);
      const hasMedia = mediaOf(t).length > 0;
      const limit = hasMedia ? spec.text.limitWithMedia : spec.text.limit;
      const written = finalText(t);
      const text = sentText(t);
      // Telegram длинный текст не отвергает, а досылает сообщениями — это
      // предупреждение, а не красный отказ.
      const soft = Boolean(spec.text.splits);
      const over = text.length > limit && !soft;
      const near = !over && text.length > limit * (soft ? 1 : 0.9);
      const chip = el('span', `counter${over ? ' counter--over' : near ? ' counter--warn' : ''}`);
      chip.innerHTML = iconMarkup(t.platform, 12);
      const parts = soft ? splitText(text, hasMedia ? CAPTION_LIMIT : TEXT_LIMIT).length : 1;
      chip.append(el('span', null, `${text.length}/${limit}${parts > 1 ? ` · ${parts} сообщ.` : ''}`));
      // Короткие ссылки меняют длину: говорим об этом, иначе цифра расходится с набранным.
      const viaLinks = text.length !== written.length ? ` Считаются короткие ссылки: набрано ${written.length}, уйдёт ${text.length}.` : '';
      chip.title =
        (soft
          ? `${spec.title}: ${limit} символов в ${hasMedia ? 'подписи' : 'сообщении'}, длиннее — продолжение уйдёт следом.`
          : `${spec.title}: предел ${limit} символов.`) + viaLinks;
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

  /**
   * Куда уходит пост: площадка → одна или несколько раскладок → кадры.
   *
   * До 13.09.2026 раскладка у площадки была одна (выпадающий список), и
   * «Reels плюс сторис из того же ролика» собиралось двумя постами. Теперь
   * раскладки — переключатели: лента, Reels и сторис живут рядом, а раскладки
   * ленты взаимоисключающие — два одинаковых поста в одну ленту это ошибка,
   * а не замысел.
   */
  function sectionTargets() {
    const p = panel('Куда публикуем');
    const list = el('div', 'targets');
    const total = (post.media || []).filter((m) => !m.derived).length;

    for (const spec of specs) {
      const mine = post.targets.filter((t) => t.platform === spec.id);
      const on = mine.length > 0;
      const row = el('div', `target ${on ? 'target--on' : 'target--off'}`);

      const sw = el('label', 'switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = on;
      input.setAttribute('aria-label', `Публиковать в ${spec.title}`);
      const box = el('span', 'switch__box');
      box.innerHTML = iconMarkup('check', 12);
      sw.append(input, box);
      input.addEventListener('change', async () => {
        if (input.checked) {
          const target = { platform: spec.id, format_id: spec.formats[0].id, media_ids: null };
          post.targets.push(target);
          previewKey = keyOf(target);
        } else {
          // Вышедшие цели сервер всё равно сохранит — след публикации не стирается.
          post.targets = post.targets.filter((t) => t.platform !== spec.id || t.status === 'published' || t.status === 'removed');
        }
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

      // Переопределение текста. Нужно прежде всего Threads с его 500 знаками:
      // общий текст туда не влезает, а резать его во всех сетях — терять смысл.
      // Один текст на площадку: у сторис текста нет, а ленте и Reels одной
      // сети разные тексты нужны редко.
      const texted = mine.filter((t) => !formatOf(spec, t.format_id)?.noText);
      if (texted.length) {
        const hasOverride = texted.some((t) => t.text_override !== null && t.text_override !== undefined);
        const toggle = el('button', 'chip');
        toggle.type = 'button';
        toggle.setAttribute('aria-pressed', String(hasOverride));
        toggle.textContent = hasOverride ? 'Свой текст' : 'Свой текст…';
        toggle.title = 'Написать для этой площадки отдельный текст';
        toggle.addEventListener('click', async () => {
          for (const t of texted) t.text_override = hasOverride ? null : post.body || '';
          await save({ quiet: true });
          renderAll();
        });
        meta.append(toggle);
      }
      row.append(meta);

      if (on && spec.formats.length > 1) row.append(formatChips(spec, mine));

      const override = texted.find((t) => t.text_override !== null && t.text_override !== undefined);
      if (override) row.append(overrideBox(spec, texted, override.text_override));

      // Выбор кадров — когда есть из чего выбирать, или когда выбор уже
      // отсёк всё (кадр удалили): иначе цель молча осталась бы без медиа.
      for (const t of mine) {
        const ids = t.media_ids;
        const cut = Array.isArray(ids) && ids.length !== total;
        // У Reels из фото выбор кадров — это сам собранный ролик; полоса кадров
        // там только запутала бы.
        const builtReel = isReels(t) && mediaOf(t).some((m) => m.derived);
        const noOwnVideo = isReels(t) && !(post.media || []).some((m) => m.kind === 'video' && !m.derived);
        if ((total > 1 || cut) && !builtReel && !noOwnVideo) row.append(framesRow(spec, t));
      }

      if (spec.id === 'instagram' && on) row.append(...soundBlocks(mine));
      if (spec.id === 'telegram' && on) row.append(telegramOptions(mine[0]));
      if (spec.id === 'tiktok' && on) {
        for (const t of mine) {
          row.append(tiktokOptions({ post, target: t, media: mediaOf(t), onChange: () => save({ quiet: true }) }));
        }
      }

      list.append(row);
    }

    p.append(list);
    return p;
  }

  /**
   * Настройки Telegram: закреп, превью ссылки, кнопка под постом. У вышедшего
   * поста тоже правятся — применяет их «Обновить в канале» в «Где вышел».
   */
  function telegramOptions(target) {
    const wrap = el('div', 'target__extra tg-options');
    const options = () => target.options || {};

    const chips = el('div', 'chips chips--wrap');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Настройки Telegram');
    const toggle = (label, title, pressed, onClick) => {
      const chip = el('button', 'chip', label);
      chip.type = 'button';
      chip.title = title;
      chip.setAttribute('aria-pressed', String(pressed));
      chip.addEventListener('click', onClick);
      return chip;
    };
    const flip = (key) => async () => {
      target.options = { ...options(), [key]: !options()[key] };
      await save({ quiet: true });
      renderAll();
    };
    chips.append(
      toggle('Закрепить', 'Закрепить пост в канале, как только выйдет', Boolean(options().pin), flip('pin')),
      toggle('Без превью ссылки', 'Не показывать под текстом карточку сайта', Boolean(options().noPreview), flip('noPreview')),
      toggle('Кнопка-ссылка', 'Кнопка со ссылкой под постом', Boolean(options().button), async () => {
        const next = { ...options() };
        if (next.button) delete next.button;
        else next.button = { text: '', url: '' };
        target.options = next;
        await save({ quiet: true });
        renderAll();
      })
    );
    wrap.append(chips);

    const button = options().button;
    if (button) {
      const fields = el('div', 'tg-options__button');
      const input = (label, value, placeholder, key, extra = {}) => {
        const field = el('label', 'field');
        field.append(el('span', 'field__label', label));
        const node = el('input', 'input');
        node.value = value || '';
        node.placeholder = placeholder;
        Object.assign(node, extra);
        node.addEventListener('input', () => {
          target.options = { ...options(), button: { ...options().button, [key]: node.value } };
          autosave();
        });
        field.append(node);
        return field;
      };
      fields.append(
        input('Текст кнопки', button.text, 'Записатися', 'text', { maxLength: 64 }),
        input('Ссылка', button.url, 'https://mycomputer.education/…', 'url', { type: 'url', inputMode: 'url' })
      );
      wrap.append(fields);
      wrap.append(el('span', 'field__hint', 'Ссылка на наш сайт станет короткой и будет считать переходы. К альбому кнопку Telegram не ставит.'));
    }
    if (target.status === 'published') {
      wrap.append(el('span', 'field__hint', 'Пост уже вышел — изменения применит «Обновить в канале» в блоке «Где вышел».'));
    }
    return wrap;
  }

  function isReels(target) {
    return target?.platform === 'instagram' && target.format_id === 'reels';
  }

  /**
   * Звук у Instagram. Прикрепить его площадка даёт только к Reels, поэтому:
   * у Reels — сборка ролика из фото (если своего ролика нет) и выбор звука;
   * у ленты с одним роликом — выбор звука (он и так уходит Reels); у фотопоста —
   * подсказка, как получить звук, одной кнопкой.
   */
  function soundBlocks(mine) {
    const blocks = [];
    const live = (key) => post.targets.find((x) => keyOf(x) === key);

    for (const t of mine) {
      const format = formatOf(specs.find((s) => s.id === 'instagram'), t.format_id);
      if (format?.role === 'story') continue;
      const key = keyOf(t);
      const media = mediaOf(t);
      const video = media.length === 1 && media[0].kind === 'video' ? media[0] : null;
      const locked = t.status === 'published';

      if (isReels(t) && !locked && (media.some((m) => m.derived) || (!video && reelPhotos(post).length))) {
        const wrap = el('div', 'target__extra');
        wrap.append(
          reelBuilder({
            post,
            target: t,
            onBuilt: (next) => {
              post = next;
              previewKey = key;
              renderAll();
            },
          })
        );
        blocks.push(wrap);
      }

      // Звук показываем там, где он возможен, и там, где он уже выбран (иначе
      // его нечем было бы убрать с поста, ставшего каруселью).
      if (!video && !isReels(t) && !t.audio) continue;
      if (locked && !t.audio) continue;

      const wrap = el('div', 'target__extra');
      wrap.append(el('span', 'field__label', isReels(t) ? 'Звук Reels' : 'Звук ролика'));
      wrap.append(
        audioField({
          projectId: post.project_id,
          audio: t.audio,
          reel: video
            ? { kind: video.derived ? 'render' : 'video' }
            : {
                kind: null,
                why: isReels(t)
                  ? 'Сначала нужен ролик: загрузите видео или соберите его из фото выше.'
                  : 'Пост уйдёт фото или каруселью — к ним Instagram звук не прикрепляет. Нужен один ролик.',
              },
          onChange: async (next, { commit }) => {
            const target = live(key);
            if (!target) return;
            target.audio = next;
            if (!commit) return autosave();
            await save({ quiet: true });
            renderAll();
          },
        })
      );
      blocks.push(wrap);
    }

    // Фотопост без Reels: звук возможен, но человек об этом не догадается.
    const hasReels = mine.some(isReels);
    if (!hasReels && reelPhotos(post).length && !mine.some((t) => mediaOf(t).some((m) => m.kind === 'video'))) {
      const hint = el('div', 'target__extra sound__offer');
      hint.append(
        el('span', 'field__hint', 'К фото и каруселям Instagram музыку через API не прикрепляет. Добавьте Reels — панель соберёт ролик из этих фото.')
      );
      hint.append(
        button('Reels со звуком', {
          variant: 'quiet',
          iconName: 'music',
          onClick: async () => {
            const fresh = { platform: 'instagram', format_id: 'reels', media_ids: null, text_override: null };
            post.targets.push(fresh);
            previewKey = keyOf(fresh);
            await save({ quiet: true });
            renderAll();
          },
        })
      );
      blocks.push(hint);
    }
    return blocks;
  }

  function formatChips(spec, mine) {
    const wrap = el('div', 'target__extra');
    const chips = el('div', 'chips chips--wrap');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', `Раскладки ${spec.title}`);

    for (const f of spec.formats) {
      const target = mine.find((t) => t.format_id === f.id);
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(Boolean(target)));
      // Без размеров: они есть в «Ограничениях площадки», а здесь режутся на телефоне
      chip.textContent = f.title;
      const published = target?.status === 'published';
      if (published) {
        chip.disabled = true;
        chip.title = 'Уже опубликовано — раскладку не снять';
      } else if (target && mine.length === 1) {
        chip.title = 'Единственная раскладка — чтобы не публиковать сюда вовсе, снимите галочку площадки';
      }
      chip.addEventListener('click', async () => {
        if (target) {
          if (mine.length === 1) return;
          post.targets = post.targets.filter((t) => t !== target);
        } else {
          // Две раскладки ленты у одной площадки — это два одинаковых поста в
          // одну ленту. Выбор второй заменяет первую, а не добавляется к ней.
          const sameFeed =
            f.role === 'feed' && mine.find((t) => formatOf(spec, t.format_id)?.role === 'feed' && t.status !== 'published');
          if (sameFeed) {
            sameFeed.format_id = f.id;
            previewKey = keyOf(sameFeed);
          } else {
            const donor = mine.find((t) => t.text_override !== null && t.text_override !== undefined);
            const fresh = {
              platform: spec.id,
              format_id: f.id,
              media_ids: null,
              text_override: f.noText ? null : donor?.text_override ?? null,
            };
            post.targets.push(fresh);
            previewKey = keyOf(fresh);
          }
        }
        await save({ quiet: true });
        renderAll();
      });
      chips.append(chip);
    }
    wrap.append(chips);
    return wrap;
  }

  function overrideBox(spec, targets, value) {
    const box = el('div', 'override target__extra');
    const head = el('div', 'override__head');
    head.append(el('span', 'field__label', `Текст только для ${spec.title}`));
    const counter = el('span', 'counter');
    head.append(counter);
    box.append(head);

    const area = el('textarea', 'textarea');
    area.value = value || '';
    const limit = mediaOf(targets[0]).length ? spec.text.limitWithMedia : spec.text.limit;
    // Тот же счёт, что у общего счётчика: с подписью и короткими ссылками.
    const refresh = () => {
      const length = sentText(targets[0]).length;
      const over = length > limit;
      counter.textContent = `${length}/${limit}`;
      counter.className = `counter${over ? (spec.text.splits ? ' counter--warn' : ' counter--over') : ''}`;
      counter.title = 'С подписью проекта и нашими ссылками, ставшими короткими';
    };
    refresh();
    area.addEventListener('input', () => {
      for (const t of targets) t.text_override = area.value;
      refresh();
      autosave();
    });
    head.append(emojiButton(area));
    box.append(area);
    return box;
  }

  /**
   * Какие кадры уходят в эту цель. «Все» — и те, что загрузят потом; отмеченные
   * — только они, в порядке кадров поста (порядок меняется в «Медиа»).
   */
  function framesRow(spec, target) {
    const format = formatOf(spec, target.format_id);
    // Ролик, собранный из фото, выбирается только у Reels Instagram.
    const all = (post.media || []).filter((m) => !m.derived || isReels(target));
    const ids = Array.isArray(target.media_ids) ? target.media_ids.map(Number) : null;
    const chosen = ids ? all.filter((m) => ids.includes(Number(m.id))).length : all.length;
    const locked = target.status === 'published';

    const wrap = el('div', 'frames target__extra');
    const head = el('div', 'frames__head');
    head.append(el('span', 'frames__title', format?.title || target.format_id));
    head.append(
      el('span', 'frames__count', ids ? `кадров ${chosen} из ${all.length}` : `все кадры · ${all.length}`)
    );
    if (format?.series && chosen > 1) head.append(el('span', 'frames__hint', 'каждый — отдельная сторис'));

    const allChip = el('button', 'chip');
    allChip.type = 'button';
    allChip.textContent = 'Все';
    allChip.setAttribute('aria-pressed', String(!ids));
    allChip.disabled = locked || !ids;
    allChip.title = 'Все кадры поста, включая загруженные позже';
    allChip.addEventListener('click', async () => {
      target.media_ids = null;
      await save({ quiet: true });
      renderAll();
    });
    head.append(allChip);
    wrap.append(head);

    const strip = el('div', 'frames__list');
    all.forEach((m, i) => {
      const on = !ids || ids.includes(Number(m.id));
      const cell = el('button', 'frames__cell');
      cell.type = 'button';
      cell.disabled = locked;
      cell.setAttribute('aria-pressed', String(on));
      cell.setAttribute('aria-label', `Кадр ${i + 1}: ${m.original_name}`);
      cell.title = `${i + 1}. ${m.original_name}`;
      const src = m.thumbUrl || (m.kind === 'image' ? m.url : null);
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        cell.append(img);
      } else {
        cell.append(icon(m.kind === 'video' ? 'video' : 'image', { size: 16 }));
      }
      cell.append(el('span', 'frames__num', String(i + 1)));
      const tick = el('span', 'frames__tick');
      tick.innerHTML = iconMarkup('check', 10);
      cell.append(tick);
      cell.addEventListener('click', async () => {
        const current = ids ? new Set(ids) : new Set(all.map((x) => Number(x.id)));
        if (current.has(Number(m.id))) current.delete(Number(m.id));
        else current.add(Number(m.id));
        // Отметили все — это снова «все кадры»: так новые загрузки не выпадут.
        target.media_ids = current.size === all.length ? null : [...current];
        previewKey = keyOf(target);
        await save({ quiet: true });
        renderAll();
      });
      strip.append(cell);
    });
    wrap.append(strip);
    return wrap;
  }

  /** Что именно не ушло — в самом посте, а не только в общем журнале. */
  function sectionFailures() {
    const failed = (post.targets || []).filter((t) => (t.status === 'failed' || t.status === 'needs_check') && t.error);
    if (!failed.length) return null;
    const p = panel('Не ушло');
    const isOwner = ctx.state.user.role === 'owner';
    for (const t of failed) {
      const unknown = t.status === 'needs_check';
      const n = note(unknown ? 'warn' : 'danger', labelOf(t), unknown ? t.error : `${t.error} · попыток: ${t.attempts}`);
      // Судьбу знает только тот, кто посмотрел в канал: панель сама не повторит,
      // иначе при вышедшем посте подписчики получат дубль.
      if (unknown && isOwner) {
        const row = el('div', 'counters');
        row.append(
          button('Пост там есть', {
            variant: 'quiet',
            iconName: 'check',
            onClick: () => resolveTarget(t, 'published', 'Отмечен вышедшим'),
          }),
          button('Поста нет — отправить заново', {
            variant: 'quiet',
            iconName: 'refresh',
            onClick: () => {
              if (!confirm(`Точно проверили ${labelOf(t)}? Если пост там всё-таки есть, выйдет дубль.`)) return;
              resolveTarget(t, 'retry', 'Поставлен на повтор — уйдёт в ближайшую минуту');
            },
          })
        );
        n.querySelector('.note__body').append(row);
      }
      p.append(n);
    }
    return p;
  }

  async function resolveTarget(target, outcome, done) {
    try {
      post = (await api.resolveTarget(post.id, target.id, outcome)).post;
      toast(done, 'ok');
      renderTopbar();
      renderAll();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /**
   * Где пост вышел и как его оттуда снять. Удаление поста в панели сети не
   * трогает — снимать приходится отсюда, по одной площадке.
   */
  function sectionLive() {
    const live = (post.targets || []).filter((t) => t.status === 'published' || t.status === 'removed');
    if (!live.length) return null;
    const isOwner = ctx.state.user.role === 'owner';
    const p = panel('Где вышел');
    for (const t of live) {
      const row = el('div', 'counters');
      const name = el('span', 'target__name');
      name.innerHTML = iconMarkup(t.platform, 14);
      name.append(el('span', null, labelOf(t)));
      row.append(name);

      if (t.status === 'removed') {
        row.append(el('span', 'counter', 'снят из сети'));
      } else {
        if (t.external_url) {
          const link = el('a', 'btn btn--quiet btn--sm', 'открыть');
          link.href = t.external_url;
          link.target = '_blank';
          link.rel = 'noopener';
          row.append(link);
        }
        // Правка вышедшего: панель шлёт то, что в посте сейчас, — текст с
        // подписью, кнопку, превью, закреп. Медиа у вышедшего не меняются.
        const spec = specs.find((s) => s.id === t.platform);
        if (isOwner && spec?.editable && t.external_id) {
          row.append(
            button('Обновить в канале', {
              variant: 'quiet',
              iconName: 'refresh',
              onClick: async () => {
                if (!(await save({ quiet: true }))) return;
                if (!confirm(`Заменить текст и настройки поста в ${labelOf(t)} на те, что сейчас в панели?`)) return;
                try {
                  const res = await api.editTarget(post.id, t.id);
                  post = res.post;
                  toast(res.warning ? `Обновлён, но: ${res.warning}` : `Обновлён в ${labelOf(t)}`, res.warning ? 'warn' : 'ok');
                  renderAll();
                } catch (err) {
                  toast(err.message, 'danger');
                }
              },
            })
          );
        }
        // Отмеченный вышедшим вручную пост без id площадки: снимать нечем.
        const removable = Boolean(t.external_id) || (t.parts || []).length > 0;
        if (isOwner && !removable) {
          row.append(el('span', 'field__hint', 'id поста у панели нет — снять только руками'));
        } else if (isOwner) {
          row.append(
            button('Снять из сети', {
              variant: 'quiet',
              iconName: 'trash',
              onClick: async () => {
                if (!confirm(`Снять пост из ${labelOf(t)}? Вернуть его не получится — только опубликовать заново.`)) return;
                try {
                  post = (await api.unpublishTarget(post.id, t.id)).post;
                  toast(`Снят из ${labelOf(t)}`, 'ok');
                  renderTopbar();
                  renderAll();
                } catch (err) {
                  toast(err.message, 'danger');
                }
              },
            })
          );
        }
      }
      p.append(row);
    }
    return p;
  }

  /** «Instagram · Stories» — у площадки может быть несколько целей, и «Instagram» не говорит, какая. */
  function labelOf(target) {
    const spec = specs.find((s) => s.id === target.platform);
    if (!spec) return target.platform;
    const format = formatOf(spec, target.format_id);
    return spec.formats.length > 1 && format ? `${spec.title} · ${format.title}` : spec.title;
  }

  /** Кадры цели — та же выборка, что у проверки и очереди (validate.js → mediaFor). */
  function mediaOf(target) {
    const all = post.media || [];
    const ids = target?.media_ids;
    // Ролик, собранный из фото, — кадр только той цели, что выбрала его явно.
    if (!Array.isArray(ids)) return all.filter((m) => !m.derived);
    const wanted = new Set(ids.map(Number));
    return all.filter((m) => wanted.has(Number(m.id)));
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

    // Полоса прогресса живёт в самой зоне: загрузка ролика идёт минутами, и
    // без неё человек перезагружает страницу посреди отправки.
    const progress = el('div', 'upload-progress');
    progress.id = 'upload-progress';
    progress.hidden = true;
    // Общая полоса `.meter`: доля через transform, без дёрганья раскладки.
    const bar = el('div', 'meter');
    bar.append(el('div', 'meter__fill'));
    progress.append(bar, el('span', 'upload-progress__text'));
    zone.append(progress);

    p.append(zone, input);
    p.append(
      el(
        'span',
        'field__hint',
        'Видео — MP4 (H.264, звук AAC), 1080×1920 для сторис и Reels. Сторис — до 60 с, Reels Facebook — до 90 с.'
      )
    );

    if ((post.media || []).length) {
      const list = el('div', 'media');
      const count = post.media.length;
      for (const [index, m] of post.media.entries()) {
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
        // Короткими строками: карточка в 108 px, и «30 к/с» не должно рваться.
        const meta = el('div', 'media__meta');
        for (const line of passportLines(m)) meta.append(el('span', null, line));
        item.append(meta);

        // Порядок кадров — это порядок серии сторис и листания карусели.
        if (count > 1) {
          const foot = el('div', 'media__foot');
          foot.append(el('span', 'media__num', String(index + 1)));
          const back = iconButton('chevronLeft', { title: 'Раньше', onClick: () => move(index, -1) });
          const next = iconButton('chevronRight', { title: 'Позже', onClick: () => move(index, 1) });
          back.classList.add('media__move');
          next.classList.add('media__move');
          back.disabled = index === 0;
          next.disabled = index === count - 1;
          foot.append(back, next);
          item.append(foot);
        }
        list.append(item);
      }
      p.append(list);
    }

    return p;
  }

  /**
   * Паспорт кадра: размеры, вес, у ролика — длительность, кодек и частота
   * кадров. Ровно то, по чему площадка примет или отвергнет файл.
   */
  function passportLines(m) {
    const size = m.width && m.height ? `${m.width}×${m.height}` : m.kind === 'video' ? 'размер ?' : m.kind;
    if (m.kind !== 'video') return [size, humanBytes(m.bytes)];
    let length = 'длина ?';
    if (m.duration) {
      const s = Math.round(m.duration);
      length = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    const codecs = { h264: 'H.264', hevc: 'HEVC', prores: 'ProRes', vp9: 'VP9', av1: 'AV1' };
    const tech = [m.video_codec ? codecs[m.video_codec] || m.video_codec.toUpperCase() : 'кодек ?'];
    if (m.fps) tech.push(`${Math.round(m.fps)} к/с`);
    return [size, `${length} · ${humanBytes(m.bytes)}`, tech.join(' · ')];
  }

  async function move(index, delta) {
    const ids = post.media.map((m) => m.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    try {
      post = (await api.reorderMedia(post.id, ids)).post;
      renderAll();
    } catch (err) {
      toast(err.message, 'danger');
      reload();
    }
  }

  async function upload(files) {
    if (!files.length) return;
    files = [...files];
    ctx.setSaveState('готовлю миниатюры…');
    // Миниатюры — до загрузки и все разом: каждая занимает миллисекунды для
    // картинки и до пары секунд для видео. Не получилась — файл уйдёт без неё.
    const thumbs = await Promise.all(files.map((f) => makeThumb(f)));
    ctx.setSaveState('загружаю файлы…');
    const box = root.querySelector('#upload-progress');
    const fill = box?.querySelector('.meter__fill');
    const label = box?.querySelector('.upload-progress__text');
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const show = (sent, total) => {
      if (!box) return;
      box.hidden = false;
      const share = total ? Math.min(1, sent / total) : 0;
      fill.style.setProperty('--value', String(share));
      // Размер берём у файлов: `total` от браузера включает обёртку формы.
      const sentBytes = Math.round(totalBytes * share);
      label.textContent =
        share >= 1
          ? 'Файлы на сервере, читаю паспорт…'
          : sentBytes
          ? `${Math.round(share * 100)}% · ${humanBytes(sentBytes)} из ${humanBytes(totalBytes)}`
          : `Начинаю загрузку · ${humanBytes(totalBytes)}`;
    };
    show(0, 1);
    try {
      const data = await api.uploadMedia(post.id, files, thumbs, show);
      post = data.post;
      ctx.setSaveState('загружено');
      renderAll();
    } catch (err) {
      if (box) box.hidden = true;
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
        status: post.status,
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
      host.append(note('danger', b.label || titleOf(b.platform), b.message));
    }
    for (const w of v.warnings) {
      host.append(note('warn', w.label || titleOf(w.platform), w.message));
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
        previewFrame = 0;
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
    const activeTarget = post.targets.find((t) => keyOf(t) === previewKey);
    // Превью показывает кадры именно этой цели: у сторис они могут быть
    // совсем другими, чем у ленты того же поста.
    const frames = mediaOf(activeTarget);
    previewFrame = Math.min(previewFrame, Math.max(0, frames.length - 1));
    const media = frames[previewFrame];
    const text = format.noText ? '' : finalText(activeTarget);

    // Telegram кадр не режет, а пост бывает несколькими сообщениями с кнопкой
    // под последним — рамка телефона с обрезкой здесь показала бы неправду.
    if (platformId === 'telegram') {
      const tgStage = el('div', 'preview__stage');
      tgStage.append(telegramPreview(activeTarget, frames));
      right.append(tgStage, limitsPanel(spec, format));
      return;
    }

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
    }
    // Ролик из фото уже кадрирован при сборке — фокус задаётся у самих фото.
    if (media && !media.purged && !media.derived) {
      const node = crop.querySelector('.frame__media');

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
    }
    if (!media) {
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
    // Звук — строкой под роликом, как в самом Instagram: видно, с чем выйдет пост.
    if (activeTarget?.audio?.id && platformId === 'instagram') {
      const a = activeTarget.audio;
      const line = el('div', `frame__sound${a.missing ? ' frame__sound--missing' : ''}`);
      line.append(icon('music', { size: 13 }));
      const who = a.artist || (a.username ? `@${a.username}` : '');
      line.append(el('span', null, `${a.title || 'звук'}${who ? ` · ${who}` : ''}${a.missing ? ' — пропал из библиотеки' : ''}`));
      frame.append(line);
    }
    if (text) {
      frame.append(el('div', 'frame__caption', text.slice(0, 240) + (text.length > 240 ? '…' : '')));
    } else if (format.noText && media) {
      frame.append(el('div', 'frame__caption frame__caption--muted', 'Сторис уходит без текста и подписи'));
    }
    stage.append(frame);
    right.append(stage);

    if (frames.length > 1) {
      const pager = el('div', 'preview__pager');
      const back = iconButton('chevronLeft', {
        title: 'Предыдущий кадр',
        onClick: () => {
          previewFrame -= 1;
          renderPreview();
        },
      });
      const next = iconButton('chevronRight', {
        title: 'Следующий кадр',
        onClick: () => {
          previewFrame += 1;
          renderPreview();
        },
      });
      back.disabled = previewFrame === 0;
      next.disabled = previewFrame === frames.length - 1;
      const what = format.series ? 'сторис' : 'кадр';
      pager.append(back, el('span', 'preview__pager-label', `${what} ${previewFrame + 1} из ${frames.length}`), next);
      right.append(pager);
    }

    right.append(limitsPanel(spec, format));
  }

  /**
   * Лента канала Telegram так, как её увидит подписчик: сообщения разрезаны
   * тем же splitText, что и при отправке, файлы — у первого, кнопка — под
   * последним, карточка ссылки — если превью не выключено, плашка закрепа.
   */
  function telegramPreview(target, frames) {
    const options = target?.options || {};
    const written = finalText(target).trim();
    const sent = sentText(target).trim();
    const hasMedia = frames.length > 0;
    const parts = splitText(sent, hasMedia ? CAPTION_LIMIT : TEXT_LIMIT);
    const button = options.button;
    const album = frames.length > 1;

    const phone = el('div', 'tgp');
    const project = ctx.state.projects.find((pr) => pr.id === post.project_id);
    const head = el('div', 'tgp__head');
    head.innerHTML = iconMarkup('telegram', 14);
    head.append(el('span', null, project ? project.title : 'Канал'));
    phone.append(head);

    if (options.pin) {
      const pinned = el('div', 'tgp__pinned');
      pinned.append(el('span', 'tgp__pinned-title', 'Закреплено'));
      const firstLine = (parts[0] || (hasMedia ? 'Фото' : '')).split('\n')[0].replace(/\/r\/x{7}/g, '/r/…');
      pinned.append(el('span', 'tgp__pinned-text', firstLine));
      phone.append(pinned);
    }

    const feed = el('div', 'tgp__feed');
    const count = Math.max(parts.length, 1);
    for (let i = 0; i < count; i++) {
      const msg = el('div', 'tgp__msg');
      if (i === 0 && hasMedia) msg.append(album ? telegramAlbum(frames) : telegramMedia(frames[0], 'tgp__single'));
      const part = parts[i];
      if (part) msg.append(telegramText(part));
      // Карточку ссылки Telegram рисует только у текстового сообщения.
      const isText = !(i === 0 && hasMedia);
      const link = isText && !options.noPreview ? firstOwnLink(written, part) : null;
      if (link) msg.append(el('div', 'tgp__card', `${link} · превью сайта`));
      if (count > 1) msg.append(el('div', 'tgp__meta', `сообщение ${i + 1} из ${count}`));
      if (!part && !(i === 0 && hasMedia)) msg.append(el('div', 'tgp__text tgp__text--muted', 'Пусто — ни текста, ни файла'));
      feed.append(msg);
    }

    if (button) {
      const lastIsAlbumOnly = album && parts.length <= 1;
      if (lastIsAlbumOnly) {
        feed.append(el('div', 'tgp__issue', 'К альбому Telegram кнопку не ставит — пост не пройдёт проверку'));
      } else {
        const b = el('div', 'tgp__button');
        b.append(el('span', null, button.text || 'Текст кнопки'));
        b.append(icon('link', { size: 12 }));
        b.title = button.url || 'ссылка не указана';
        feed.append(b);
      }
    }
    phone.append(feed);
    return phone;
  }

  function telegramMedia(media, cls) {
    if (!media || (media.purged && !media.thumbUrl)) {
      const holder = el('div', `${cls} tgp__placeholder`);
      holder.append(icon(media?.kind === 'video' ? 'video' : 'image', { size: 22 }));
      return holder;
    }
    const video = media.kind === 'video' && !media.purged;
    const node = el(video ? 'video' : 'img', cls);
    node.src = media.purged ? media.thumbUrl : media.url;
    if (video) Object.assign(node, { muted: true, loop: true, autoplay: true, playsInline: true });
    else node.alt = '';
    // Telegram кадр не режет — показываем его пропорции, а не раскладки.
    if (media.width && media.height) node.style.aspectRatio = `${media.width} / ${media.height}`;
    return node;
  }

  function telegramAlbum(frames) {
    const grid = el('div', 'tgp__album');
    for (const m of frames.slice(0, 10)) grid.append(telegramMedia(m, 'tgp__cell'));
    return grid;
  }

  /** Текст сообщения: ссылки подсвечены, код короткой ссылки не выдумываем. */
  function telegramText(part) {
    const box = el('div', 'tgp__text');
    const re = /https?:\/\/[^\s<>"')]+/g;
    let last = 0;
    for (const m of part.matchAll(re)) {
      if (m.index > last) box.append(document.createTextNode(part.slice(last, m.index)));
      box.append(el('span', 'tgp__url', m[0].replace(/\/r\/x{7}/, '/r/…')));
      box.lastChild.title = /\/r\/x{7}/.test(m[0]) ? 'Короткая ссылка со счётчиком переходов — код появится при отправке' : m[0];
      last = m.index + m[0].length;
    }
    if (last < part.length) box.append(document.createTextNode(part.slice(last)));
    return box;
  }

  /**
   * Чей сайт Telegram покажет карточкой. Короткая ссылка ведёт редиректом на
   * наш сайт — карточка будет его, поэтому берём адрес из набранного текста.
   */
  function firstOwnLink(written, part) {
    const found = (part || '').match(/https?:\/\/[^\s<>"')]+/);
    if (!found) return null;
    const shortened = /\/r\/x{7}/.test(found[0]);
    const source = shortened ? written.match(/https?:\/\/[^\s<>"')]+/)?.[0] : found[0];
    try {
      return new URL(source).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  function limitsPanel(spec, format) {
    const p = panel(`Ограничения · ${format.title}`);
    const list = el('div', 'limits');
    const target = post.targets.find((t) => keyOf(t) === previewKey);
    const hasMedia = mediaOf(target).length > 0;
    // Лимиты раскладки, уже сведённые с площадкой на сервере (mediaRulesFor).
    const rules = format.media || spec.media;
    const mb = (bytes) => (bytes >= 1024 * 1024 * 1024 ? `${bytes / 1024 / 1024 / 1024} ГБ` : `${Math.round(bytes / 1024 / 1024)} МБ`);
    const kinds = rules.kinds || ['image', 'video'];

    addLimit(list, 'Кадр', `${format.w}×${format.h}`);
    const textLimit = hasMedia ? spec.text.limitWithMedia : spec.text.limit;
    addLimit(
      list,
      'Текст',
      format.noText ? 'не уходит' : spec.text.splits ? `${textLimit} в сообщении, дальше — следом` : `до ${textLimit} знаков`
    );
    if (kinds.includes('image')) {
      const img = [rules.image.types.map((t) => t.toUpperCase()).join(', ')];
      if (rules.image.maxBytes) img.push(`до ${mb(rules.image.maxBytes)}`);
      if (rules.image.aspectMin) img.push(`от 4:5 до 1.91:1`);
      addLimit(list, 'Картинки', img.join(' · '));
    } else {
      addLimit(list, 'Картинки', 'не принимает');
    }
    const v = rules.video;
    const sec = (s) => (s >= 60 && s % 60 === 0 ? `${s / 60} мин` : `${s} с`);
    const length =
      v.minSeconds && v.maxSeconds
        ? `${sec(v.minSeconds)} – ${sec(v.maxSeconds)}`
        : v.maxSeconds
        ? `до ${sec(v.maxSeconds)}`
        : 'без предела длины';
    const vid = [length];
    if (v.maxBytes) vid.push(`до ${mb(v.maxBytes)}`);
    if (v.codecs) vid.push(v.codecs.map((c) => ({ h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' })[c] || c).join('/'));
    addLimit(list, 'Видео', vid.join(' · '));
    addLimit(
      list,
      format.series ? 'Кадров в серии' : 'Файлов за раз',
      format.series ? `до ${rules.groupMax}, каждый — отдельная сторис` : String(rules.groupMax)
    );
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

/** Раскладка площадки по id; неизвестная — первая, как на сервере (specs.js → formatOf). */
function formatOf(spec, formatId) {
  return spec?.formats.find((f) => f.id === formatId) || spec?.formats[0] || null;
}
