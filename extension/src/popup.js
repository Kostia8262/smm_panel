/** Настройки сборщика и его состояние. */

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

document.getElementById('save').addEventListener('click', async () => {
  const patch = { enabled: document.getElementById('enabled').checked };
  for (const key of fields) patch[key] = document.getElementById(key).value.trim();
  await chrome.storage.local.set(patch);
  render({ ...stored, ...patch, saved: true });
});

document.getElementById('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
});

render(stored);

function render(state) {
  const box = document.getElementById('stat');
  const queued = (state.queue || []).length;
  const lines = [
    `Собрано всего: <b>${state.collected || 0}</b>`,
    queued ? `Ждёт отправки: <b>${queued}</b>` : 'Очередь пуста',
    state.lastSentAt ? `Последняя отправка: ${new Date(state.lastSentAt).toLocaleString('ru-RU')}` : 'Ещё не отправляли',
  ];
  if (state.lastError) lines.push(`<span class="err">Ошибка: ${state.lastError}</span>`);
  if (state.saved) lines.push('<span class="ok">Настройки сохранены</span>');
  box.innerHTML = lines.join('<br />');
}
