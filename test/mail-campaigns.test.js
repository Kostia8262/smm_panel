/**
 * Рассылка, фаза 3: письма.
 *
 * Главное здесь — обещания, нарушение которых увидит получатель:
 *   — утверждают ровно ту версию, что ушла пробным письмом;
 *   — правка после утверждения возвращает письмо в черновик;
 *   — пустое место под картинку и кнопка без ссылки не уходят в рассылку;
 *   — человек в двух базах получает одно письмо, отписавшийся — ни одного.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'smm-mail3-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.MAIL_MEDIA_DIR = join(dir, 'mail-media');
process.env.UPLOAD_DIR = join(dir, 'uploads');

const { db } = await import('../src/db.js');
const staff = await import('../src/staff.js');
const store = await import('../src/mail/store.js');
const senders = await import('../src/mail/sender/senders.js');
const campaigns = await import('../src/mail/campaigns.js');
const mailMedia = await import('../src/mail/compose/media.js');

let projectId;
let owner;
let smm;
let senderId;
let listA;
let listB;

/** Настоящий PNG заданного размера — чтобы размеры читались так же, как у загрузки. */
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function fakeFetch() {
  const sent = [];
  const fn = async (url, init = {}) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'A', expires_in: 3600 }) };
    if (String(url).includes('gmail.googleapis.com')) {
      sent.push(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8'));
      return { ok: true, status: 200, json: async () => ({ id: `g${sent.length}` }) };
    }
    throw new Error(`неожиданный запрос ${url}`);
  };
  fn.sent = sent;
  return fn;
}

before(() => {
  // Проект академии заводит сама миграция 007 — берём его, как на проде.
  projectId = db.prepare("SELECT id FROM projects WHERE slug = 'education'").get().id;
  owner = staff.create({ name: 'Власник', role: 'owner' });
  smm = staff.create({ name: 'Катя', role: 'smm' });
  senders.saveGoogleApp({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'secret' });
  senderId = senders.saveConnected({ email: 'box@gmail.com', refreshToken: 'r' }).id;

  listA = store.createList(projectId, { name: 'Учні', consentBasis: 'client' });
  listB = store.createList(projectId, { name: 'Батьки', consentBasis: 'event' });
  const both = store.addContactManually({ listId: listA.id, email: 'both@example.com' });
  store.bulk({ projectId, ids: [both.contactId], action: 'copy', targetListId: listB.id });
  store.addContactManually({ listId: listA.id, email: 'a@example.com' });
  const gone = store.addContactManually({ listId: listB.id, email: 'gone@example.com' });
  store.bulk({ projectId, ids: [gone.contactId], action: 'unsubscribe' });
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Временный каталог подчистит система.
  }
});

let campaignId;

test('новое письмо — с образца и с подключённым ящиком; неизвестные блоки отбрасываются', () => {
  const c = campaigns.createCampaign(projectId, { staffId: smm.id });
  campaignId = c.id;
  assert.equal(c.status, 'draft');
  assert.equal(c.senderId, senderId);
  assert.ok(c.blocks.some((b) => b.type === 'hero'), 'образец начинается с главной картинки');
  const cleaned = campaigns.sanitizeBlocks([{ type: 'script', text: 'x' }, { type: 'heading', text: 'Ок', evil: '<b>' }]);
  assert.deepEqual(cleaned.map((b) => b.type), ['heading']);
  assert.equal(cleaned[0].evil, undefined);
});

test('аудитория: человек в двух базах — одно письмо, отписавшийся не считается', () => {
  const c = campaigns.updateCampaign(campaignId, { lists: { include: [listA.id, listB.id], exclude: [] } });
  const aud = campaigns.audience(c);
  assert.equal(aud.recipients, 2, 'both@ и a@ — по одному письму');
  assert.equal(aud.unsubscribed, 1);
  const excluded = campaigns.updateCampaign(campaignId, { lists: { include: [listA.id], exclude: [listB.id] } });
  assert.equal(campaigns.audience(excluded).recipients, 1, 'исключённая база убирает both@');
});

test('пустое место под картинку и кнопка без ссылки — блокеры', () => {
  const c = campaigns.updateCampaign(campaignId, {
    subject: 'Новий набір',
    blocks: [
      { type: 'hero' },
      { type: 'heading', text: 'Заголовок' },
      { type: 'text', text: 'Текст {{city}}' },
      { type: 'button', text: 'Записатися', href: 'javascript:alert(1)' },
    ],
  });
  const { blockers } = campaigns.checkCampaign(c);
  assert.ok(blockers.some((b) => /Главная картинка/.test(b)));
  assert.ok(blockers.some((b) => /без ссылки/.test(b)));
  assert.ok(blockers.some((b) => /\{\{city\}\}/.test(b)));
});

test('картинка: только JPEG/PNG по содержимому, пропорции предупреждают', () => {
  assert.throws(() => mailMedia.saveImage(campaignId, { buffer: Buffer.from('<svg/>') }), /JPEG или PNG/);
  const wrong = mailMedia.saveImage(campaignId, { buffer: png(1200, 900), originalName: 'hero.png' });
  const c = campaigns.updateCampaign(campaignId, {
    blocks: [
      { type: 'hero', mediaId: wrong.id, alt: 'Діти за ноутбуками' },
      { type: 'heading', text: 'Заголовок' },
      { type: 'text', text: 'Текст для {{name|Дорогий підписнику}}' },
      { type: 'button', text: 'Записатися', href: 'https://mycomputer.education' },
    ],
    preheader: 'Прехедер',
  });
  const check = campaigns.checkCampaign(c);
  assert.deepEqual(check.blockers, []);
  assert.ok(check.warnings.some((w) => /пропорции/.test(w)));

  const right = mailMedia.saveImage(campaignId, { buffer: png(1200, 600) });
  const fixed = campaigns.updateCampaign(campaignId, { blocks: c.blocks.map((b) => (b.type === 'hero' ? { ...b, mediaId: right.id } : b)) });
  assert.ok(!campaigns.checkCampaign(fixed).warnings.some((w) => /пропорции/.test(w)));

  const preview = campaigns.buildLetter(fixed, { mode: 'preview' });
  assert.match(preview.html, /src="data:image\/png;base64,/);
  const send = campaigns.buildLetter(fixed, { mode: 'send' });
  assert.match(send.html, /src="cid:m\d+\.\d+@mail\.panel"/);
  assert.equal(send.inline.length, 1);
});

test('утвердить можно только версию, ушедшую пробным письмом', async () => {
  assert.throws(() => campaigns.approveCampaign(campaignId, owner), /пробное письмо этой версии/);

  const fetchImpl = fakeFetch();
  const result = await campaigns.sendCampaignTest(campaignId, { staffId: smm.id, publicBase: 'https://smm.example', fetchImpl, projectId });
  assert.equal(result.sent.length, 1);
  const letter = fetchImpl.sent[0];
  assert.match(letter, /Subject: =\?UTF-8\?B\?/);
  assert.match(letter, /Content-Type: multipart\/related/, 'картинка вложена в письмо');
  assert.match(letter, /Content-ID: <m\d+\.\d+@mail\.panel>/);
  assert.ok(campaigns.getCampaign(campaignId).testedCurrent);
});

test('СММщик отправляет на согласование, владелец утверждает', () => {
  const inReview = campaigns.submitCampaign(campaignId, smm);
  assert.equal(inReview.status, 'review');
  const approved = campaigns.approveCampaign(campaignId, owner);
  assert.equal(approved.status, 'approved');
  assert.equal(db.prepare('SELECT approved_hash, content_hash FROM mail_campaigns WHERE id = ?').get(campaignId).approved_hash, approved.contentHash);
});

test('правка текста после утверждения возвращает в черновик, смена баз — нет', () => {
  const listsOnly = campaigns.updateCampaign(campaignId, { lists: { include: [listA.id, listB.id], exclude: [] } });
  assert.equal(listsOnly.status, 'approved', 'базы не входят в отпечаток письма');
  const edited = campaigns.updateCampaign(campaignId, { subject: 'Новий набір — оновлено' });
  assert.equal(edited.status, 'draft');
  assert.equal(edited.testedCurrent, false, 'пробное письмо было другой версии');
  assert.equal(db.prepare('SELECT approved_hash FROM mail_campaigns WHERE id = ?').get(campaignId).approved_hash, null);
});

test('возврат на доработку — только с причиной', () => {
  assert.throws(() => campaigns.rejectCampaign(campaignId, owner, ''), /что поправить/);
});

test('копия письма ссылается на те же файлы картинок и те же базы', () => {
  const copy = campaigns.copyCampaign(campaignId, { staffId: owner.id });
  const hero = copy.blocks.find((b) => b.type === 'hero');
  assert.ok(hero.mediaId && copy.media[hero.mediaId], 'картинка копии указывает на свою строку');
  const original = campaigns.getCampaign(campaignId);
  const originalHero = original.blocks.find((b) => b.type === 'hero');
  assert.equal(copy.media[hero.mediaId].name, original.media[originalHero.mediaId].name, 'файл общий — строки разные');
  assert.equal(copy.lists.include.length, original.lists.include.length);
  assert.equal(copy.status, 'draft');
});

test('письмо чужой школы не открывается через текущую', () => {
  db.exec("INSERT INTO projects (slug, title, position) VALUES ('other', 'Інша', 2)");
  const otherId = db.prepare("SELECT id FROM projects WHERE slug = 'other'").get().id;
  assert.throws(() => campaigns.getCampaign(campaignId, otherId), /не найдено/);
});
