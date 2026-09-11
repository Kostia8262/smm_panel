/**
 * Проверки подмены ссылок.
 *
 * Тут легко навредить молча: испортив чужую ссылку, съев точку в конце
 * предложения или затерев метку, которую поставили руками. Каждый такой
 * случай — отдельный тест.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-links-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const links = await import('../src/links.js');

const OWN = ['mycomputer.education', 'mycomputer.school'];
const BASE = 'https://smm.mycomputer.education';

let post;

before(() => {
  const projectId = projects.createProject({ slug: 'links', title: 'Ссылки' }).id;
  const info = db
    .prepare(
      `INSERT INTO posts (title, body, status, scheduled_at, project_id)
       VALUES ('тест', '', 'scheduled', '2026-09-20 10:00:00', ?)`
    )
    .run(projectId);
  post = { id: Number(info.lastInsertRowid), project_id: projectId, scheduled_at: '2026-09-20 10:00:00' };
});

const shorten = (text, platform = 'telegram') =>
  links.shortenLinks(text, { post, platform, baseUrl: BASE, ownDomains: OWN });

test('наша ссылка подменяется короткой', () => {
  const out = shorten('Записаться: https://mycomputer.education/python');
  assert.match(out, /https:\/\/smm\.mycomputer\.education\/r\/[\w-]+/);
  assert.ok(!out.includes('/python'), 'исходный адрес прячется за короткой ссылкой');
});

test('целевой адрес получает метки, а площадка попадает в источник', () => {
  shorten('https://mycomputer.school/design', 'instagram');
  const row = db.prepare('SELECT * FROM links ORDER BY id DESC LIMIT 1').get();
  const url = new URL(row.target_url);
  assert.equal(url.searchParams.get('utm_source'), 'instagram');
  assert.equal(url.searchParams.get('utm_medium'), 'social');
  assert.match(url.searchParams.get('utm_campaign'), /^smm-20260920-p\d+$/);
});

test('чужая ссылка остаётся нетронутой', () => {
  const text = 'Подробности тут: https://example.com/article';
  assert.equal(shorten(text), text, 'метки на чужом домене бессмысленны');
});

test('точка в конце предложения не съедается', () => {
  const out = shorten('Сайт: https://mycomputer.education.');
  assert.ok(out.endsWith('.'), 'точка принадлежит предложению, а не адресу');
  const row = db.prepare('SELECT * FROM links ORDER BY id DESC LIMIT 1').get();
  assert.ok(!row.target_url.includes('education./'), 'адрес не должен содержать точку предложения');
});

test('проставленная вручную метка не затирается', () => {
  shorten('https://mycomputer.education/?utm_source=afisha&utm_campaign=sept');
  const row = db.prepare('SELECT * FROM links ORDER BY id DESC LIMIT 1').get();
  const url = new URL(row.target_url);
  assert.equal(url.searchParams.get('utm_source'), 'afisha', 'ручная метка важнее нашей');
  assert.equal(url.searchParams.get('utm_campaign'), 'sept');
});

test('переходы считаются по площадкам', () => {
  const fresh = db.prepare('SELECT * FROM links WHERE post_id = ? LIMIT 1').get(post.id);
  links.registerClick(fresh.id, { userAgent: 'test' });
  links.registerClick(fresh.id, { userAgent: 'test' });

  const stats = links.clicksForPost(post.id);
  assert.ok(stats.total >= 2);
  assert.ok(stats.byPlatform[fresh.platform] >= 2);
});

test('несколько ссылок в одном посте делят одну кампанию', () => {
  const out = shorten('Раз https://mycomputer.education/a и два https://mycomputer.school/b');
  const codes = [...out.matchAll(/\/r\/([\w-]+)/g)].map((m) => m[1]);
  assert.equal(codes.length, 2, 'подменились обе');
  const rows = codes.map((c) => links.findByCode(c));
  assert.equal(rows[0].campaign, rows[1].campaign, 'кампания у поста одна');
});
