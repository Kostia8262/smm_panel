/**
 * Проверки подключения Facebook кнопкой.
 *
 * Условие владельца 13.09.2026: кнопка не должна сломать бессрочные токены,
 * которые уже стоят у Facebook и Instagram. Отсюда тесты на то, что замена
 * не проходит, если делает хуже, и что прежние доступы всегда можно вернуть.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-fb-oauth-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const fb = await import('../src/oauth/facebook.js');
const threadsOauth = await import('../src/oauth/threads.js');
const projects = await import('../src/projects.js');

const FULL = [...fb.FACEBOOK_SCOPES, 'public_profile'];
const foreverNow = { pageId: '112815928085184', token: { valid: true, expiresAt: 0, scopes: FULL } };

function page(over = {}) {
  return {
    pageId: '112815928085184',
    name: 'Академія',
    pageToken: 'page-token',
    tasks: ['CREATE_CONTENT', 'MANAGE'],
    instagram: { id: '17841416616389603', username: 'mycomputer' },
    valid: true,
    expiresAt: 0,
    scopes: FULL,
    ...over,
  };
}

/* --------------------------- правила замены --------------------------- */

test('бессрочный на ту же страницу с теми же правами — можно', () => {
  const v = fb.checkReplacement(foreverNow, page());
  assert.equal(v.ok, true);
  assert.equal(v.needsConfirm, false);
});

test('бессрочный токен срочным не заменяем', () => {
  const v = fb.checkReplacement(foreverNow, page({ expiresAt: 1794472565 }));
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /срочный, а нынешний бессрочный/);
});

test('срочный токен не ставим даже вместо пустой карточки', () => {
  const v = fb.checkReplacement({}, page({ expiresAt: 1794472565 }));
  assert.equal(v.ok, false);
});

test('права не должны стать меньше, чем у нынешнего токена', () => {
  const v = fb.checkReplacement(foreverNow, page({ scopes: FULL.filter((s) => s !== 'instagram_manage_messages') }));
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /instagram_manage_messages/);
});

test('без прав на публикацию и удаление — не заменяем', () => {
  const v = fb.checkReplacement({}, page({ scopes: ['pages_show_list'] }));
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /pages_manage_posts/);
});

test('непроверенный токен вслепую не ставим', () => {
  const v = fb.checkReplacement(foreverNow, page({ valid: false }));
  assert.equal(v.ok, false);
});

test('без права публиковать на странице — не заменяем', () => {
  const v = fb.checkReplacement(foreverNow, page({ tasks: ['ANALYZE'] }));
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /CREATE_CONTENT/);
});

test('другая страница — только с подтверждением', () => {
  // Иначе посты школы молча уйдут на чужую страницу.
  const v = fb.checkReplacement(foreverNow, page({ pageId: '999' }));
  assert.equal(v.ok, true);
  assert.equal(v.needsConfirm, true);
});

test('нерабочий нынешний токен не мешает замене', () => {
  // Сломанный токен защищать незачем: его и чинят кнопкой.
  const broken = { pageId: '112815928085184', token: { valid: false, expiresAt: 0, scopes: FULL } };
  assert.equal(fb.checkReplacement(broken, page()).ok, true);
});

test('страница без Instagram — предупреждение, Instagram не трогаем', () => {
  const v = fb.checkReplacement(foreverNow, page({ instagram: null }));
  assert.equal(v.ok, true);
  assert.match(v.warnings.join(), /Instagram не тронем/);
});

/* ------------------------------- вход ------------------------------- */

test('с конфигурацией входа права задаёт она, без неё — список', () => {
  const withConfig = new URL(fb.authorizeUrl({ appId: '1', redirectUri: 'https://x/oauth/facebook', state: 's', configId: '42' }));
  assert.equal(withConfig.searchParams.get('config_id'), '42');
  assert.equal(withConfig.searchParams.get('scope'), null);
  assert.equal(withConfig.searchParams.get('response_type'), 'code');

  const plain = new URL(fb.authorizeUrl({ appId: '1', redirectUri: 'https://x/oauth/facebook', state: 's' }));
  for (const s of fb.REQUIRED_SCOPES) assert.ok(plain.searchParams.get('scope').split(',').includes(s));
});

test('ссылку возврата Threads не подсунуть подключению Facebook', () => {
  const state = threadsOauth.makeState({ projectId: 1, staffId: 1, platform: 'threads' });
  assert.throws(() => threadsOauth.readState(state, { staffId: 1, platform: 'facebook' }), /другой площадки/);
  assert.deepEqual(threadsOauth.readState(state, { staffId: 1, platform: 'threads' }), { projectId: 1 });
});

test('каждый токен страницы проверяется у Meta, а не берётся на слово', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });
    if (href.includes('grant_type=fb_exchange_token')) return reply({ access_token: 'long-user' });
    if (href.includes('/oauth/access_token')) return reply({ access_token: 'short-user' });
    if (href.includes('/me/accounts')) {
      return reply({
        data: [
          { id: '112815928085184', name: 'Академія', access_token: 'p1', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: '1784', username: 'mc' } },
          { id: '555', name: 'Дошколярик', access_token: 'p2', tasks: ['CREATE_CONTENT'] },
        ],
      });
    }
    if (href.includes('debug_token')) {
      const forever = href.includes('input_token=p1');
      return reply({ data: { is_valid: true, type: 'PAGE', expires_at: forever ? 0 : 1794472565, scopes: FULL } });
    }
    return reply({ error: { message: `неожиданный вызов ${href}` } });
  };

  const app = { appId: '1', appSecret: 'secret' };
  const userToken = await fb.exchangeCode({ ...app, redirectUri: 'https://x/oauth/facebook', code: 'c' });
  const pages = await fb.listPages(userToken, app);

  assert.equal(userToken, 'long-user');
  assert.equal(calls.filter((c) => c.includes('debug_token')).length, 2);
  assert.equal(pages[0].expiresAt, 0);
  assert.equal(pages[0].instagram.id, '1784');
  assert.equal(pages[1].instagram, null);
  assert.equal(fb.checkReplacement(foreverNow, pages[1]).ok, false, 'срочный токен второй страницы не пройдёт');
});

/* ------------------------- резервная копия ------------------------- */

let projectId;
before(() => {
  projectId = projects.createProject({ slug: 'fbbackup', title: 'Копии' }).id;
});

test('прежние доступы возвращаются из копии целиком, с датой выпуска', () => {
  projects.saveAccount(projectId, 'facebook', { pageId: '111', pageToken: 'old-forever'.padEnd(30, 'o'), appId: '1', appSecret: 's' });
  const issuedBefore = projects.tokenSavedAt(projectId, 'facebook');

  projects.backupAccount(projectId, 'facebook', 'перед подключением кнопкой');
  projects.saveAccount(projectId, 'facebook', { pageId: '222', pageToken: 'new-token'.padEnd(30, 'n') });
  assert.equal(projects.credentialsFor(projectId, 'facebook').pageId, '222');

  projects.restoreAccount(projectId, 'facebook');
  const back = projects.credentialsFor(projectId, 'facebook');
  assert.equal(back.pageId, '111');
  assert.match(back.pageToken, /^old-forever/);
  assert.equal(projects.tokenSavedAt(projectId, 'facebook'), issuedBefore);
});

test('откат тоже откатывается — перед ним сохраняется копия', () => {
  const before = projects.listBackups(projectId, 'facebook').length;
  projects.restoreAccount(projectId, 'facebook');
  assert.equal(projects.listBackups(projectId, 'facebook').length, before + 1);
});

test('без копий откат честно говорит, что нечего возвращать', () => {
  assert.throws(() => projects.restoreAccount(projectId, 'tiktok'), /нет резервных копий/);
});
