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

export function trendsView(ctx) {
  const root = el('div', 'view');
  let trends = [];
  let sources = [];
  const isOwner = ctx.state.user.role === 'owner';

  ctx.setTopbar({
    title: 'Тренды',
    subtitle: 'Сигналы, из которых делаем план',
    actions: isOwner
      ? [button('Добавить тренд', { variant: 'primary', iconName: 'plus', onClick: () => openForm() })]
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
        'Автоматически собираются Google Trends, «в тренде» у YouTube и наша статистика по вышедшим постам. У Instagram, Facebook и TikTok публичного API трендов нет — туда сигнал заносится разбором.'
      )
    );

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
