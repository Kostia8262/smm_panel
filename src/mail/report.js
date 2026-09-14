/**
 * Результаты рассылки (docs/рассылка.md, §12, фаза 5).
 *
 * Цепочка, ради которой рассылку и делают: отправлено → переходы → заявки.
 * Честно о границах:
 *   — открытий нет: пиксель слежения в письме — первый признак рекламы для
 *     фильтров, а Gmail всё равно подгружает картинки через свой прокси;
 *   — переход по ссылке могла сделать и проверка почтового фильтра, а не
 *     человек: одна короткая ссылка на всех получателей, поимённо не различить;
 *   — заявки — по метке utm_campaign в админке школы: если человек ушёл с сайта
 *     и вернулся позже без метки, заявка к письму не привяжется.
 */

import { db, log } from '../db.js';
import { leadsForCampaign, leadsAccess } from '../links.js';
import { MailError } from './store.js';
import * as campaigns from './campaigns.js';

const nowIso = (now = Date.now()) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Подпись ссылки для отчёта: не адрес, а то, на что человек нажимал. */
function linkLabels(blocks) {
  const labels = {};
  for (const b of blocks) {
    if (b.type === 'button' && b.href) labels[b.href.trim()] ||= `Кнопка «${b.text || 'Детальніше'}»`;
    if (['hero', 'image'].includes(b.type) && b.href) labels[b.href.trim()] ||= b.type === 'hero' ? 'Главная картинка' : 'Картинка в тексте';
    for (const text of [b.text, b.note, ...(b.items || [])]) {
      for (const m of String(text || '').matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) labels[m[2]] ||= `Ссылка «${m[1]}»`;
    }
  }
  return labels;
}

/**
 * Переходы, метка и отписки письма — без похода в админку. Общее у отчёта
 * в панели и у отчёта для админки школы (src/mail/crm-access.js).
 */
export function linkStats(campaign) {
  const row = campaigns.campaignRow(campaign.id);
  const map = row.link_map ? JSON.parse(row.link_map) : {};
  const labels = linkLabels(campaign.blocks);
  const byShort = Object.fromEntries(Object.entries(map).map(([url, short]) => [short.split('/r/')[1], url]));

  const links = db
    .prepare(
      `SELECT l.id, l.code, l.target_url, l.campaign, COUNT(k.id) AS clicks
         FROM links l LEFT JOIN link_clicks k ON k.link_id = l.id
        WHERE l.mail_campaign_id = ? GROUP BY l.id ORDER BY clicks DESC, l.id`
    )
    .all(campaign.id)
    .map((l) => {
      const original = byShort[l.code] || l.target_url;
      return { label: labels[original] || original.replace(/^https?:\/\//, ''), url: original, clicks: l.clicks };
    });
  const clicks = links.reduce((sum, l) => sum + l.clicks, 0);
  const unsubscribed = db.prepare("SELECT COUNT(DISTINCT contact_id) AS n FROM mail_events WHERE campaign_id = ? AND type = 'unsubscribed'").get(campaign.id).n;
  const tag = db.prepare('SELECT campaign FROM links WHERE mail_campaign_id = ? LIMIT 1').get(campaign.id)?.campaign || null;
  return { tag, links, clicks, unsubscribed };
}

/**
 * @param {object} campaign — из campaigns.getCampaign
 * @param {{withPeople?: boolean, fetchLeads?: Function}} opts — withPeople: имена заявок только владельцу
 */
export async function campaignReport(campaign, { withPeople = false, fetchLeads = leadsForCampaign } = {}) {
  const progress = campaign.progress || { total: 0, queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, unknown: 0, cancelled: 0 };
  const { tag, links, clicks, unsubscribed } = linkStats(campaign);
  const resubscribed = db.prepare("SELECT COUNT(DISTINCT contact_id) AS n FROM mail_events WHERE campaign_id = ? AND type = 'resubscribed'").get(campaign.id).n;
  const failures = db
    .prepare("SELECT COALESCE(error, 'без объяснения') AS reason, COUNT(*) AS n FROM mail_sends WHERE campaign_id = ? AND status = 'failed' GROUP BY reason ORDER BY n DESC LIMIT 10")
    .all(campaign.id);

  let leads = null;
  let leadsError = null;
  if (!tag) {
    leadsError = progress.total ? 'В письме не было ссылок на свои сайты — связать заявки не с чем' : null;
  } else {
    try {
      const found = await fetchLeads(tag, leadsAccess());
      leads = {
        count: found.length,
        items: withPeople
          ? found.slice(0, 20).map((l) => ({ name: l.name, createdAt: l.createdAt || l.created_at, source: l.source, status: l.status }))
          : [],
      };
    } catch (err) {
      leadsError = err.message;
    }
  }

  const rate = (n) => (progress.sent ? Math.round((n / progress.sent) * 1000) / 10 : null);
  return {
    tag,
    progress,
    clicks,
    clickRate: rate(clicks),
    links,
    unsubscribed,
    resubscribed,
    unsubscribeRate: rate(unsubscribed),
    failures,
    leads,
    leadsError,
    builtAt: nowIso(),
  };
}

/**
 * Повторить письма с неизвестной судьбой — только владелец и только осознанно:
 * часть из них Google, скорее всего, принял, и эти люди получат письмо дважды.
 */
export function retryUnknown(id, { user, projectId = null, now = Date.now() }) {
  const campaign = campaigns.getCampaign(id, projectId);
  if (!['sending', 'paused', 'done'].includes(campaign.status)) throw new MailError('Повторить можно только в идущей, приостановленной или разосланной рассылке', 409);
  if (!campaign.approvedCurrent) throw new MailError('Письмо изменилось после утверждения — повтор невозможен', 409);
  db.exec('BEGIN');
  let count = 0;
  try {
    count = db.prepare("UPDATE mail_sends SET status = 'queued', sending_since = NULL, sent_at = NULL, error = 'повтор после неизвестной судьбы' WHERE campaign_id = ? AND status = 'unknown'").run(campaign.id).changes;
    if (count && campaign.status === 'done') {
      db.prepare("UPDATE mail_campaigns SET status = 'sending', finished_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(now), campaign.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (!count) throw new MailError('Писем с неизвестной судьбой нет', 409);
  log('warn', `рассылка: письмо #${campaign.id} — ${user.name} повторил писем с неизвестной судьбой: ${count}`);
  return campaigns.getCampaign(campaign.id);
}
