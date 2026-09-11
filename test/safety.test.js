/**
 * Проверки того, что охраняет доступы и данные.
 *
 * Каждый тест здесь повторяет случай, который уже случался или был близок:
 * токен в открытом виде, чужие доступы в соседнем проекте, проверка поста,
 * пропускающая PNG в Instagram.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-safety-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const { encrypt, decrypt } = await import('../src/secrets.js');
const projects = await import('../src/projects.js');
const { validatePost } = await import('../src/validate.js');

let a;
let b;

before(() => {
  a = projects.createProject({ slug: 'alpha', title: 'Альфа' }).id;
  b = projects.createProject({ slug: 'beta', title: 'Бета' }).id;
});

test('шифрование возвращает исходное значение', () => {
  const secret = 'bot-token-123:ABCdef';
  const box = encrypt(secret);
  assert.notEqual(box, secret);
  assert.equal(decrypt(box), secret);
});

test('в базе не остаётся открытого токена', () => {
  projects.saveAccount(a, 'telegram', { botToken: 'СЕКРЕТ-В-ОТКРЫТУЮ', chatId: '@alpha' });
  const row = db.prepare('SELECT config FROM project_accounts WHERE project_id = ?').get(a);
  assert.ok(!row.config.includes('СЕКРЕТ-В-ОТКРЫТУЮ'), 'токен обязан лежать шифротекстом');
  assert.equal(projects.credentialsFor(a, 'telegram').botToken, 'СЕКРЕТ-В-ОТКРЫТУЮ');
});

test('доступы одного проекта не видны другому', () => {
  assert.equal(projects.credentialsFor(b, 'telegram').botToken, undefined);
  assert.equal(projects.accountStatus(a, 'telegram').configured, true);
  assert.equal(projects.accountStatus(b, 'telegram').configured, false);
});

test('наружу отдаётся только хвост секрета', () => {
  const status = projects.accountStatus(a, 'telegram');
  const tokenField = status.fields.find((f) => f.key === 'botToken');
  assert.ok(tokenField.filled);
  assert.ok(!tokenField.preview.includes('СЕКРЕТ'), 'полный секрет в интерфейс не уходит');
  // Ненесекретное поле показываем целиком: id канала полезно видеть.
  assert.equal(status.fields.find((f) => f.key === 'chatId').preview, '@alpha');
});

test('пустое поле означает «не менять», а не «стереть»', () => {
  projects.saveAccount(a, 'telegram', { botToken: '', chatId: '@alpha-new' });
  const creds = projects.credentialsFor(a, 'telegram');
  assert.equal(creds.botToken, 'СЕКРЕТ-В-ОТКРЫТУЮ', 'старый токен должен уцелеть');
  assert.equal(creds.chatId, '@alpha-new');
});

test('PNG в Instagram не пропускается', () => {
  const post = {
    body: 'текст',
    media: [{ id: 1, kind: 'image', mime: 'image/png', bytes: 1000, original_name: 'a.png' }],
    targets: [{ platform: 'instagram', format_id: 'feed-portrait' }],
  };
  const result = validatePost(post);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => /PNG/i.test(b.message)));
});

test('длинный текст блокируется для Threads и проходит для Telegram', () => {
  const long = 'я'.repeat(600);
  const threads = validatePost({ body: long, media: [], targets: [{ platform: 'threads', format_id: 'square' }] });
  assert.equal(threads.ok, false, '600 знаков в Threads не влезают');

  const telegram = validatePost({ body: long, media: [], targets: [{ platform: 'telegram', format_id: 'any' }] });
  assert.equal(telegram.ok, true, 'в Telegram 600 знаков — норма');
});
