/**
 * Проверки подключения Threads кнопкой.
 *
 * Две вещи, ради которых подключение и переделано, и одна, без которой его
 * опасно выкатывать:
 *   — в ссылке на согласие есть право на удаление: генератор токенов в
 *     кабинете Meta его не выдавал, и три токена подряд не умели снимать посты;
 *   — ID аккаунта берётся у площадки строкой, а не у человека;
 *   — чужой код не привяжет к школе чужой аккаунт: `state` не подделать и не
 *     передать другому сотруднику.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-oauth-'));
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const oauth = await import('../src/oauth/threads.js');

/* --------------------------------- state --------------------------------- */

test('state возвращает проект тому же сотруднику', () => {
  const state = oauth.makeState({ projectId: 3, staffId: 1 });
  assert.deepEqual(oauth.readState(state, { staffId: 1 }), { projectId: 3 });
});

test('подделанный state отвергается', () => {
  const state = oauth.makeState({ projectId: 3, staffId: 1 });
  // Переписать проект в шифротексте нельзя: AES-GCM проверяет целостность.
  const parts = state.split(':');
  parts[3] = Buffer.from('{"p":4,"s":1,"t":0}').toString('base64url');
  assert.throws(() => oauth.readState(parts.join(':'), { staffId: 1 }), /повреждена или подделана/);
  assert.throws(() => oauth.readState('что-угодно', { staffId: 1 }), /повреждена или подделана/);
});

test('state другого сотрудника не принимается', () => {
  // Иначе ссылку возврата, начатую одним человеком, мог бы завершить другой.
  const state = oauth.makeState({ projectId: 3, staffId: 1 });
  assert.throws(() => oauth.readState(state, { staffId: 2 }), /другим сотрудником/);
});

test('устаревший state не принимается', () => {
  const state = oauth.makeState({ projectId: 3, staffId: 1 }, Date.now() - 16 * 60 * 1000);
  assert.throws(() => oauth.readState(state, { staffId: 1 }), /устарела/);
});

/* ---------------------------- ссылка на согласие ---------------------------- */

test('ссылка просит право на удаление и поиск явно', () => {
  const url = new URL(oauth.authorizeUrl({ appId: '1953688268635017', redirectUri: 'https://smm.example/oauth/threads', state: 's' }));
  const scopes = url.searchParams.get('scope').split(',');
  for (const s of ['threads_basic', 'threads_content_publish', 'threads_delete', 'threads_keyword_search']) {
    assert.ok(scopes.includes(s), `нет ${s}`);
  }
  assert.equal(url.searchParams.get('client_id'), '1953688268635017');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://smm.example/oauth/threads');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

/* ------------------------------- обмен кода ------------------------------- */

const realFetch = globalThis.fetch;

function fakeThreads({ scopes = oauth.THREADS_SCOPES, failAt = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ href, body });
    const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data });

    if (href.endsWith('/oauth/access_token')) {
      return failAt === 'code' ? reply({ error: { message: 'Invalid verification code' } }, false) : reply({ access_token: 'short' });
    }
    if (href.includes('th_exchange_token')) return reply({ access_token: 'long-token', expires_in: 5183944 });
    // ID строкой, как отдаёт площадка: числом он больше MAX_SAFE_INTEGER.
    if (href.includes('/me?')) return reply({ id: '29062313960036757', username: 'my_computer_academy_' });
    if (href.includes('debug_token')) return reply({ data: { scopes } });
    return reply({ error: { message: `неожиданный вызов ${href}` } }, false);
  };
  return calls;
}

const exchangeArgs = { appId: '1953688268635017', appSecret: 'secret', redirectUri: 'https://smm.example/oauth/threads' };

test('код меняется на долгий токен, ID и права берутся у площадки', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeThreads();

  const out = await oauth.exchangeCode({ ...exchangeArgs, code: 'abc' });
  assert.equal(out.accessToken, 'long-token');
  assert.equal(out.userId, '29062313960036757');
  assert.equal(typeof out.userId, 'string');
  assert.deepEqual(out.missing, []);
});

test('хвост «#_» у кода срезается', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads();
  await oauth.exchangeCode({ ...exchangeArgs, code: 'abc#_' });
  assert.equal(calls[0].body.code, 'abc');
});

test('снятая галочка удаления видна сразу, а не при первой попытке удалить', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeThreads({ scopes: ['threads_basic', 'threads_content_publish'] });
  const out = await oauth.exchangeCode({ ...exchangeArgs, code: 'abc' });
  assert.deepEqual(out.missing, ['threads_delete']);
});

test('отказ площадки называет шаг, на котором сломалось', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeThreads({ failAt: 'code' });
  await assert.rejects(() => oauth.exchangeCode({ ...exchangeArgs, code: 'bad' }), /обмен кода: Invalid verification code/);
});
