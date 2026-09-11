/** Настройки сборщика и его состояние. */

import { decodeSetup } from './setup.js';

const fields = ['panelUrl', 'projectId', 'ingestKey'];

const stored = await chrome.storage.local.get([
  ...fields,
  'enabled',
  'collected',
  'queue',
  'lastSentAt',
  'lastError',
]);

for (const key of fields) {
  const input = document.getElementById(key);
  if (stored[key]) input.value = stored[key];
}
document.getElementById('enabled').checked = stored.enabled !== false;

// Не настроено — сразу открываем ручные поля: человеку видно, чего не хватает.
if (!stored.ingestKey) document.getElementById('manual').open = false;

document.getElementById('apply').addEventListener('click', async () => {
  const raw = document.getElementById('setup').value.trim();
  const parsed = decodeSetup(raw);
  if (!parsed) {
    render({ ...stored, error: 'Строка не разобралась. Скопируйте её в панели заново.' });
    return;
  }
  await chrome.storage.local.set({
    panelUrl: parsed.panelUrl,
    projectId: String(parsed.projectId || ''),
    ingestKey: parsed.ingestKey,
    enabled: true,
  });
  for (const key of fields) {
    document.getElementById(key).value = key === 'projectId' ? String(parsed.projectId || '') : parsed[key] || '';
  }
  document.getElementById('enabled').checked = true;
  document.getElementById('setup').value = '';
  render({ ...stored, ...parsed, saved: `Готово: проект №${parsed.projectId}. Откройте Threads и листайте.` });
});

document.getElementById('save').addEventListener('click', async () => {
  const patch = { enabled: document.getElementById('enabled').checked };
  for (const key of fields) patch[key] = document.getElementById(key).value.trim();
  await chrome.storage.local.set(patch);
  render({ ...stored, ...patch, saved: 'Настройки сохранены' });
});

document.getElementById('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
});

render(stored);

function render(state) {
  const box = document.getElementById('stat');
  const queued = (state.queue || []).length;
  const lines = [];

  if (!state.ingestKey) {
    lines.push('<span class="err">Не настроено — вставьте строку из панели.</span>');
  } else {
    lines.push(`Панель: <b>${escape(state.panelUrl || '—')}</b>, проект <b>${escape(state.projectId || '—')}</b>`);
  }

  lines.push(`Собрано всего: <b>${state.collected || 0}</b>`);
  lines.push(queued ? `Ждёт отправки: <b>${queued}</b>` : 'Очередь пуста');
  if (state.lastSentAt) {
    lines.push(`Последняя отправка: ${new Date(state.lastSentAt).toLocaleString('ru-RU')}`);
  }
  if (state.lastError) lines.push(`<span class="err">Ошибка: ${escape(state.lastError)}</span>`);
  if (state.error) lines.push(`<span class="err">${escape(state.error)}</span>`);
  if (state.saved) lines.push(`<span class="ok">${escape(state.saved)}</span>`);

  box.innerHTML = lines.join('<br />');
}

function escape(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
