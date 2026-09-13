/**
 * Тренды — сырьё для контент-плана.
 *
 * Честно про источники: публичного API трендов нет ни у Instagram, ни у
 * Facebook, ни у TikTok. Что реально собирается машиной — Google Trends,
 * «в тренде» у YouTube и наша собственная статистика по вышедшим постам.
 * Остальное попадает сюда разбором вручную: экран и сделан так, чтобы
 * занесённый сигнал сразу превращался в идею плана.
 *
 * У каждого тренда есть срок. Протухший опаснее отсутствующего: по нему
 * делают контент, который выглядит вчерашним, — поэтому такие помечены.
 */

import { api } from '../api.js';
import { icon, iconMarkup } from '../icons.js';
import { el, button, iconButton, panel, note, empty, toast, skeleton, projectTabs } from '../ui.js';
import { trackLine } from '../audio.js';

export function trendsView(ctx) {
  const root = el('div', 'view');
  let trends = [];
  let sources = [];
  const isOwner = ctx.state.user.role === 'owner';

  ctx.setTopbar({
    title: 'Тренды',
    subtitle: 'Сигналы, из которых делаем план',
    actions: isOwner
      ? [
          button('Звуки в тренде', { iconName: 'music', onClick: collectSounds }),
          button('Собрать сейчас', { iconName: 'refresh', onClick: collectNow }),
          button('Добавить тренд', { variant: 'primary', iconName: 'plus', onClick: () => openForm() }),
        ]
      : [],
  });

  let scope = ctx.state.projectId;
  const tabs = el('div');
  root.append(tabs);
  renderTabs();

  const host = el('div', 'stack');
  root.append(host);

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
  loading.append(skeleton(70), skeleton(70));
  host.append(loading);

  load();
  return root;

  async function load() {
    try {
      const data = await api.trends(scope === 'all' ? 'all' : undefined);
      trends = data.trends;
      sources = data.sources;
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    render();
  }

  function render() {
    host.textContent = '';

    host.append(
      note(
        'info',
        'Откуда берутся сигналы',
        'Автоматически собираются Google Trends, «в тренде» у YouTube, наша статистика по вышедшим постам и звуки в тренде Reels Instagram. Остального у Instagram, у Facebook и TikTok публичного API трендов нет — туда сигнал заносится разбором.'
      )
    );

    if (isOwner && scope !== 'all') host.append(watchPanel());
    host.append(digestPanel());

    if (!trends.length) {
      // Без второй кнопки: «Добавить тренд» уже стоит в шапке, и две
      // одинаковые кнопки на пустом экране заставляют выбирать на ровном месте.
      const box = el('section', 'panel');
      box.append(
        empty(
          'trend',
          'Трендов пока нет',
          isOwner
            ? 'Занесите сигнал кнопкой в шапке или дождитесь автосбора. Из тренда идея плана делается одним нажатием.'
            : 'Сигналы заносит владелец. Как появятся — из них можно будет сделать идеи плана.'
        )
      );
      host.append(box);
      return;
    }

    const live = trends.filter((t) => !t.stale);
    const stale = trends.filter((t) => t.stale);

    if (live.length) host.append(group('Свежие', live));
    if (stale.length) host.append(group('Протухшие — брать не стоит', stale));
  }

  /**
   * Фразы, за которыми следим. Тренд здесь считается из разницы: важно не
   * «сколько постов сегодня», а во сколько раз больше, чем неделю назад.
   */
  function watchPanel() {
    const p = panel('Наблюдение за темами');
    const body = el('div', 'stack');
    p.append(body);
    body.append(el('span', 'field__hint', 'загружаю…'));

    api
      .keywords()
      .then(({ keywords }) => {
        body.textContent = '';
        body.append(
          el(
            'span',
            'field__hint',
            'Раз в сутки панель считает, сколько постов в Threads по каждой фразе. Заметный рост сам становится сигналом выше.'
          )
        );

        if (keywords.length) {
          const list = el('div', 'plat-picker');
          for (const k of keywords) {
            const chip = el('span', 'slot');
            chip.append(el('b', null, k.phrase));
            const last = k.history[k.history.length - 1];
            if (last) {
              chip.append(el('span', 'dim small', `${last.found} постов`));
            }
            if (k.growth?.factor && k.growth.factor >= 2) {
              chip.append(el('span', 'tag tag--gold', `×${k.growth.factor.toFixed(1)}`));
            }
            const del = el('button', 'slot__x');
            del.type = 'button';
            del.title = 'Перестать следить';
            del.innerHTML = iconMarkup('x', 11);
            del.addEventListener('click', async () => {
              await api.removeKeyword(k.id);
              load();
            });
            chip.append(del);
            list.append(chip);
          }
          body.append(list);
        } else {
          body.append(
            note(
              'info',
              'Фразы не заданы',
              'Добавьте то, что ищут ваши родители: «курси програмування для дітей», «англійська для дитини Дніпро».'
            )
          );
        }

        const form = el('form', 'target__meta');
        form.style.justifyContent = 'flex-start';
        const input = el('input', 'input');
        input.placeholder = 'Фраза для наблюдения';
        input.style.maxWidth = '320px';
        const add = button('Следить', { iconName: 'plus' });
        add.type = 'submit';
        form.append(input, add);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await api.addKeyword(input.value);
            input.value = '';
            load();
          } catch (err) {
            toast(err.message, 'danger');
          }
        });
        body.append(form);
      })
      .catch((err) => {
        body.textContent = '';
        body.append(note('danger', 'Фразы не прочитались', err.message));
      });

    return p;
  }

  /**
   * Что заходит у других. Цифры приходят из браузера СММщика — официальный
   * поиск Threads вовлечённости не отдаёт.
   */
  function digestPanel() {
    const p = panel('Что заходит у других');
    const body = el('div', 'stack');
    p.append(body);
    body.append(el('span', 'field__hint', 'считаю…'));

    api
      .digest(7)
      .then((d) => {
        body.textContent = '';
        if (!d.total) {
          body.append(
            note(
              'info',
              'Данных из ленты пока нет',
              'Поставьте расширение из папки extension и полистайте Threads — панель соберёт реакции постов, мимо которых вы прошли.'
            )
          );
          return;
        }

        const counters = el('div', 'counters');
        counters.append(el('span', 'counter', `постов за неделю: ${d.total}`));
        counters.append(el('span', 'counter', `из них взлетело: ${d.hot}`));
        body.append(counters);

        if (d.byMedia.length) {
          const box = el('div', 'limits');
          for (const g of d.byMedia) {
            const row = el('div', 'limit');
            row.append(el('span', 'limit__key', `${mediaTitle(g.key)} · ${g.posts} постов`));
            row.append(el('span', 'limit__val', `${g.median} баллов в час`));
            box.append(row);
          }
          body.append(el('div', 'eyebrow', 'Какой формат заходит'), box);
        }

        if (d.byHour.length) {
          const hours = el('div', 'plat-picker');
          for (const g of d.byHour) {
            const chip = el('span', 'slot');
            chip.append(el('b', null, `${String(g.key).padStart(2, '0')}:00`));
            chip.append(el('span', 'dim small', `${g.median}`));
            hours.append(chip);
          }
          body.append(el('div', 'eyebrow', 'В какие часы выходят удачные'), hours);
        }

        if (d.words.length) {
          const words = el('div', 'plat-picker');
          for (const w of d.words.slice(0, 10)) {
            const chip = el('span', 'slot');
            chip.append(el('b', null, w.word));
            chip.append(el('span', 'dim small', String(w.posts)));
            words.append(chip);
          }
          body.append(el('div', 'eyebrow', 'Слова у взлетевших постов'), words);
        }

        if (d.top.length) {
          body.append(el('div', 'eyebrow', 'Лучшие посты недели'));
          const list = el('div', 'stack');
          for (const t of d.top.slice(0, 6)) list.append(observedCard(t));
          body.append(list);
        }
      })
      .catch((err) => {
        body.textContent = '';
        body.append(note('danger', 'Выводы не собрались', err.message));
      });

    return p;
  }

  function observedCard(t) {
    const box = el('article', 'idea');
    const top = el('div', 'idea__top');
    top.append(el('span', `tag ${t.label === 'hot' ? 'tag--gold' : ''}`, t.label === 'hot' ? 'зашёл' : 'обычный'));
    top.append(el('span', 'idea__date', `${t.perHour} б/ч · ${t.ageHours} ч`));
    if (t.username) top.append(el('span', 'dim small', `@${t.username}`));
    box.append(top);
    box.append(el('p', 'idea__text', t.text || '—'));

    const foot = el('div', 'idea__foot');
    foot.append(el('span', 'dim small', `${t.likes} лайков · ${t.comments} ответов · ${t.reposts} репостов`));
    if (t.permalink) {
      const link = el('a', 'btn btn--sm');
      link.href = t.permalink;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Открыть';
      foot.append(el('span', 'spacer'), link);
    }
    box.append(foot);
    return box;
  }

  function mediaTitle(key) {
    return { VIDEO: 'Видео', IMAGE: 'Картинка', TEXT: 'Только текст', CAROUSEL: 'Карусель' }[key] || key;
  }

  async function collectSounds() {
    if (scope === 'all') {
      toast('Выберите школу: звуки берутся из её Instagram', 'danger');
      return;
    }
    toast('Спрашиваю у Instagram, что в тренде…');
    try {
      const r = await api.collectSounds();
      const failed = r.failed?.length ? ` · не ответило: ${r.failed.length}` : '';
      toast(`Новых звуков ${r.added}, освежено ${r.refreshed}${failed}`, r.failed?.length ? 'danger' : 'ok');
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function collectNow() {
    toast('Считаю объём по фразам…');
    try {
      const r = await api.collectTrends();
      toast(
        r.signals
          ? `Замеров ${r.measured}, новых сигналов ${r.signals}`
          : `Замеров ${r.measured}, заметного роста нет`,
        'ok'
      );
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function group(title, list) {
    const box = panel(`${title} · ${list.length}`);
    const grid = el('div', 'platforms');
    for (const t of list) grid.append(card(t));
    box.append(grid);
    return box;
  }

  function card(trend) {
    const box = el('article', 'panel trend');
    if (trend.stale) box.classList.add('trend--stale');

    const head = el('div', 'platform__head');
    const logo = el('span', 'platform__logo');
    logo.innerHTML = iconMarkup(trend.platform, 17);
    head.append(logo);

    const titles = el('div');
    titles.append(el('div', 'platform__name', trend.title));
    const meta = el('div', 'platform__state');
    meta.append(el('span', 'dim', trend.sourceTitle));
    if (trend.metric) meta.append(el('span', 'tag tag--gold', trend.metric));
    titles.append(meta);
    head.append(titles);
    box.append(head);

    if (scope === 'all' && trend.projectId) {
      const project = ctx.state.projects.find((p) => p.id === trend.projectId);
      if (project) {
        const badge = el('span', 'idea__project');
        const dot = el('i');
        dot.style.background = project.accent;
        badge.append(dot, el('span', null, project.title));
        box.append(badge);
      }
    } else if (scope === 'all') {
      box.append(el('span', 'idea__project', 'общий сигнал'));
    }

    if (trend.summary) box.append(el('p', 'idea__text', trend.summary));
    // Звук надо услышать, а не прочитать о нём: решают по ушам.
    if (trend.audio?.id) box.append(trackLine(trend.audio, trend.projectId || ctx.state.projectId));

    const foot = el('div', 'idea__foot');
    foot.append(
      button('Сделать идею', {
        variant: 'primary',
        iconName: 'plus',
        onClick: async () => {
          try {
            await api.createPlan({
              title: trend.title,
              idea: trend.summary,
              platforms: [trend.platform],
              trendId: trend.id,
              // Звук уже выбран — СММщику остаётся понять, что снимать под него.
              needMedia: trend.audio?.id ? 'Вертикальный ролик или 3–10 фото под этот звук: Reels из фото панель соберёт сама' : '',
            });
            toast('Идея добавлена в план', 'ok');
            location.hash = '#/plan';
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      })
    );

    if (trend.url) {
      const link = el('a', 'btn');
      link.href = trend.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(icon('eye', { size: 16 }), el('span', null, 'Источник'));
      foot.append(link);
    }

    foot.append(el('span', 'spacer'));
    if (trend.usedCount) foot.append(el('span', 'dim small', `в плане: ${trend.usedCount}`));

    if (isOwner) {
      foot.append(
        iconButton('x', {
          title: trend.archived ? 'Вернуть' : 'Убрать из списка',
          onClick: async () => {
            await api.archiveTrend(trend.id, !trend.archived);
            load();
          },
        })
      );
    }

    box.append(foot);
    return box;
  }

  function openForm() {
    root.querySelector('.trend-form')?.remove();
    const box = panel('Новый сигнал');
    box.classList.add('trend-form');

    const form = el('form', 'plan-form__grid');

    const platWrap = el('div', 'field');
    platWrap.append(el('label', 'field__label', 'Площадка'));
    const platform = el('select', 'select');
    for (const spec of ctx.state.specs || []) platform.append(new Option(spec.title, spec.id));
    platform.append(new Option('Google Trends', 'google'));
    platform.append(new Option('YouTube', 'youtube'));
    platWrap.append(platform);

    const srcWrap = el('div', 'field');
    srcWrap.append(el('label', 'field__label', 'Источник'));
    const source = el('select', 'select');
    for (const s of sources) source.append(new Option(s.title, s.id));
    srcWrap.append(source);

    const title = field('Что за тренд', 'input', 'Формат, звук, тема, приём');
    const summary = field('Суть и как применим', 'textarea', 'Чем цепляет и что мы можем снять на этом');
    const metric = field('Цифра', 'input', 'Например: +340% за неделю');
    const url = field('Ссылка', 'input', 'На пример или источник');

    form.append(platWrap, srcWrap, title.wrap, metric.wrap, summary.wrap, url.wrap);

    const foot = el('div', 'target__meta');
    foot.style.justifyContent = 'flex-start';
    const submit = button('Добавить', { variant: 'primary' });
    submit.type = 'submit';
    foot.append(submit, button('Отмена', { onClick: () => box.remove() }));
    form.append(foot);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api.addTrend({
          platform: platform.value,
          source: source.value,
          title: title.input.value,
          summary: summary.input.value,
          metric: metric.input.value,
          url: url.input.value || null,
        });
        box.remove();
        load();
        toast('Сигнал добавлен', 'ok');
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

function field(label, tag, placeholder) {
  const wrap = el('div', 'field');
  const input = el(tag, tag === 'textarea' ? 'textarea' : 'input');
  if (tag === 'textarea') input.rows = 3;
  input.placeholder = placeholder || '';
  const id = `t-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, input);
  return { wrap, input };
}
