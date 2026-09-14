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
import { getSetting } from './staff.js';
import { decrypt } from './secrets.js';
import { replaceOwnLinks, CODE_LENGTH } from './shortlink.js';

/** Соответствие площадки и utm_source. Меняется только вместе с отчётами. */
const SOURCES = {
  telegram: 'telegram',
  threads: 'threads',
  instagram: 'instagram',
  facebook: 'facebook',
  tiktok: 'tiktok',
};

export function campaignFor(post) {
  // Метка должна читаться человеком в отчёте по заявкам, а не быть хешем.
  const date = (post.scheduled_at || '').slice(0, 10).replaceAll('-', '') || 'now';
  return `smm-${date}-p${post.id}`;
}

function newCode() {
  const code = randomBytes(5).toString('base64url');
  // Проверка поста считает длину текста по CODE_LENGTH — разойтись им нельзя.
  if (code.length !== CODE_LENGTH) throw new Error('длина кода короткой ссылки разошлась с shortlink.js');
  return code;
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

  return replaceOwnLinks(text, ownDomains, (clean) => {
    const target = withUtm(clean, { source, campaign, content: platform });
    if (!target) return null;

    const code = newCode();
    db.prepare(
      'INSERT INTO links (code, project_id, post_id, platform, target_url, campaign) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(code, post.project_id, post.id, platform, target, campaign);

    return `${baseUrl}/r/${code}`;
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
 * Доступ к заявкам школы: адрес админки и ключ интеграции.
 *
 * С 14.09.2026 — ключ интеграции со скоупом `leads:read` (админка →
 * «Співробітники» → «Інтеграції»), а не полный админ-токен: тот открывал всю
 * админку и уезжал в бэкапы базы панели. Хранится в той же настройке
 * `leads_api_token`, шифротекстом.
 */
export function leadsAccess() {
  const stored = getSetting('leads_api_token', '');
  let apiKey = process.env.LEADS_API_TOKEN || '';
  if (stored) {
    try {
      apiKey = decrypt(stored);
    } catch {
      apiKey = '';
    }
  }
  return { apiUrl: getSetting('leads_api_url', 'https://mycomputer.education'), apiKey };
}

/** Запрос к API интеграции админки: 401 и 403 — разные беды, и человеку нужно знать какая. */
async function integrationGet(path, { apiUrl, apiKey, apiToken, fetchImpl = globalThis.fetch }) {
  const key = apiKey || apiToken;
  if (!apiUrl || !key) throw new Error('Не вписан ключ интеграции с админкой школы');
  let res;
  try {
    res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, {
      headers: { 'x-integration-key': key },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Админка школы не ответила: ${err.message}`);
  }
  if (res.status === 401) throw new Error('Админка не узнала ключ — вставьте ключ из «Інтеграції» (mcai_…), а не старый админ-токен');
  if (res.status === 403) throw new Error('Ключ интеграции отозван или без права leads:read — выпустите новый в админке');
  if (!res.ok) throw new Error(`Админка школы ответила ${res.status}`);
  return res.json();
}

/**
 * Заявки, пришедшие по метке поста или письма.
 *
 * Панель тянет их из админки школы: заявки живут там, и дублировать их к
 * себе значит завести второй источник правды о клиентах — худшее, что можно
 * сделать с базой учеников. Фильтр по метке — на стороне админки.
 */
export async function leadsForCampaign(campaign, access = leadsAccess()) {
  const data = await integrationGet(`/api/integration/leads?utm_campaign=${encodeURIComponent(campaign)}`, access);
  return Array.isArray(data.leads) ? data.leads : [];
}

/** «Проверить связь»: ключ жив и у него есть право читать заявки. */
export async function pingLeads(access = leadsAccess()) {
  const data = await integrationGet('/api/integration/ping', access);
  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  if (!scopes.includes('leads:read')) throw new Error('У ключа нет права leads:read — выпустите ключ с этим правом');
  return { name: data.name || '', scopes };
}

/** Сводка по посту: переходы, заявки и честная пометка, чего мы не знаем. */
export async function postReport(post, access = leadsAccess()) {
  const clicks = clicksForPost(post.id);
  const campaign = campaignOfPost(post.id);
  const report = { campaign, clicks, leads: null, leadsError: null };

  if (!campaign) {
    report.leadsError = 'В посте не было наших ссылок — связать заявки не с чем';
    return report;
  }
  try {
    const leads = await leadsForCampaign(campaign, access);
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
