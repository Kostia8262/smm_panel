/**
 * Звуки в тренде: доска трендов и путь «тренд → идея → пост».
 *
 * Звук — единственный тренд, который доезжает до поста данными, а не словами:
 * если на этом пути трек потеряется, СММщику придётся искать его заново, и
 * тот самый трендовый звук легко перепутать с похожим.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-sounds-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const plan = await import('../src/plan.js');
const { collectTrendingSounds } = await import('../src/trends/sounds.js');

let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'sounds', title: 'Звуки' }).id;
  projects.saveAccount(projectId, 'instagram', { userId: '1784', pageToken: 'page-token' });
});

const trending = {
  music: [
    { id: '1581803845934560', type: 'music', title: 'Romantic', artist: 'Sugartapes', durationMs: 21000, cover: 'https://static.xx.fbcdn.net/c.jpg', previewUrl: 'https://scontent.fbcdn.net/t.mp4' },
    { id: '526722002234207', type: 'music', title: 'Black And Proud', artist: 'Afro Sound Machine', durationMs: 173000 },
    { id: '778970595015596', type: 'music', title: 'Mothership', artist: 'The Sheen' },
  ],
  original_sound: [
    { id: '27989644220656167', type: 'original_sound', title: 'Оригинал', username: 'demaimp', pageUrl: 'https://www.instagram.com/reels/audio/27989644220656167/' },
  ],
};
const search = async (_creds, { type }) => ({ items: trending[type], after: null });

const soundTrends = () =>
  db.prepare("SELECT * FROM trends WHERE project_id = ? AND source = 'ig_audio' ORDER BY id").all(projectId);

test('сбор кладёт первые места каждого типа, повтор освежает, а не копирует', async () => {
  const first = await collectTrendingSounds(projectId, { perType: 2, search });
  assert.deepEqual({ added: first.added, refreshed: first.refreshed }, { added: 3, refreshed: 0 });

  const rows = soundTrends();
  assert.equal(rows.length, 3);
  const top = rows[0];
  assert.equal(top.platform, 'instagram');
  assert.match(top.title, /^Звук: «Romantic» — Sugartapes$/);
  assert.match(top.metric, /№1 в тренде · музыка/);
  const audio = JSON.parse(top.audio);
  assert.equal(audio.id, '1581803845934560');
  assert.equal(audio.previewUrl, undefined, 'ссылку на прослушку не храним — она живёт полтора дня');
  assert.equal(rows[2].url, trending.original_sound[0].pageUrl);

  const second = await collectTrendingSounds(projectId, { perType: 2, search });
  assert.deepEqual({ added: second.added, refreshed: second.refreshed }, { added: 0, refreshed: 3 });
  assert.equal(soundTrends().length, 3);
});

test('звук, не встречавшийся неделю, уходит в архив, а взятый в план — остаётся', async () => {
  const [stale, used] = soundTrends();
  db.prepare("UPDATE trends SET captured_at = datetime('now', '-8 days') WHERE id IN (?, ?)").run(stale.id, used.id);
  db.prepare('UPDATE trends SET used_count = 1 WHERE id = ?').run(used.id);

  const report = await collectTrendingSounds(projectId, { perType: 0, search });
  assert.equal(report.archived, 1);
  const byId = Object.fromEntries(soundTrends().map((r) => [r.id, r.archived]));
  assert.equal(byId[stale.id], 1);
  assert.equal(byId[used.id], 0);
});

test('без Instagram у проекта — понятный отказ', async () => {
  const bare = projects.createProject({ slug: 'bare', title: 'Без сетей' }).id;
  await assert.rejects(() => collectTrendingSounds(bare, { search }), /не подключён Instagram/);
});

test('тренд → идея → пост: цель Instagram становится Reels и получает тот же звук', async () => {
  const trend = plan.listTrends({ projectId }).find((t) => t.source === 'ig_audio' && t.audio?.type === 'original_sound');
  assert.ok(trend, 'тренд со звуком виден на доске');
  assert.equal(trend.audio.username, 'demaimp');

  const item = plan.createPlanItem(
    { title: trend.title, idea: trend.summary, platforms: ['instagram', 'telegram'], trendId: trend.id, projectId },
    null
  );
  const { postId } = plan.planToPost(item.id, { db, staffId: null });

  const targets = db.prepare('SELECT platform, format_id, audio FROM post_targets WHERE post_id = ? ORDER BY platform').all(postId);
  const ig = targets.find((t) => t.platform === 'instagram');
  assert.equal(ig.format_id, 'reels');
  assert.equal(JSON.parse(ig.audio).id, '27989644220656167');
  assert.equal(targets.find((t) => t.platform === 'telegram').audio, null, 'звук только у Instagram');
  assert.equal(targets.filter((t) => t.platform === 'instagram').length, 1, 'вторая цель Instagram не появляется');
});
