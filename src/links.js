/**
 * Ссылки, метки и переходы.
 *
 * Зачем свой редиректор, а не просто UTM: метка отвечает на вопрос «откуда
 * пришла заявка», но молчит о тех, кто перешёл и не оставил заявку. Разница
 * между «сто переходов и одна заявка» и «три перехода и одна заявка» — это
 * разница между плохим постом и плохой посадочной, и без счётчика переходов
 * их не различить.
 *
 * Метка кампании одна на пост, а источник — свой у каждой площадки: иначе
 * не видно, какая сеть приводит людей, а какая просто шумит.
 */

import { randomBytes } from 'node:crypto';
import { db, log } from './db.js';

/** Соответствие площадки и utm_source. Меняется только вместе с отчётами. */
const SOURCES = {
  telegram: 'telegram',
  threads: 'threads',
  instagram: 'instagram',
  facebook: 'facebook',
  tiktok: 'tiktok',
};

const URL_RE = /https?:\/\/[^\s<>"')]+/g;

export function campaignFor(post) {
  // Метка должна читаться человеком в отчёте по заявкам, а не быть хешем.
  const date = (post.scheduled_at || '').slice(0, 10).replaceAll('-', '') || 'now';
  return `smm-${date}-p${post.id}`;
}

function newCode() {
  return randomBytes(5).toString('base64url');
}

/** Добавить метки к целевому адресу, не затирая уже проставленные вручную. */
export function withUtm(rawUrl, { source, medium = 'social', campaign, content }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const set = (key, value) => {
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
  };
  set('utm_source', source);
  set('utm_medium', medium);
  set('utm_campaign', campaign);
  set('utm_content', content);
  return url.toString();
}

/**
 * Подменить ссылки в тексте короткими.
 *
 * Чужие адреса не трогаем: метки на сайте партнёра бессмысленны, а короткая
 * ссылка на чужой домен выглядит подозрительно и режет доверие.
 *
 * @param {string} text
 * @param {{post: object, platform: string, baseUrl: string, ownDomains: string[]}} ctx
 */
export function shortenLinks(text, { post, platform, baseUrl, ownDomains }) {
  if (!text) return text;
  const campaign = campaignFor(post);
  const source = SOURCES[platform] || platform;

  return text.replace(URL_RE, (match) => {
    // Хвостовая пунктуация в текст не входит: «…сайт: https://x.ua.» — точка
    // принадлежит предложению, а не адресу.
    const trailing = match.match(/[.,;:!?)]+$/)?.[0] || '';
    const clean = trailing ? match.slice(0, -trailing.length) : match;

    let host;
    try {
      host = new URL(clean).hostname.replace(/^www\./, '');
    } catch {
      return match;
    }
    if (!ownDomains.some((d) => host === d || host.endsWith(`.${d}`))) return match;

    const target = withUtm(clean, { source, campaign, content: platform });
    if (!target) return match;

    const code = newCode();
    db.prepare(
      'INSERT INTO links (code, project_id, post_id, platform, target_url, campaign) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(code, post.project_id, post.id, platform, target, campaign);

    return `${baseUrl}/r/${code}${trailing}`;
  });
}

export function findByCode(code) {
  return db.prepare('SELECT * FROM links WHERE code = ?').get(code);
}

/**
 * Робот, а не человек: сети сами открывают ссылку, чтобы нарисовать превью.
 * Telegram делает это сразу после публикации — до 13.09.2026 каждый пост с
 * ссылкой получал «переход» ещё до первого читателя. Встроенные браузеры
 * Instagram и Facebook роботами не считаются: там переходит живой человек.
 */
const BOT_RE =
  /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|facebookcatalog|meta-externalagent|meta-externalfetcher|whatsapp|skypeuripreview|embedly|vkshare|curl\/|wget\/|python-requests|node-fetch|axios\/|go-http-client|headlesschrome/i;

export function isBot(userAgent) {
  const ua = String(userAgent || '').trim();
  return !ua || BOT_RE.test(ua);
}

export function registerClick(linkId, { userAgent = '', referer = '' } = {}) {
  if (isBot(userAgent)) return false;
  db.prepare('INSERT INTO link_clicks (link_id, user_agent, referer) VALUES (?, ?, ?)').run(
    linkId,
    String(userAgent).slice(0, 200),
    String(referer).slice(0, 300)
  );
}

/** Переходы по посту, разложенные по площадкам. */
export function clicksForPost(postId) {
  const rows = db
    .prepare(
      `SELECT l.platform, COUNT(c.id) AS clicks
       FROM links l LEFT JOIN link_clicks c ON c.link_id = l.id
       WHERE l.post_id = ? GROUP BY l.platform`
    )
    .all(postId);
  const total = rows.reduce((sum, r) => sum + r.clicks, 0);
  return { total, byPlatform: Object.fromEntries(rows.map((r) => [r.platform, r.clicks])) };
}

export function campaignOfPost(postId) {
  const row = db.prepare('SELECT campaign FROM links WHERE post_id = ? LIMIT 1').get(postId);
  return row ? row.campaign : null;
}

/**
 * Заявки, пришедшие по метке поста.
 *
 * Панель тянет их из админки школы: заявки живут там, и дублировать их к
 * себе значит завести второй источник правды о клиентах — худшее, что можно
 * сделать с базой учеников.
 */
export async function leadsForCampaign(campaign, { apiUrl, apiToken }) {
  if (!apiUrl || !apiToken) throw new Error('Не настроен доступ к заявкам школы');
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/leads`, {
    headers: { 'x-admin-token': apiToken },
  });
  if (!res.ok) throw new Error(`Админка школы ответила ${res.status}`);
  const data = await res.json();
  const leads = Array.isArray(data.leads) ? data.leads : [];
  return leads.filter((l) => (l.utmCampaign || l.utm_campaign) === campaign);
}

/** Сводка по посту: переходы, заявки и честная пометка, чего мы не знаем. */
export async function postReport(post, { apiUrl, apiToken } = {}) {
  const clicks = clicksForPost(post.id);
  const campaign = campaignOfPost(post.id);
  const report = { campaign, clicks, leads: null, leadsError: null };

  if (!campaign) {
    report.leadsError = 'В посте не было наших ссылок — связать заявки не с чем';
    return report;
  }
  try {
    const leads = await leadsForCampaign(campaign, { apiUrl, apiToken });
    report.leads = {
      count: leads.length,
      items: leads.slice(0, 20).map((l) => ({
        id: l.id,
        name: l.name,
        createdAt: l.createdAt || l.created_at,
        source: l.source,
        status: l.status,
      })),
    };
  } catch (err) {
    report.leadsError = err.message;
  }
  return report;
}

export function logShortened(postId, count) {
  if (count) log('info', `в посте #${postId} подменено ссылок: ${count}`, { postId });
}
