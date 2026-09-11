/**
 * Разбор поста Threads из вёрстки.
 *
 * Классы у Meta обфусцированы и меняются при каждой выкатке, поэтому
 * опираемся только на семантику, которая держится годами:
 *   [role="article"] — пост
 *   a[href^="/@"]    — автор
 *   time[datetime]   — время публикации
 *   svg + число      — счётчики реакций
 *
 * Счётчики читаем по порядку кнопок в строке действий: лайк, ответ, репост,
 * цитата. Порядок Meta не меняет, а подписи локализованы — привязываться
 * к словам «Like»/«Вподобайки» значило бы ломаться на каждом языке.
 */

import { parseCount, parseRelativeAge, ageFromDatetime, usernameFromHref } from './parse-numbers.js';

/** Порядок кнопок в строке действий Threads. */
const ACTION_ORDER = ['likes', 'comments', 'reposts', 'quotes'];

/**
 * @param {Element} article узел [role="article"]
 * @returns {object|null} пост или null, если это не пост (реклама, заглушка)
 */
export function parseArticle(article, { now = new Date() } = {}) {
  if (!article) return null;

  const authorLink = article.querySelector('a[href^="/@"]');
  const username = usernameFromHref(authorLink?.getAttribute('href'));
  if (!username) return null; // без автора это не пост

  // Ссылка на сам пост: у Threads это /@user/post/<code>
  const permalinkEl = article.querySelector('a[href*="/post/"]');
  const permalink = permalinkEl ? absolute(permalinkEl.getAttribute('href')) : null;
  const externalId = permalink?.match(/\/post\/([\w-]+)/)?.[1] || null;
  if (!externalId) return null; // без id нечего дедуплицировать

  const timeEl = article.querySelector('time[datetime]');
  const postedAt = timeEl?.getAttribute('datetime') || null;
  const ageHours =
    ageFromDatetime(postedAt, now) ?? parseRelativeAge(timeEl?.textContent) ?? null;

  const counts = readCounts(article);
  const text = readText(article, username);

  return {
    platform: 'threads',
    externalId,
    username,
    permalink,
    postedAt,
    ageHours,
    text,
    mediaType: detectMedia(article),
    ...counts,
  };
}

/**
 * Числа рядом с кнопками действий.
 *
 * Пустая кнопка (реакций ещё нет) числа не показывает вовсе — поэтому
 * считаем нулём, а не пропускаем: «ноль лайков за три часа» это тоже
 * сигнал, и притом важный.
 */
function readCounts(article) {
  const result = { likes: 0, comments: 0, reposts: 0, quotes: 0 };

  // Кнопки действий — это svg внутри кликабельных элементов в нижней части
  // поста. Берём их в порядке появления.
  const buttons = [...article.querySelectorAll('div[role="button"], a[role="link"]')].filter((el) =>
    el.querySelector('svg')
  );

  let index = 0;
  for (const button of buttons) {
    if (index >= ACTION_ORDER.length) break;
    // Число стоит рядом с иконкой, внутри той же кнопки или сразу за ней.
    const near = `${button.textContent || ''} ${button.nextElementSibling?.textContent || ''}`;
    const value = parseCount(near);
    result[ACTION_ORDER[index]] = value === null ? 0 : value;
    index += 1;
  }
  return result;
}

/**
 * Текст поста. Отсекаем имя автора и служебные подписи — иначе в текст
 * попадёт «Подписаться», «Перевести» и сам ник, и слова-спутники посчитаются
 * по мусору.
 */
function readText(article, username) {
  const parts = [];
  for (const node of article.querySelectorAll('span[dir="auto"], div[dir="auto"]')) {
    if (node.closest('[role="button"]')) continue;
    const value = (node.textContent || '').trim();
    if (!value || value === username) continue;
    if (value.length < 2) continue;
    parts.push(value);
  }
  // Длинные куски повторяются вложенными узлами — оставляем самый длинный.
  const unique = [...new Set(parts)].sort((a, b) => b.length - a.length);
  return (unique[0] || '').slice(0, 2000);
}

function detectMedia(article) {
  if (article.querySelector('video')) return 'VIDEO';
  const images = article.querySelectorAll('img[alt]');
  // Аватар автора — тоже img: считаем медиа, только если картинок больше одной.
  if (images.length > 1) return 'IMAGE';
  return 'TEXT';
}

function absolute(href) {
  if (!href) return null;
  try {
    return new URL(href, 'https://www.threads.com').toString();
  } catch {
    return null;
  }
}

/**
 * Все посты, видимые на странице сейчас.
 * @param {Document|Element} root
 */
export function parseVisible(root, { now = new Date() } = {}) {
  const out = [];
  for (const article of root.querySelectorAll('[role="article"]')) {
    const post = parseArticle(article, { now });
    if (post) out.push(post);
  }
  return out;
}
