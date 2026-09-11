/**
 * Отправка собранного в планировщик.
 *
 * Живёт в фоне, а не в странице: content-скрипт умирает вместе с вкладкой,
 * а пачка может не успеть уйти. Здесь же копится очередь на случай, когда
 * панель недоступна — терять данные из-за пятиминутного простоя сервера
 * обидно, второй раз человек ту же ленту не пролистает.
 */

const QUEUE_KEY = 'queue';
const MAX_QUEUE = 2000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'observations') return false;
  enqueue(message.posts).then(() => sendResponse({ ok: true }));
  return true; // ответ будет асинхронным
});

chrome.alarms.create('flush', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'flush') flush();
});

async function enqueue(posts) {
  const { queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  const merged = [...queue, ...posts].slice(-MAX_QUEUE);
  await chrome.storage.local.set({ [QUEUE_KEY]: merged });
  await bumpCounter(posts.length);
  flush();
}

async function flush() {
  const { queue = [], panelUrl, ingestKey, projectId } = await chrome.storage.local.get([
    QUEUE_KEY,
    'panelUrl',
    'ingestKey',
    'projectId',
  ]);
  if (!queue.length || !panelUrl || !ingestKey) return;

  try {
    const res = await fetch(`${panelUrl.replace(/\/$/, '')}/api/ingest/observed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-key': ingestKey },
      body: JSON.stringify({ projectId: projectId ? Number(projectId) : null, posts: queue }),
    });
    if (!res.ok) throw new Error(`панель ответила ${res.status}`);

    await chrome.storage.local.set({ [QUEUE_KEY]: [], lastSentAt: new Date().toISOString(), lastError: '' });
  } catch (err) {
    // Очередь не трогаем: попробуем через минуту.
    await chrome.storage.local.set({ lastError: String(err.message || err) });
  }
}

async function bumpCounter(n) {
  const { collected = 0 } = await chrome.storage.local.get('collected');
  await chrome.storage.local.set({ collected: collected + n });
}
