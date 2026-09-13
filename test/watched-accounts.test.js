/**
 * Аккаунты, за которыми следим.
 *
 * Главное, что здесь проверяется: сигнал на доску трендов даёт пост, набравший
 * в разы больше обычного для того же аккаунта, и даёт его один раз. Если это
 * сломается, доска либо молчит, либо каждое утро засыпается одними и теми же
 * постами — и её перестают открывать.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-watch-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const watch = await import('../src/trends/accounts.js');

let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'watch', title: 'Наблюдение' }).id;
  projects.saveAccount(projectId, 'instagram', { userId: '1784', pageToken: 'page-token' });
});

test('аккаунт узнаётся из @имени, имени и ссылки — в том числе на пост', () => {
  assert.equal(watch.parseAccount('instagram', '@It_Step.Kyiv'), 'it_step.kyiv');
  assert.equal(watch.parseAccount('instagram', 'https://www.instagram.com/itstep_kyiv/'), 'itstep_kyiv');
  assert.equal(watch.parseAccount('instagram', 'instagram.com/itstep_kyiv?igsh=abc'), 'itstep_kyiv');
  assert.equal(watch.parseAccount('tiktok', 'https://www.tiktok.com/@school.code/video/123'), 'school.code');
  assert.equal(watch.parseAccount('threads', 'https://www.threads.com/@mycomp'), 'mycomp');
  assert.equal(watch.parseAccount('telegram', 't.me/it_news_ua'), 'it_news_ua');
  assert.equal(watch.parseAccount('facebook', 'https://www.facebook.com/profile.php?id=10009'), '10009');

  assert.throws(() => watch.parseAccount('instagram', 'https://www.tiktok.com/@x'), /не на Instagram/);
  assert.throws(() => watch.parseAccount('instagram', 'два слова'), /Не похоже на аккаунт/);
  assert.throws(() => watch.parseAccount('instagram', ''), /Не указан/);
  assert.throws(() => watch.parseAccount('vk', 'x'), /не поддерживается/);
});

test('один аккаунт — одна строка на школу', () => {
  watch.addAccount(projectId, { platform: 'tiktok', username: '@dupe.check' });
  assert.throws(() => watch.addAccount(projectId, { platform: 'tiktok', username: 'https://tiktok.com/@dupe.check' }), /уже следим/);
});

/** Graph API по сценарию: подписчики и посты чужого аккаунта. */
function graph({ followers = 5000, media = [], error = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(String(url)));
    if (error) return { ok: false, status: 400, json: async () => ({ error }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        business_discovery: { username: 'rival', name: 'Rival School', followers_count: followers, media_count: 300, media: { data: media } },
      }),
    };
  };
  return { fetchImpl, calls };
}

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().replace(/\.\d{3}Z$/, '+0000');
const reel = (id, views, age) => ({
  id,
  caption: `ролик ${id}`,
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  timestamp: daysAgo(age),
  permalink: `https://www.instagram.com/reel/${id}/`,
  like_count: Math.round(views / 50),
  comments_count: 3,
  view_count: views,
});

test('сбор: подписчики и посты ложатся, взлетевший Reels — сигнал один раз', async () => {
  const id = watch.addAccount(projectId, { platform: 'instagram', username: 'rival', kind: 'competitor' });
  const account = db.prepare('SELECT * FROM watched_accounts WHERE id = ?').get(id);
  const media = [reel('hit', 90000, 1), ...[2, 3, 4, 5, 6, 8].map((d, i) => reel(`r${i}`, 10000 + i * 500, d))];
  const { fetchImpl, calls } = graph({ media });
  const creds = { userId: '1784', pageToken: 'page-token' };

  const signals = await watch.collectInstagram(account, creds, { fetchImpl });
  assert.equal(signals, 1, 'выше обычного в разы только один ролик');
  assert.match(calls[0].searchParams.get('fields'), /business_discovery\.username\(rival\)/);

  const saved = db.prepare('SELECT followers, last_error FROM watched_accounts WHERE id = ?').get(id);
  assert.deepEqual({ ...saved }, { followers: 5000, last_error: null });
  const post = db.prepare("SELECT posted_at, views, signaled FROM watched_posts WHERE external_id = 'hit'").get();
  assert.match(post.posted_at, /Z$/, 'время приведено к ISO');
  assert.equal(post.signaled, 1);

  const trend = db.prepare("SELECT * FROM trends WHERE source = 'watched' AND project_id = ?").get(projectId);
  assert.match(trend.title, /^@rival: Reels набрал ×\d/);
  assert.equal(trend.url, 'https://www.instagram.com/reel/hit/');

  const again = await watch.collectInstagram(account, creds, { fetchImpl });
  assert.equal(again, 0, 'повторный обход тот же пост на доску не кладёт');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trends WHERE source = 'watched'").get().n, 1);
});

test('пока постов мало, «обычного» нет — и сигналов нет', async () => {
  const id = watch.addAccount(projectId, { platform: 'instagram', username: 'fresh.account' });
  const account = db.prepare('SELECT * FROM watched_accounts WHERE id = ?').get(id);
  const { fetchImpl } = graph({ media: [reel('a', 100000, 1), reel('b', 1000, 2), reel('c', 1000, 3)] });
  assert.equal(await watch.collectInstagram(account, { userId: '1', pageToken: 't' }, { fetchImpl }), 0);
});

test('не бизнес-аккаунт — понятная причина в карточке, а не код ошибки', async () => {
  const id = watch.addAccount(projectId, { platform: 'instagram', username: 'private.person' });
  const account = db.prepare('SELECT * FROM watched_accounts WHERE id = ?').get(id);
  const { fetchImpl } = graph({ error: { message: 'Invalid user id', code: 110 } });
  await assert.rejects(() => watch.collectInstagram(account, { userId: '1', pageToken: 't' }, { fetchImpl }), /только бизнес- и авторских/);
  assert.match(db.prepare('SELECT last_error FROM watched_accounts WHERE id = ?').get(id).last_error, /не бизнес-аккаунт/);
});

test('экран: прирост за неделю, лучшие посты месяца, у Threads — увиденное расширением', () => {
  const rival = db.prepare("SELECT id FROM watched_accounts WHERE username = 'rival'").get().id;
  db.prepare("INSERT INTO watched_snapshots (account_id, observed_on, followers) VALUES (?, date('now', '-8 days'), 4700)").run(rival);

  watch.addAccount(projectId, { platform: 'threads', username: '@seen.threads', kind: 'inspiration', note: 'подача' });
  db.prepare(
    `INSERT INTO observed_posts (project_id, platform, external_id, username, text, likes, comments, score, per_hour, label)
     VALUES (?, 'threads', 't1', 'Seen.Threads', 'пост из ленты', 120, 8, 40, 5, 'hot')`
  ).run(projectId);

  const list = watch.listAccounts(projectId);
  const ig = list.find((a) => a.username === 'rival');
  assert.equal(ig.growth, 300);
  assert.equal(ig.topPosts[0].externalId, 'hit', 'первым — взлетевший');
  assert.ok(ig.topPosts[0].ratio >= 3);
  assert.equal(ig.profileUrl, 'https://www.instagram.com/rival/');

  const th = list.find((a) => a.platform === 'threads');
  assert.equal(th.seen, 1);
  assert.equal(th.topPosts[0].caption, 'пост из ленты');
  assert.equal(th.kindTitle, 'Образец подачи');
  assert.equal(th.mode, 'extension');
});

test('обход проекта идёт только по Instagram и без доступа честно отказывает', async () => {
  const bare = projects.createProject({ slug: 'watch-bare', title: 'Без Instagram' }).id;
  assert.deepEqual(await watch.collectAccounts(bare), { checked: 0, signals: 0, failed: [] }, 'нечего проверять — не ошибка');
  watch.addAccount(bare, { platform: 'instagram', username: 'someone' });
  await assert.rejects(() => watch.collectAccounts(bare), /не подключён Instagram/);
});
