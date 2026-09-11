/**
 * Сбор постов из ленты Threads.
 *
 * Главное решение здесь — **ничего не автоматизировать**. Расширение не
 * листает ленту, не открывает посты, не нажимает кнопки: оно читает ровно
 * то, мимо чего человек прошёл сам. Так это остаётся чтением собственного
 * экрана, а не роботом, который ходит по площадке от вашего имени, —
 * и именно роботов Meta ловит и банит.
 *
 * Следствие: чтобы данных было много, СММщику нужно просто листать ленту и
 * поиск по своим темам. Десять минут прокрутки — сотни постов.
 */

import { parseVisible } from './parse-threads.js';

const FLUSH_EVERY_MS = 15000;
const MAX_BUFFER = 200;

const seen = new Map(); // externalId → пост с наибольшими счётчиками
let enabled = false;
let flushTimer = null;

init();

async function init() {
  const settings = await chrome.storage.local.get(['enabled']);
  enabled = settings.enabled !== false;
  if (!enabled) return;

  // Собираем на каждое изменение ленты, но не чаще раза в секунду:
  // Threads перерисовывает узлы постоянно, и на каждый чих считать незачем.
  const observer = new MutationObserver(throttle(scan, 1000));
  observer.observe(document.body, { childList: true, subtree: true });

  scan();
  flushTimer = setInterval(flush, FLUSH_EVERY_MS);
  window.addEventListener('beforeunload', flush);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
  });
}

function scan() {
  if (!enabled) return;
  const posts = parseVisible(document);

  for (const post of posts) {
    const prev = seen.get(post.externalId);
    // Счётчики растут, пока человек листает: держим максимум, иначе
    // в панель уедет случайный ранний снимок.
    if (!prev || total(post) >= total(prev)) {
      seen.set(post.externalId, { ...post, seenAt: new Date().toISOString() });
    }
  }

  if (seen.size >= MAX_BUFFER) flush();
}

function total(post) {
  return (post.likes || 0) + (post.comments || 0) + (post.reposts || 0) + (post.quotes || 0);
}

async function flush() {
  if (!seen.size) return;
  const batch = [...seen.values()];
  seen.clear();

  try {
    await chrome.runtime.sendMessage({ type: 'observations', posts: batch });
  } catch {
    // Фоновый процесс мог заснуть — вернём в буфер, уйдёт следующей пачкой.
    for (const post of batch) seen.set(post.externalId, post);
  }
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const now = Date.now();
    const wait = Math.max(0, ms - (now - last));
    clearTimeout(timer);
    timer = setTimeout(() => {
      last = Date.now();
      fn();
    }, wait);
  };
}
