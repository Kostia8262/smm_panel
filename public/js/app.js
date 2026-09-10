/**
 * Интерфейс планировщика: календарь недели и композер с превью.
 *
 * Никакой сборки — модуль грузится браузером как есть. Справочник площадок
 * приходит с сервера, чтобы лимиты и безопасные зоны были в одном месте,
 * а не разъезжались между фронтом и валидатором.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  specs: null,
  status: null,
  weekStart: startOfWeek(new Date()),
  posts: [],
  post: null,       // открытый в композере
  previewKey: null, // «площадка:раскладка»
  showZones: true   // оверлей интерфейса площадки поверх кадра
};

init();

async function init() {
  const [specs, status] = await Promise.all([
    fetch('/api/specs').then((r) => r.json()),
    fetch('/api/status').then((r) => r.json()),
  ]);
  state.specs = specs.platforms;
  state.status = status.platforms;

  renderConnections();
  await loadWeek();

  $('#prev-week').onclick = () => shiftWeek(-7);
  $('#next-week').onclick = () => shiftWeek(7);
  $('#today').onclick = () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  };
  $('#new-post').onclick = () => openComposer(null, defaultTime(new Date()));

  for (const node of document.querySelectorAll('[data-close]')) node.onclick = closeComposer;
  $('#save-draft').onclick = () => savePost({ status: 'draft' });
  $('#schedule').onclick = schedulePost;
  $('#delete-post').onclick = deletePost;
  $('#post-body').addEventListener('input', () => {
    renderCounters();
    renderPreview();
  });
  $('#post-time').addEventListener('change', () => {
    if (state.post) state.post.scheduled_at = localToIso($('#post-time').value);
  });
  setupDropzone();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#composer').hidden) closeComposer();
  });
}

/* ------------------------------- календарь ------------------------------- */

function startOfWeek(d) {
  const date = new Date(d);
  const day = (date.getDay() + 6) % 7; // неделя с понедельника
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}

function shiftWeek(days) {
  state.weekStart = new Date(state.weekStart.getTime() + days * 86400000);
  loadWeek();
}

async function loadWeek() {
  const from = isoDate(state.weekStart);
  const to = isoDate(new Date(state.weekStart.getTime() + 7 * 86400000));
  const data = await fetch(`/api/posts?from=${from}&to=${to}`).then((r) => r.json());
  state.posts = data.posts;
  renderCalendar();
}

function renderCalendar() {
  const root = $('#calendar');
  root.textContent = '';
  const today = isoDate(new Date()).slice(0, 10);

  $('#week-label').textContent = `${fmtDate(state.weekStart)} — ${fmtDate(
    new Date(state.weekStart.getTime() + 6 * 86400000)
  )}`;

  for (let i = 0; i < 7; i++) {
    const date = new Date(state.weekStart.getTime() + i * 86400000);
    const key = isoDate(date).slice(0, 10);
    const day = el('section', 'day' + (key === today ? ' day--today' : ''));

    const head = el('div', 'day__head');
    const label = date.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
    head.append(el('span', 'day__name', label.charAt(0).toUpperCase() + label.slice(1)));
    const add = el('button', 'btn btn--ghost day__add', '+');
    add.title = 'Добавить пост на этот день';
    add.onclick = () => openComposer(null, defaultTime(date));
    head.append(add);
    day.append(head);

    const posts = state.posts
      .filter((p) => (p.scheduled_at || '').slice(0, 10) === key)
      .sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));

    for (const post of posts) day.append(postCard(post));
    root.append(day);
  }

  const undated = state.posts.filter((p) => !p.scheduled_at);
  if (undated.length) {
    const box = el('section', 'day');
    const head = el('div', 'day__head');
    head.append(el('span', 'day__name', `Без даты · ${undated.length}`));
    box.append(head);
    for (const post of undated) box.append(postCard(post));
    root.append(box);
  }
}

const POST_STATUS = {
  draft: 'черновик',
  scheduled: '',            // штатное состояние молчит
  publishing: 'уходит…',
  published: 'опубликован',
  partial: 'ушёл не везде',
  failed: 'не ушёл',
};

function postCard(post) {
  const card = el('button', `card card--${post.status}`);
  const head = el('div', 'card__head');
  head.append(el('div', 'card__time', post.scheduled_at ? post.scheduled_at.slice(11, 16) : '—'));
  const label = POST_STATUS[post.status];
  if (label) head.append(el('span', `card__status card__status--${post.status}`, label));
  card.append(head);
  card.append(el('div', 'card__text', post.title || firstLine(post.body) || 'Без названия'));

  const icons = el('div', 'card__icons');
  for (const t of post.targets) {
    const spec = state.specs.find((s) => s.id === t.platform);
    const dot = el('span', 'dot');
    dot.style.background = spec ? spec.accent : 'var(--ink-2)';
    dot.title = `${spec ? spec.title : t.platform}: ${targetStatusText(t.status)}`;
    if (t.status === 'failed') dot.style.outline = '2px solid var(--danger)';
    icons.append(dot);
  }
  card.append(icons);
  card.onclick = () => openComposer(post.id);
  return card;
}

function targetStatusText(s) {
  return { pending: 'ждёт', published: 'опубликовано', failed: 'ошибка' }[s] || s;
}

/* -------------------------------- композер -------------------------------- */

async function openComposer(id, presetTime) {
  if (id) {
    const data = await fetch(`/api/posts/${id}`).then((r) => r.json());
    state.post = data.post;
  } else {
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '',
        body: '',
        scheduled_at: presetTime ? localToIso(presetTime) : null,
        targets: [{ platform: 'telegram', format_id: 'any' }],
      }),
    }).then((r) => r.json());
    state.post = res.post;
  }
  state.previewKey = keyOf(state.post.targets[0]);
  fillComposer();
  $('#composer').hidden = false;
}

function fillComposer() {
  const post = state.post;
  $('#post-title').value = post.title || '';
  $('#post-body').value = post.body || '';
  $('#post-time').value = post.scheduled_at ? isoToLocal(post.scheduled_at) : '';
  renderTargets();
  renderMedia();
  renderCounters();
  renderIssues();
  renderPreview();
}

function closeComposer() {
  $('#composer').hidden = true;
  state.post = null;
  loadWeek();
}

function renderTargets() {
  const root = $('#targets');
  root.textContent = '';
  for (const spec of state.specs) {
    const active = state.post.targets.find((t) => t.platform === spec.id);
    const row = el('div', 'target' + (active ? '' : ' target--off'));

    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = Boolean(active);
    toggle.onchange = () => {
      if (toggle.checked) state.post.targets.push({ platform: spec.id, format_id: spec.formats[0].id });
      else state.post.targets = state.post.targets.filter((t) => t.platform !== spec.id);
      savePost({ silent: true }).then(fillComposer);
    };
    row.append(toggle);

    const name = el('span', 'target__name', spec.title);
    name.style.color = spec.accent;
    row.append(name);

    const select = el('select');
    for (const f of spec.formats) {
      const opt = el('option', null, `${f.title} · ${f.w}×${f.h}`);
      opt.value = f.id;
      if (active && active.format_id === f.id) opt.selected = true;
      select.append(opt);
    }
    select.disabled = !active;
    select.onchange = () => {
      active.format_id = select.value;
      savePost({ silent: true }).then(fillComposer);
    };
    row.append(select);

    const conn = state.status.find((c) => c.id === spec.id);
    if (!conn?.configured) {
      row.append(el('span', 'muted small', 'нет токена'));
    }
    root.append(row);
  }
}

function renderCounters() {
  const root = $('#counters');
  root.textContent = '';
  const text = $('#post-body').value;
  const hasMedia = (state.post.media || []).length > 0;

  for (const t of state.post.targets) {
    const spec = state.specs.find((s) => s.id === t.platform);
    if (!spec) continue;
    const limit = hasMedia ? spec.text.limitWithMedia : spec.text.limit;
    const over = text.length > limit;
    const near = !over && text.length > limit * 0.9;
    const chip = el('span', `counter${over ? ' counter--over' : near ? ' counter--warn' : ''}`);
    chip.textContent = `${spec.title}: ${text.length}/${limit}`;
    root.append(chip);
  }
}

function renderMedia() {
  const root = $('#media-list');
  root.textContent = '';
  for (const m of state.post.media || []) {
    const item = el('div', 'media-item');
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
    const del = el('button', 'media-item__del', '✕');
    del.onclick = async () => {
      await fetch(`/api/media/${m.id}`, { method: 'DELETE' });
      const data = await fetch(`/api/posts/${state.post.id}`).then((r) => r.json());
      state.post = data.post;
      fillComposer();
    };
    item.append(del);
    item.append(
      el('div', 'media-item__meta', `${m.width && m.height ? `${m.width}×${m.height}` : m.kind} · ${Math.round(m.bytes / 1024)} КБ`)
    );
    root.append(item);
  }
}

function renderIssues() {
  const root = $('#issues');
  root.textContent = '';
  const v = state.post.validation;
  if (!v) return;
  for (const b of v.blockers) root.append(issueRow('blocker', b));
  for (const w of v.warnings) root.append(issueRow('warning', w));
  $('#schedule').disabled = v.blockers.length > 0;
}

function issueRow(kind, item) {
  const spec = state.specs.find((s) => s.id === item.platform);
  const row = el('div', `issue issue--${kind}`);
  row.append(el('span', 'issue__where', spec ? spec.title : 'Пост'));
  row.append(el('span', null, item.message));
  return row;
}

/* -------------------------------- превью -------------------------------- */

function keyOf(t) {
  return t ? `${t.platform}:${t.format_id}` : null;
}

function renderPreview() {
  const tabs = $('#preview-tabs');
  tabs.textContent = '';
  const targets = state.post?.targets || [];
  if (!targets.some((t) => keyOf(t) === state.previewKey)) state.previewKey = keyOf(targets[0]);

  for (const t of targets) {
    const spec = state.specs.find((s) => s.id === t.platform);
    const format = spec?.formats.find((f) => f.id === t.format_id);
    if (!spec || !format) continue;
    const tab = el('button', 'tab' + (keyOf(t) === state.previewKey ? ' tab--active' : ''));
    tab.textContent = `${spec.title} · ${format.title}`;
    tab.onclick = () => {
      state.previewKey = keyOf(t);
      renderPreview();
    };
    tabs.append(tab);
  }

  const zonesToggle = el('button', 'tab' + (state.showZones ? ' tab--active' : ''), 'Зоны интерфейса');
  zonesToggle.title = 'Показать, что перекроют кнопки площадки';
  zonesToggle.onclick = () => {
    state.showZones = !state.showZones;
    renderPreview();
  };
  tabs.append(zonesToggle);

  const stage = $('#preview-stage');
  stage.textContent = '';
  const limits = $('#preview-limits');
  limits.textContent = '';
  if (!state.previewKey) return;

  const [platformId, formatId] = state.previewKey.split(':');
  const spec = state.specs.find((s) => s.id === platformId);
  const format = spec.formats.find((f) => f.id === formatId);
  const media = (state.post.media || [])[0];
  const text = $('#post-body').value;

  const phone = el('div', 'phone');
  const frame = el('div', 'phone__frame');
  frame.style.aspectRatio = `${format.w} / ${format.h}`;

  if (media) {
    const node = media.kind === 'video' ? el('video') : el('img');
    node.className = 'phone__media';
    node.src = media.url;
    if (media.kind === 'video') {
      node.muted = true;
      node.loop = true;
      node.autoplay = true;
      node.playsInline = true;
    }
    // Точка фокуса: тот же смысл, что у кропа на сервере — куда целимся кадром.
    node.style.objectPosition = `${(media.focus_x ?? 0.5) * 100}% ${(media.focus_y ?? 0.5) * 100}%`;
    frame.append(node);
  } else {
    frame.append(el('div', 'phone__empty', 'Загрузи мастер-файл — здесь будет кадр как в ленте'));
  }

  // Безопасные зоны: то, что перекроет интерфейс площадки.
  for (const z of state.showZones ? format.safeZones || [] : []) {
    const zone = el('div', 'safe', z.label);
    zone.style.top = `${z.top}%`;
    zone.style.left = `${z.left}%`;
    zone.style.width = `${z.width}%`;
    zone.style.height = `${z.height}%`;
    frame.append(zone);
  }

  // Квадратная обрезка в сетке профиля — про неё забывают чаще всего.
  if (format.gridCrop) {
    const side = (format.w / format.h) * 100;
    const crop = el('div', 'grid-crop');
    crop.style.left = '0';
    crop.style.width = '100%';
    crop.style.height = `${side}%`;
    crop.style.top = `${(100 - side) / 2}%`;
    crop.title = format.gridCrop.note;
    frame.append(crop);
  }

  phone.append(frame);
  if (text) {
    const cap = el('div', 'phone__caption', text.slice(0, 220) + (text.length > 220 ? '…' : ''));
    phone.append(cap);
  }
  stage.append(phone);

  // Подписи ограничений — прямо под превью, чтобы не держать их в голове.
  const hasMedia = (state.post.media || []).length > 0;
  addLimit(limits, 'Кадр', `${format.w}×${format.h}`);
  addLimit(limits, 'Текст', `до ${hasMedia ? spec.text.limitWithMedia : spec.text.limit} символов`);
  addLimit(limits, 'Картинки', spec.media.image.types.map((t) => t.toUpperCase()).join(', '));
  addLimit(limits, 'Видео', spec.media.video.maxSeconds ? `до ${spec.media.video.maxSeconds} с` : 'без предела длины');
  if (format.gridCrop) addLimit(limits, 'В профиле', format.gridCrop.note);
  for (const note of spec.notes || []) {
    const row = el('div', 'muted small', note);
    limits.append(row);
  }
}

function addLimit(root, label, value) {
  const row = el('div', 'limit-row');
  row.append(el('b', null, label));
  row.append(el('span', null, value));
  root.append(row);
}

/* -------------------------------- действия -------------------------------- */

function setupDropzone() {
  const zone = $('#dropzone');
  const input = $('#file-input');
  $('#pick-files').onclick = () => input.click();
  input.onchange = () => uploadFiles([...input.files]);

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
  zone.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
}

async function uploadFiles(files) {
  if (!files.length || !state.post) return;
  say('загружаю…');
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch(`/api/posts/${state.post.id}/media`, { method: 'POST', body: form });
  const data = await res.json();
  state.post = data.post;
  fillComposer();
  say('загружено');
}

async function savePost({ silent = false, status } = {}) {
  if (!state.post) return;
  if (!silent) say('сохраняю…');
  const body = {
    title: $('#post-title').value,
    body: $('#post-body').value,
    scheduled_at: localToIso($('#post-time').value),
    targets: state.post.targets,
  };
  if (status) body.status = status;
  const res = await fetch(`/api/posts/${state.post.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  state.post = data.post;
  if (!silent) {
    renderIssues();
    say('сохранено');
  }
  return data.post;
}

async function schedulePost() {
  await savePost({ silent: true });
  const res = await fetch(`/api/posts/${state.post.id}/schedule`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    state.post.validation = { blockers: data.blockers || [], warnings: data.warnings || [] };
    renderIssues();
    say(data.error || 'не удалось поставить в очередь');
    return;
  }
  state.post = data.post;
  say('в очереди');
  closeComposer();
}

async function deletePost() {
  if (!state.post || !confirm('Удалить пост?')) return;
  await fetch(`/api/posts/${state.post.id}`, { method: 'DELETE' });
  closeComposer();
}

function renderConnections() {
  const root = $('#connections');
  root.textContent = '';
  for (const c of state.status) {
    const chip = el('button', `chip ${c.configured ? 'chip--on' : 'chip--off'}`);
    chip.append(el('span', 'chip__dot'));
    chip.append(el('span', null, c.title));
    chip.title = c.configured ? 'Настроено — нажми, чтобы проверить связь' : `Не хватает: ${c.missing.join(', ')}`;
    chip.onclick = async () => {
      const res = await fetch(`/api/platforms/${c.id}/check`, { method: 'POST' });
      const data = await res.json();
      alert(data.ok ? `${c.title}: связь есть (${data.account || data.chat || 'ок'})` : `${c.title}: ${data.error || 'не хватает ' + (data.missing || []).join(', ')}`);
    };
    root.append(chip);
  }
}

/* -------------------------------- мелочи -------------------------------- */

function say(text) {
  $('#save-state').textContent = text;
  clearTimeout(say.timer);
  say.timer = setTimeout(() => ($('#save-state').textContent = ''), 2500);
}

function firstLine(text) {
  return (text || '').split('\n')[0].slice(0, 80);
}

function isoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

function fmtDate(d) {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function defaultTime(date) {
  const d = new Date(date);
  d.setHours(10, 0, 0, 0);
  return isoToLocalFromDate(d);
}

/** Поле datetime-local отдаёт местное время — в базе держим его же, без зоны. */
function localToIso(value) {
  if (!value) return null;
  return value.replace('T', ' ') + ':00';
}

function isoToLocal(value) {
  return value ? value.slice(0, 16).replace(' ', 'T') : '';
}

function isoToLocalFromDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
