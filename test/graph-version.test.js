/**
 * Версия Graph API — одна на всю панель.
 *
 * 13.09.2026 переезд с v21.0 на v26.0 начался с поиска номера в восьми местах.
 * Тест держит договорённость: номер живёт только в `src/platforms/graph.js`,
 * и все вызовы Facebook и Instagram идут через него.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRAPH_VERSION, GRAPH_API, RUPLOAD_API, LOGIN_DIALOG } from '../src/platforms/graph.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

test('номер версии вида vNN.0 и одинаков во всех адресах', () => {
  assert.match(GRAPH_VERSION, /^v\d+\.0$/);
  assert.equal(GRAPH_API, `https://graph.facebook.com/${GRAPH_VERSION}`);
  assert.equal(RUPLOAD_API, `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}`);
  assert.equal(LOGIN_DIALOG, `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
});

test('номер версии Facebook не вписан в код мимо graph.js', () => {
  const pinned = /(graph|rupload|www)\.facebook\.com\/(video-upload\/)?v\d+\.\d/;
  const offenders = [...sources(join(root, 'src')), ...sources(join(root, 'tools'))]
    .filter((path) => !path.endsWith(join('platforms', 'graph.js')))
    .filter((path) => pinned.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path));
  assert.deepEqual(offenders, [], 'версию брать из src/platforms/graph.js');
});

test('адаптеры и вход ходят на версию из graph.js', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: '1', name: 'x', username: 'x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const facebook = await import('../src/platforms/facebook.js');
    const instagram = await import('../src/platforms/instagram.js');
    const oauth = await import('../src/oauth/facebook.js');
    await facebook.check({ pageId: '1', pageToken: 't' });
    await instagram.check({ userId: '2', pageToken: 't' });
    const login = oauth.authorizeUrl({ appId: '3', redirectUri: 'https://example.com/cb', state: 's' });
    assert.ok(calls.length >= 2);
    for (const url of calls) assert.ok(url.startsWith(`${GRAPH_API}/`), url);
    assert.ok(login.startsWith(`${LOGIN_DIALOG}?`), login);
  } finally {
    globalThis.fetch = realFetch;
  }
});
