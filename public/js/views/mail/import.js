/**
 * Загрузка базы: файл или вставленный текст → предпросмотр → подтверждение.
 *
 * Предпросмотр отвечает на три вопроса до того, как что-то попадёт в базу:
 * так ли прочитан файл (кодировка, колонки), что с адресами (готовы,
 * опечатки, ошибки, стоп-лист) и что именно произойдёт при подтверждении
 * («будет добавлено N, уже в базе M»). Опечатка не исправляется, пока человек
 * не решил, — молча переписанный адрес это письмо чужому человеку.
 */

import { api } from '../../api.js';
import { el, button, panel, empty, skeleton, toast, note } from '../../ui.js';
import { icon } from '../../icons.js';
import { VERDICT_TAG, tag, num, plural, ADDRESSES, backLink, field, input, select, hashParams, setHashParams } from './common.js';

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Адрес с подсвеченными русскими буквами. Без подсветки строка
 * «oksana@gmаil.com → oksana@gmail.com» выглядит как «исправить на то же
 * самое»: разницу глазом не видно, в этом и беда.
 */
function addressNode(text) {
  const node = el('div', 'mail-addr');
  let plain = '';
  for (const ch of text) {
    if (/\p{Script=Cyrillic}/u.test(ch)) {
      if (plain) node.append(plain);
      plain = '';
      const mark = el('mark', 'mail-glyph', ch);
      mark.title = 'Русская буква';
      node.append(mark);
    } else plain += ch;
  }
  if (plain) node.append(plain);
  return node;
}

export function importView(ctx, key) {
  return key === 'new' ? uploadStep(ctx) : previewStep(ctx, Number(key));
}

/* ================================ шаг 1: файл ================================ */

function uploadStep(ctx) {
  const root = el('div', 'view');
  const listId = Number(hashParams().get('list')) || null;
  const project = ctx.state.projects.find((p) => p.id === ctx.state.projectId);
  let busy = false;

  ctx.setTopbar({ title: 'Загрузка базы', subtitle: project?.title || '' });

  const target = el('div', 'mail-slot');
  if (listId) {
    api
      .mailSummary(false)
      .then(({ lists }) => {
        const list = lists.find((l) => l.id === listId);
        if (list) target.append(note('info', `Адреса добавятся в базу «${list.name}»`, 'Базу можно будет сменить в предпросмотре — до подтверждения ничего не записывается.'));
      })
      .catch(() => {});
  }

  /* ------------------------------ файл ------------------------------ */

  const drop = el('label', 'dropzone mail-drop');
  const fileInput = el('input', 'mail-drop__input');
  fileInput.type = 'file';
  fileInput.accept = '.csv,.tsv,.txt,.xlsx,.vcf,text/csv,text/plain,text/vcard,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const dropTitle = el('div', 'dropzone__title', 'Перетащите файл сюда или нажмите, чтобы выбрать');
  const dropHint = el('div', 'field__hint', 'Excel (.xlsx), CSV, контакты vCard (.vcf) или текстовый файл · до 20 МБ');
  drop.append(icon('upload', { size: 28, className: 'mail-drop__icon' }), dropTitle, dropHint, fileInput);

  fileInput.addEventListener('change', () => fileInput.files[0] && upload({ file: fileInput.files[0] }));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dropzone--hot');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dropzone--hot'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dropzone--hot');
    const file = e.dataTransfer?.files?.[0];
    if (file) upload({ file });
  });

  const filePanel = panel('Файл', drop);

  /* ------------------------------ текст ------------------------------ */

  const text = el('textarea', 'textarea mail-paste');
  text.placeholder = 'Ірина Коваль\tira@gmail.com\nОлег Петренко <oleg@ukr.net>\nolena@i.ua, maria@gmail.com';
  text.setAttribute('aria-label', 'Адреса');
  const recognise = button('Распознать', { variant: 'primary', iconName: 'search', onClick: () => text.value.trim() && upload({ text: text.value }) });
  const pasteActions = el('div', 'mail-actions');
  pasteActions.append(recognise);
  const pastePanel = panel(
    'Или вставьте адреса',
    el('p', 'field__hint', 'Скопируйте ячейки прямо из Google Таблиц или Excel — колонки сохранятся. Подойдёт и список через запятую, и текст письма: имена из вида «Имя <адрес>» тоже найдутся.'),
    text,
    pasteActions
  );

  root.append(backLink(), target, filePanel, pastePanel);
  return root;

  async function upload({ file = null, text: pasted = '' }) {
    if (busy) return;
    if (file && file.size > MAX_BYTES) {
      toast('Файл больше 20 МБ — разделите его на части', 'danger');
      return;
    }
    busy = true;
    drop.classList.add('mail-drop--busy');
    dropTitle.textContent = file ? `Разбираем «${file.name}»…` : 'Разбираем вставленный текст…';
    recognise.disabled = true;
    try {
      const { id } = await api.uploadMailImport({ file, text: pasted, listId });
      location.hash = `#/mail/import/${id}${listId ? `?list=${listId}` : ''}`;
    } catch (err) {
      toast(err.message, 'danger');
      dropTitle.textContent = 'Перетащите файл сюда или нажмите, чтобы выбрать';
      drop.classList.remove('mail-drop--busy');
      recognise.disabled = false;
      fileInput.value = '';
      busy = false;
    }
  }
}

/* ============================= шаг 2: предпросмотр ============================= */

function previewStep(ctx, id) {
  const root = el('div', 'view');
  const params = hashParams();
  const state = {
    verdict: params.get('verdict') || '',
    page: Number(params.get('page')) || 1,
    dest: params.get('list') || 'new',
    includeWarnings: true,
    newName: '',
    newBasis: '',
    newNote: '',
  };
  const path = `#/mail/import/${id}`;
  let data = null;
  let lists = [];
  let consentBases = {};
  let destBuilt = false;
  // Узлы формы «Куда добавить». Объявлены здесь, а не у своих функций: всё
  // после `return root` не выполняется, и `let` там — temporal dead zone.
  let destNodes = null;
  let requestNo = 0;
  let pollTimer = null;

  ctx.setTopbar({ title: 'Загрузка базы', subtitle: 'Предпросмотр — в базу пока ничего не записано' });

  const metaHost = el('div');
  metaHost.append(skeleton(120));
  const tilesHost = el('div', 'mail-verdicts');
  const rowsHost = el('div');
  const destHost = el('div');

  root.append(backLink(), metaHost, tilesHost, rowsHost, destHost);

  api
    .mailSummary(false)
    .then((summary) => {
      lists = summary.lists.filter((l) => !l.archivedAt);
      consentBases = summary.consentBases;
      if (data) renderDest();
    })
    .catch(() => {});

  load();
  return root;

  /* ------------------------------ данные ------------------------------ */

  async function load() {
    const mine = ++requestNo;
    clearTimeout(pollTimer);
    let fresh;
    try {
      fresh = await api.mailImport(id, {
        verdict: state.verdict,
        page: state.page,
        listId: state.dest,
        warnings: state.includeWarnings ? '1' : '0',
      });
    } catch (err) {
      toast(err.message, 'danger');
      if (err.status === 404) location.hash = '#/mail';
      return;
    }
    if (mine !== requestNo || !root.isConnected) return;
    data = fresh;
    state.page = data.page;

    if (data.import.status === 'done' || data.import.status === 'discarded') {
      renderClosed();
      return;
    }
    if (!state.newName && !destBuilt) state.newName = suggestName(data.import.sourceName);

    renderMeta();
    renderTiles();
    renderRows();
    renderDest();

    // Домены проверяются в фоне — спрашиваем, пока не закончится.
    if (data.import.status === 'checking') pollTimer = setTimeout(() => root.isConnected && load(), 1200);
  }

  function suggestName(source) {
    if (!source || source === 'вставленный текст') return '';
    return source.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 120);
  }

  function renderClosed() {
    for (const host of [metaHost, tilesHost, rowsHost, destHost]) host.textContent = '';
    const done = data.import.status === 'done';
    const box = panel(done ? 'Эта загрузка уже добавлена в базу' : 'Эта загрузка отменена');
    const actions = el('div', 'mail-actions');
    if (done && data.import.listId) {
      actions.append(button('Открыть базу', { variant: 'primary', onClick: () => (location.hash = `#/mail/lists/${data.import.listId}`) }));
    } else {
      actions.append(button('Загрузить заново', { variant: 'primary', iconName: 'upload', onClick: () => (location.hash = '#/mail/import/new') }));
    }
    box.append(actions);
    metaHost.append(box);
  }

  /* ------------------------- как прочитан файл ------------------------- */

  function renderMeta() {
    const imp = data.import;
    metaHost.textContent = '';
    const box = panel(null);

    const head = el('div', 'panel__head');
    head.append(el('h2', null, 'Что распознано'));
    const facts = el('span', 'dim small', `«${imp.sourceName}» · ${imp.formatTitle} · ${plural(totalRows(), ['строка', 'строки', 'строк'])}`);
    head.append(facts);
    box.append(head);

    const settings = el('div', 'mail-settings');
    const textual = ['csv', 'tsv', 'text'].includes(imp.format);
    const tabular = ['csv', 'tsv', 'xlsx'].includes(imp.format);

    if (textual) {
      const encodings = Object.entries(data.options.encodings);
      if (imp.encoding && !data.options.encodings[imp.encoding]) encodings.push([imp.encoding, imp.encoding]);
      const enc = select(encodings, imp.encoding || 'utf-8');
      enc.title = 'Имена превратились в кракозябры — смените кодировку';
      enc.addEventListener('change', () => reparse({ encoding: enc.value }));
      settings.append(field('Кодировка', enc));
    }
    if (['csv', 'tsv'].includes(imp.format)) {
      const delim = select(Object.entries(data.options.delimiters), imp.delimiter);
      delim.addEventListener('change', () => reparse({ delimiter: delim.value }));
      settings.append(field('Разделитель колонок', delim));
    }
    if (imp.format === 'xlsx' && imp.sheets.length > 1) {
      const sheet = select(imp.sheets.map((name, i) => [String(i), name]), String(imp.sheet ?? 0));
      sheet.addEventListener('change', () => reparse({ sheet: Number(sheet.value) }));
      settings.append(field('Лист', sheet));
    }
    if (tabular) {
      const label = el('label', 'check mail-header-check');
      const box2 = el('input', 'mail-check');
      box2.type = 'checkbox';
      box2.checked = imp.hasHeader;
      box2.addEventListener('change', () => reparse({ hasHeader: box2.checked }));
      label.append(box2, el('span', null, 'Первая строка — названия колонок'));
      settings.append(label);
    }
    if (settings.childNodes.length) {
      if (!imp.canReparse) for (const c of settings.querySelectorAll('select, input')) c.disabled = true;
      box.append(settings);
      if (textual) box.append(el('p', 'field__hint', 'Если имена в примерах ниже — кракозябры, смените кодировку.'));
    }

    box.append(mappingTable(imp));

    if (imp.status === 'checking') {
      const p = imp.progress || {};
      const progress = el('div', 'mail-progress');
      const meter = el('div', 'meter');
      const fill = el('div', 'meter__fill');
      fill.style.setProperty('--value', p.total ? String(p.done / p.total) : '0');
      meter.append(fill);
      progress.append(
        el('span', 'small', p.total ? `Проверяем, принимают ли домены почту: ${num(p.done)} из ${num(p.total)}` : 'Проверяем, принимают ли домены почту…'),
        meter
      );
      box.append(progress);
    } else if (imp.progress?.failed) {
      box.append(el('p', 'field__hint', `Проверка доменов не удалась (${imp.progress.failed}) — адреса оставлены как есть.`));
    } else if (imp.progress?.unknown) {
      box.append(el('p', 'field__hint', `${plural(imp.progress.unknown, ['домен не ответил', 'домена не ответили', 'доменов не ответили'])} — их адреса оставлены.`));
    }

    metaHost.append(box);
  }

  function mappingTable(imp) {
    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table mail-map');
    const hr = el('tr');
    for (const h of ['Колонка', 'Примеры', 'Чем считать']) hr.append(el('th', null, h));
    const thead = el('thead');
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    const selects = [];
    imp.columns.forEach((column, index) => {
      const tr = el('tr');
      tr.append(el('td', 'mail-name', column.label));
      tr.append(el('td', 'mail-samples', column.samples.join(' · ') || '—'));
      const role = select(Object.entries(data.options.roles), imp.roles[index] || 'attr');
      role.setAttribute('aria-label', `Роль колонки «${column.label}»`);
      role.disabled = !imp.canReparse;
      role.addEventListener('change', () => {
        const roles = Object.fromEntries(selects.map((s, i) => [i, s.value]));
        reparse({ roles });
      });
      selects.push(role);
      const td = el('td');
      td.append(role);
      tr.append(td);
      tbody.append(tr);
    });
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  async function reparse(patch) {
    try {
      await api.reparseMailImport(id, patch);
    } catch (err) {
      toast(err.message, 'danger');
    }
    state.page = 1;
    load();
  }

  function totalRows() {
    return Object.values(data.counts).reduce((sum, n) => sum + n, 0);
  }

  /* ------------------------------ вердикты ------------------------------ */

  function renderTiles() {
    tilesHost.textContent = '';
    for (const [verdict, meta] of Object.entries(VERDICT_TAG)) {
      const count = data.counts[verdict] || 0;
      const b = el('button', `mail-verdict${meta.tile && count ? ` mail-verdict--${meta.tile}` : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.verdict === verdict));
      b.disabled = !count && state.verdict !== verdict;
      b.append(el('span', 'mail-verdict__value num', num(count)), el('span', 'mail-verdict__label', meta.title));
      b.addEventListener('click', () => {
        state.verdict = state.verdict === verdict ? '' : verdict;
        state.page = 1;
        setHashParams(path, { verdict: state.verdict, list: state.dest === 'new' ? '' : state.dest });
        load();
      });
      tilesHost.append(b);
    }
  }

  /* ------------------------------- строки ------------------------------- */

  function renderRows() {
    rowsHost.textContent = '';
    const box = panel(null);
    const head = el('div', 'panel__head');
    head.append(el('h2', null, state.verdict ? VERDICT_TAG[state.verdict].title : 'Строки'), el('span', 'spacer'));

    const fixable = data.counts.fixable || 0;
    if (fixable) {
      const decide = (all, label, variant = '') =>
        button(label, {
          variant,
          onClick: async () => {
            try {
              await api.decideMailImport(id, { all });
              load();
            } catch (err) {
              toast(err.message, 'danger');
            }
          },
        });
      const group = el('div', 'mail-actions');
      group.append(decide('fix', 'Исправить все опечатки', 'primary'), decide('add', 'Оставить как есть'), decide('skip', 'Пропустить'));
      for (const b of group.querySelectorAll('.btn')) b.classList.add('btn--sm');
      head.append(group);
    }
    box.append(head);

    if (fixable && data.decisions.undecided) {
      box.append(
        note(
          'warn',
          `${plural(data.decisions.undecided, ['адрес похож', 'адреса похожи', 'адресов похожи'])} на опечатку и ${data.decisions.undecided % 10 === 1 && data.decisions.undecided % 100 !== 11 ? 'ждёт' : 'ждут'} решения`,
          'Пока не решите, они не добавятся. Исправление — предложение, а не факт: gmial.com бывает и настоящим доменом.'
        )
      );
    }

    if (!data.rows.length) {
      box.append(empty('check', 'Здесь пусто', 'Под этот вердикт строк нет.'));
      rowsHost.append(box);
      return;
    }

    const wrap = el('div', 'scroll-x');
    const table = el('table', 'table mail-table mail-rows');
    const hr = el('tr');
    for (const h of ['Строка', 'Адрес', 'Имя', 'Итог', 'Что не так']) hr.append(el('th', null, h));
    const thead = el('thead');
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const r of data.rows) tbody.append(rowNode(r));
    table.append(tbody);
    wrap.append(table);
    box.append(wrap);

    if (data.pages > 1) {
      const pager = el('div', 'mail-pager');
      const from = (data.page - 1) * 50 + 1;
      const to = Math.min(data.page * 50, data.total);
      pager.append(el('span', 'num', `${num(from)}–${num(to)} из ${num(data.total)}`));
      const prev = button('Назад', { variant: 'quiet', onClick: () => ((state.page -= 1), load()) });
      const next = button('Дальше', { variant: 'quiet', onClick: () => ((state.page += 1), load()) });
      prev.disabled = data.page <= 1;
      next.disabled = data.page >= data.pages;
      for (const b of [prev, next]) b.classList.add('btn--sm');
      pager.append(prev, next);
      box.append(pager);
    }
    rowsHost.append(box);
  }

  function rowNode(r) {
    const tr = el('tr');
    tr.append(el('td', 'table__time', String(r.rowNo)));

    const tdEmail = el('td');
    tdEmail.append(r.email ? addressNode(r.email) : el('div', 'dim', '—'));
    if (r.suggestion) {
      const s = el('div', 'mail-suggest');
      s.append(icon('chevronRight', { size: 12 }), el('span', null, r.suggestion));
      tdEmail.append(s);
    }
    tr.append(tdEmail);
    tr.append(el('td', r.name ? null : 'dim', r.name || '—'));

    const tdVerdict = el('td');
    tdVerdict.append(tag(VERDICT_TAG[r.verdict]));
    tr.append(tdVerdict);

    const tdIssues = el('td', 'mail-issues');
    tdIssues.append(el('div', null, r.issues.join('; ') || ''));
    if (r.verdict === 'fixable') {
      const decision = select(
        [
          ['', 'Не решено — не добавится'],
          ['fix', `Исправить на ${r.suggestion}`],
          ['add', 'Оставить как есть'],
          ['skip', 'Пропустить'],
        ],
        r.decision || ''
      );
      decision.classList.add('mail-decision');
      decision.setAttribute('aria-label', `Решение по строке ${r.rowNo}`);
      decision.addEventListener('change', async () => {
        if (!decision.value) return;
        try {
          await api.decideMailImport(id, { rows: [{ seq: r.seq, decision: decision.value }] });
          load();
        } catch (err) {
          toast(err.message, 'danger');
        }
      });
      tdIssues.append(decision);
    }
    tr.append(tdIssues);
    return tr;
  }

  /* ---------------------------- куда добавить ---------------------------- */

  function renderDest() {
    if (!data) return;
    if (!destBuilt) buildDest();
    updateDest();
  }

  function buildDest() {
    destBuilt = true;
    destHost.textContent = '';
    const box = panel('Куда добавить');

    const modes = el('div', 'mail-modes');
    const radio = (value, text) => {
      const label = el('label', 'check mail-mode');
      const r = el('input', 'mail-check');
      r.type = 'radio';
      r.name = `dest-${id}`;
      r.value = value;
      r.checked = value === 'new' ? state.dest === 'new' : state.dest !== 'new';
      r.addEventListener('change', () => {
        if (!r.checked) return;
        state.dest = value === 'new' ? 'new' : existing.value || 'new';
        toggleMode();
        setHashParams(path, { verdict: state.verdict, list: state.dest === 'new' ? '' : state.dest });
        load();
      });
      label.append(r, el('span', null, text));
      return label;
    };
    const newRadio = radio('new', 'Новая база');
    const existingRadio = radio('existing', 'Существующая');
    modes.append(newRadio, existingRadio);
    box.append(modes);

    const newBox = el('div', 'mail-form__grid');
    const name = input(state.newName, { placeholder: 'Например: Родители учеников 2026' });
    name.addEventListener('input', () => (state.newName = name.value));
    const basis = select([['', 'Выберите…'], ...Object.entries(consentBases)], state.newBasis);
    basis.addEventListener('change', () => (state.newBasis = basis.value));
    const consentNote = input(state.newNote, { placeholder: 'Для «Другого» — обязательно' });
    consentNote.addEventListener('input', () => (state.newNote = consentNote.value));
    newBox.append(
      field('Название', name),
      field('Откуда адреса', basis, 'Без основания слать нельзя'),
      field('Пояснение к основанию', consentNote)
    );

    const existingBox = el('div', 'mail-form__grid');
    const existing = select(lists.map((l) => [String(l.id), `${l.name} · ${num(l.counts.total)}`]), state.dest !== 'new' ? state.dest : '');
    existing.addEventListener('change', () => {
      state.dest = existing.value;
      setHashParams(path, { verdict: state.verdict, list: state.dest });
      load();
    });
    existingBox.append(field('База', existing));
    if (!lists.length) {
      existingRadio.querySelector('input').disabled = true;
      existingRadio.title = 'У школы пока нет баз';
    }

    const warnings = el('label', 'check');
    const warnBox = el('input', 'mail-check');
    warnBox.type = 'checkbox';
    warnBox.checked = state.includeWarnings;
    warnBox.addEventListener('change', () => {
      state.includeWarnings = warnBox.checked;
      load();
    });
    const warnText = el('span');
    warnings.append(warnBox, warnText);

    const forecast = el('div', 'mail-forecast');
    const actions = el('div', 'mail-actions');
    const commit = button('Добавить в базу', { variant: 'primary', iconName: 'check', onClick: () => doCommit() });
    const discard = button('Отменить загрузку', { variant: 'danger', onClick: () => doDiscard() });
    actions.append(commit, el('span', 'spacer'), discard);

    box.append(newBox, existingBox, warnings, forecast, actions);
    destHost.append(box);
    destNodes = { newBox, existingBox, existing, warnings, warnText, forecast, commit, name, basis, consentNote };
    toggleMode();
  }

  function toggleMode() {
    destNodes.newBox.hidden = state.dest !== 'new';
    destNodes.existingBox.hidden = state.dest === 'new';
    if (state.dest !== 'new' && !destNodes.existing.value && lists[0]) destNodes.existing.value = String(lists[0].id);
  }

  function updateDest() {
    if (!destNodes) return;
    // Список баз мог прийти позже первого ответа — достраиваем выбор.
    if (destNodes.existing.options.length !== lists.length) {
      destNodes.existing.textContent = '';
      for (const l of lists) destNodes.existing.append(new Option(`${l.name} · ${num(l.counts.total)}`, String(l.id)));
      if (state.dest !== 'new') destNodes.existing.value = state.dest;
    }
    if (destNodes.basis.options.length <= 1 && Object.keys(consentBases).length) {
      for (const [bid, title] of Object.entries(consentBases)) destNodes.basis.append(new Option(title, bid));
      destNodes.basis.value = state.newBasis;
    }

    const warn = data.counts.warning || 0;
    destNodes.warnings.hidden = !warn;
    destNodes.warnText.textContent = `Добавить и адреса с предупреждением (${num(warn)})`;

    const f = data.forecast;
    const checking = data.import.status === 'checking';
    destNodes.forecast.textContent = '';
    const fact = (label, value, strong = false) => {
      const item = el('span');
      item.append(`${label}: `, el(strong ? 'b' : 'span', 'num', num(value)));
      return item;
    };
    destNodes.forecast.append(fact('Будет добавлено', f.add, true));
    if (state.dest !== 'new') destNodes.forecast.append(fact('уже в базе', f.existed));
    destNodes.forecast.append(fact('новых людей в школе', f.newContacts));
    if (f.blocked) destNodes.forecast.append(fact('исправленные адреса в стоп-листе', f.blocked));
    if (checking) destNodes.forecast.append(el('span', 'dim', 'цифры уточнятся после проверки доменов'));

    destNodes.commit.disabled = checking || (f.add === 0 && f.existed === 0);
    destNodes.commit.title = checking ? 'Дождитесь конца проверки доменов' : '';
  }

  async function doCommit() {
    const body = { includeWarnings: state.includeWarnings };
    if (state.dest === 'new') {
      body.newList = { name: state.newName, consentBasis: state.newBasis, consentNote: state.newNote };
    } else {
      body.listId = Number(state.dest);
    }
    destNodes.commit.disabled = true;
    try {
      const out = await api.commitMailImport(id, body);
      const extra = out.stats.existed ? `, уже были ${num(out.stats.existed)}` : '';
      toast(`В базу «${out.list.name}» добавлено ${plural(out.stats.added, ADDRESSES)}${extra}`, 'ok');
      location.hash = `#/mail/lists/${out.list.id}`;
    } catch (err) {
      toast(err.message, 'danger');
      destNodes.commit.disabled = false;
    }
  }

  async function doDiscard() {
    if (!confirm('Отменить загрузку? Разобранные строки и сам файл сотрутся, в базу ничего не попадёт.')) return;
    try {
      await api.discardMailImport(id);
      toast('Загрузка отменена', 'ok');
      location.hash = '#/mail';
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
}
