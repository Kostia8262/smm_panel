/**
 * Рассылка, фазы 5–6: результаты, повтор неизвестных, возвраты, частота.
 *
 *   — отчёт связывает цепочку «ушло → переходы → заявки» и подписывает ссылки
 *     тем, на что нажимали, а не адресом;
 *   — повтор писем с неизвестной судьбой возвращает рассылку в отправку;
 *   — из текста возврата берутся только адреса своих контактов, служебные — нет;
 *   — получавший письмо школы недавно пропускается и в расчёте, и в снимке.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-mail5-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.MAIL_MEDIA_DIR = join(dir, 'mail-media');
process.env.UPLOAD_DIR = join(dir, 'uploads');
process.env.PUBLIC_BASE_URL = 'https://smm.example';

const { db } = await import('../src/db.js');
const staff = await import('../src/staff.js');
const store = await import('../src/mail/store.js');
const senders = await import('../src/mail/sender/senders.js');
const campaigns = await import('../src/mail/campaigns.js');
const runner = await import('../src/mail/runner.js');
const report = await import('../src/mail/report.js');
const bounces = await import('../src/mail/bounces.js');
const links = await import('../src/links.js');

const NOON = Date.parse('2026-09-14T09:00:00Z');
let projectId;
let owner;
let senderId;
let list;
const ids = {};

function google(plan = () => 'ok') {
  return async (url, init = {}) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'A', expires_in: 3600 }) };
    const raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8');
    const to = /^To: .*?<?([^<>\s]+@[^<>\s]+)>?$/m.exec(raw)?.[1];
    if (plan(to) === 'hang') throw new Error('socket hang up');
    return { ok: true, status: 200, json: async () => ({ id: `g-${to}` }) };
  };
}

function launch(title) {
  const c = campaigns.createCampaign(projectId, { staffId: owner.id });
  const u = campaigns.updateCampaign(c.id, {
    title,
    subject: 'Новий набір',
    blocks: [
      { type: 'text', text: 'Дивіться [розклад](https://mycomputer.education/schedule)' },
      { type: 'button', text: 'Записатися', href: 'https://mycomputer.education/trial' },
    ],
    lists: { include: [list.id], exclude: [] },
  });
  db.prepare("INSERT INTO mail_test_sends (sender_id, campaign_id, content_hash, to_email, gmail_id, sent_at) VALUES (?, ?, ?, 'me@example.com', 'gt', ?)").run(senderId, u.id, u.contentHash, new Date(NOON).toISOString());
  campaigns.approveCampaign(u.id, owner);
  runner.scheduleCampaign(u.id, { user: owner, now: NOON });
  return u.id;
}

async function drain(fetchImpl, now = NOON) {
  for (let i = 0; i < 12; i++) {
    runner.resetPacing();
    await runner.mailStep({ now: now + i * 1000, fetchImpl });
  }
}

before(() => {
  projectId = db.prepare("SELECT id FROM projects WHERE slug = 'education'").get().id;
  owner = staff.create({ name: 'Власник', role: 'owner' });
  senders.saveGoogleApp({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'secret' });
  senderId = senders.saveConnected({ email: 'box@gmail.com', refreshToken: 'r' }, NOON - 30 * 86400000).id;
  list = store.createList(projectId, { name: 'Учні', consentBasis: 'client' });
  for (const key of ['ann', 'bob', 'cat']) ids[key] = store.addContactManually({ listId: list.id, email: `${key}@example.com`, name: key }).contactId;
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Временный каталог подчистит система.
  }
});

let first;

test('отчёт: переходы подписаны кнопкой и ссылкой, отписки и заявки — по этой рассылке', async () => {
  first = launch('Перша');
  await drain(google((to) => (to === 'cat@example.com' ? 'hang' : 'ok')));
  assert.equal(campaigns.getCampaign(first).status, 'done');

  const trial = db.prepare("SELECT id FROM links WHERE mail_campaign_id = ? AND target_url LIKE '%trial%'").get(first);
  const browser = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130';
  links.registerClick(trial.id, { userAgent: browser });
  links.registerClick(trial.id, { userAgent: browser });
  links.registerClick(trial.id, { userAgent: 'Googlebot/2.1' });
  store.selfUnsubscribe(ids.bob, projectId, { campaignId: first, source: 'page' });

  let askedTag = null;
  const out = await report.campaignReport(campaigns.getCampaign(first), {
    withPeople: true,
    fetchLeads: async (tag) => {
      askedTag = tag;
      return [{ name: 'Ірина', utmCampaign: tag, createdAt: '2026-09-14T10:00:00Z' }];
    },
  });
  assert.match(askedTag, /^mail-\d{8}-c\d+$/);
  assert.equal(out.progress.sent, 2);
  assert.equal(out.progress.unknown, 1);
  assert.equal(out.clicks, 2, 'робот не считается');
  assert.equal(out.links[0].label, 'Кнопка «Записатися»');
  assert.ok(out.links.some((l) => l.label === 'Ссылка «розклад»'));
  assert.equal(out.unsubscribed, 1);
  assert.equal(out.clickRate, 100);
  assert.equal(out.leads.count, 1);
  assert.equal(out.leads.items[0].name, 'Ірина');

  const noPeople = await report.campaignReport(campaigns.getCampaign(first), { fetchLeads: async () => [{ name: 'Ірина' }] });
  assert.deepEqual(noPeople.leads.items, [], 'СММщику — только число заявок');
});

test('история писем в карточке контакта: что получал и где отписался', () => {
  const card = store.getContact(ids.bob);
  assert.equal(card.letters.length, 1);
  assert.equal(card.letters[0].title, 'Перша');
  assert.equal(card.letters[0].status, 'sent');
  assert.equal(card.letters[0].unsubscribedHere, true);
});

test('повтор писем с неизвестной судьбой — рассылка снова отправляется и доходит', async () => {
  const again = report.retryUnknown(first, { user: owner, now: NOON });
  assert.equal(again.status, 'sending');
  assert.equal(again.progress.queued, 1);
  await drain(google(), NOON + 60000);
  const done = campaigns.getCampaign(first);
  assert.equal(done.status, 'done');
  assert.equal(done.progress.unknown, 0);
  assert.throws(() => report.retryUnknown(first, { user: owner, now: NOON }), /неизвестной судьбой нет/);
});

test('частота: получавший письмо недавно пропускается в расчёте и в снимке', async () => {
  store.selfResubscribe(ids.bob, projectId, { campaignId: first });
  campaigns.setFrequencyGapDays(projectId, 7, owner);
  const draft = campaigns.createCampaign(projectId, {});
  const withLists = campaigns.updateCampaign(draft.id, { lists: { include: [list.id], exclude: [] } });
  const aud = campaigns.audience(withLists, NOON + 3600000);
  assert.equal(aud.recent, 3, 'все трое получили «Першу» только что');
  assert.equal(aud.recipients, 0);
  campaigns.removeCampaign(draft.id);

  const second = launch('Друга');
  runner.startDue(NOON + 3600000);
  const rows = db.prepare('SELECT status, error FROM mail_sends WHERE campaign_id = ?').all(second);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === 'skipped' && /меньше 7 дн/.test(r.error)));
  await runner.mailStep({ now: NOON + 3600000, fetchImpl: google() });
  assert.equal(campaigns.getCampaign(second).status, 'done', 'все пропущены — рассылка закрывается сама');
  assert.throws(() => campaigns.setFrequencyGapDays(projectId, 100, owner), /от 0 до 60/);
  campaigns.setFrequencyGapDays(projectId, 0, owner);
});

test('возвраты: берутся только адреса своих контактов, служебные и ящик рассылки — нет', () => {
  const text = `Delivery Status Notification (Failure)
From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: box@gmail.com
Адрес не найден. Письмо не доставлено на ann@example.com, так как адрес не найден.
Also failed: stranger@example.org`;
  const preview = bounces.previewBounces(projectId, text);
  assert.deepEqual(preview.found.map((f) => f.email), ['ann@example.com']);
  assert.ok(preview.found[0].lastLetter, 'видно, какое письмо вернулось');
  assert.deepEqual(preview.notInBase, ['stranger@example.org']);
  assert.equal(preview.service, 2);

  bounces.applyBounces(projectId, preview.found.map((f) => f.contactId));
  assert.equal(db.prepare('SELECT status FROM mail_contacts WHERE id = ?').get(ids.ann).status, 'bounced');
  assert.ok(store.isSuppressed(projectId, 'ann@example.com'));
  assert.throws(() => bounces.previewBounces(projectId, '   '), /Вставьте текст/);
});
