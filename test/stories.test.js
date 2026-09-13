/**
 * Сторис-серии и видео в очереди.
 *
 * Три дыры, найденные 13.09.2026:
 *   — несколько кадров с форматом «Stories» уходили в Instagram каруселью,
 *     причём в ленту, с подписью;
 *   — у Facebook сторис не было вовсе, хотя API у страницы есть;
 *   — параллельная публикация без присмотра объявила бы долгую серию
 *     зависшей и выпустила её повторно.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-stories-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.UPLOAD_DIR = join(dir, 'uploads');
process.env.THUMB_DIR = join(dir, 'thumbs');
process.env.PUBLIC_BASE_URL = 'https://smm.example';
mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { db, getPost } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const schedule = await import('../src/schedule.js');
const instagram = await import('../src/platforms/instagram.js');
const facebook = await import('../src/platforms/facebook.js');
const { publishPost, partsOf } = await import('../src/queue/publish.js');
const { recoverStuck } = await import('../src/queue/recover.js');

const realFetch = globalThis.fetch;
const noop = () => {};
let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'stories', title: 'Сторис' }).id;
  projects.saveAccount(projectId, 'instagram', { userId: '17841', pageToken: 'page'.padEnd(30, 'p') });
  projects.saveAccount(projectId, 'facebook', { pageId: '1128', pageToken: 'page'.padEnd(30, 'p') });
});

after(() => {
  globalThis.fetch = realFetch;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // База может быть ещё занята — временный каталог подчистит система.
  }
});

function makePost(names, targets) {
  const postId = Number(
    db
      .prepare("INSERT INTO posts (title, body, status, scheduled_at, project_id) VALUES ('т', 'текст', 'scheduled', datetime('now'), ?)")
      .run(projectId).lastInsertRowid
  );
  const ids = names.map((name, i) => {
    writeFileSync(join(process.env.UPLOAD_DIR, name), 'x');
    return Number(
      db
        .prepare(
          `INSERT INTO media (post_id, kind, original_name, stored_name, mime, bytes, width, height, position)
           VALUES (?, 'image', ?, ?, 'image/jpeg', 1, 1080, 1920, ?)`
        )
        .run(postId, name, name, i).lastInsertRowid
    );
  });
  for (const t of targets) {
    db.prepare('INSERT INTO post_targets (post_id, platform, format_id, media_ids) VALUES (?, ?, ?, ?)').run(
      postId,
      t.platform,
      t.format_id,
      t.pick ? JSON.stringify(t.pick(ids)) : null
    );
  }
  return { postId, ids };
}

/** Graph API Instagram по сценарию: `failPublishAt` — какой по счёту media_publish отказать. */
function fakeInstagram({ failPublishAt = null } = {}) {
  const calls = [];
  let container = 0;
  let publishes = 0;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ href, body });
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });
    if (href.includes('fields=status_code')) return reply({ status_code: 'FINISHED' });
    if (href.endsWith('/media_publish')) {
      publishes += 1;
      if (publishes === failPublishAt) return reply({ error: { message: 'временный отказ' } });
      return reply({ id: `ig-${body.creation_id}` });
    }
    if (href.endsWith('/media')) return reply({ id: `c${++container}` });
    return reply({ error: { message: `неожиданный вызов ${href}` } });
  };
  return calls;
}

test('Instagram: серия сторис — отдельная публикация на кадр, не карусель', async () => {
  const calls = fakeInstagram();
  const { postId } = makePost(['s1.jpg', 's2.jpg', 's3.jpg'], [{ platform: 'instagram', format_id: 'story' }]);

  const out = await publishPost(postId);

  assert.equal(out.status, 'published');
  const creates = calls.filter((c) => c.href.endsWith('/media'));
  assert.equal(creates.length, 3, 'три контейнера — три сторис');
  assert.ok(creates.every((c) => c.body.media_type === 'STORIES'));
  assert.ok(!calls.some((c) => c.body.media_type === 'CAROUSEL'), 'карусели быть не должно');
  assert.deepEqual(creates.map((c) => c.body.image_url.split('/').pop()), ['s1.jpg', 's2.jpg', 's3.jpg'], 'по порядку');
  assert.ok(creates.every((c) => c.body.caption === undefined), 'у сторис нет подписи');

  const target = getPost(postId).targets[0];
  assert.equal(partsOf(target).length, 3);
  assert.equal(target.external_id, 'ig-c1');
});

test('упавший второй кадр останавливает серию, повтор не выпускает первый снова', async () => {
  const { postId } = makePost(['r1.jpg', 'r2.jpg', 'r3.jpg'], [{ platform: 'instagram', format_id: 'story' }]);

  const first = fakeInstagram({ failPublishAt: 2 });
  const out = await publishPost(postId);
  assert.equal(out.status, 'failed');
  let target = getPost(postId).targets[0];
  assert.equal(target.status, 'failed');
  assert.match(target.error, /Кадр 2 из 3.*Уже вышли: 1/);
  assert.equal(partsOf(target).length, 1);
  assert.equal(first.filter((c) => c.href.endsWith('/media')).length, 2, 'третий кадр после упавшего не отправлялся');

  const second = fakeInstagram();
  const again = await publishPost(postId);
  assert.equal(again.status, 'published');
  const sent = second.filter((c) => c.href.endsWith('/media')).map((c) => c.body.image_url.split('/').pop());
  assert.deepEqual(sent, ['r2.jpg', 'r3.jpg'], 'первый кадр второй раз не уходит');
  target = getPost(postId).targets[0];
  assert.deepEqual(partsOf(target).map((p) => p.media_id).length, 3);
});

test('у ленты и сторис одного поста — свои кадры', async () => {
  const calls = fakeInstagram();
  const { postId } = makePost(
    ['f1.jpg', 'f2.jpg', 'st.jpg'],
    [
      { platform: 'instagram', format_id: 'feed-portrait', pick: (ids) => [ids[0], ids[1]] },
      { platform: 'instagram', format_id: 'story', pick: (ids) => [ids[2]] },
    ]
  );

  await publishPost(postId);

  const urls = (type) =>
    calls.filter((c) => c.href.endsWith('/media') && c.body[type]).map((c) => c.body.image_url.split('/').pop());
  const storyUrls = calls
    .filter((c) => c.body.media_type === 'STORIES')
    .map((c) => c.body.image_url.split('/').pop());
  assert.deepEqual(storyUrls, ['st.jpg']);
  assert.deepEqual(urls('is_carousel_item'), ['f1.jpg', 'f2.jpg'], 'в карусель ленты — только её кадры');
});

test('Instagram: сторис из нескольких файлов напрямую в адаптер — ошибка, а не карусель', async () => {
  fakeInstagram();
  await assert.rejects(
    () =>
      instagram.publish({
        text: 'т',
        media: [{ kind: 'image' }, { kind: 'image' }],
        formatId: 'story',
        publicUrl: () => 'u',
        creds: { userId: '1', pageToken: 't' },
      }),
    /по одному кадру/
  );
  await assert.rejects(
    () =>
      instagram.publish({ text: 'т', media: [{ kind: 'image' }], formatId: 'reels', publicUrl: () => 'u', creds: { userId: '1', pageToken: 't' } }),
    /ровно один видеофайл/
  );
});

function fakeFacebook() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ href, body, headers: init.headers || {} });
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });
    if (href.endsWith('/photos')) return reply({ id: 'photo-1' });
    if (href.endsWith('/photo_stories')) return reply({ success: true, post_id: 'story-photo' });
    if (href.endsWith('/video_stories') && body.upload_phase === 'start') {
      return reply({ video_id: 'v9', upload_url: 'https://rupload.facebook.com/video-upload/v26.0/v9' });
    }
    if (href.includes('rupload.facebook.com')) return reply({ success: true });
    if (href.includes('fields=status')) return reply({ status: { uploading_phase: { status: 'complete' } } });
    if (href.endsWith('/video_stories') && body.upload_phase === 'finish') return reply({ success: true, post_id: 'story-video' });
    return reply({ error: { message: `неожиданный вызов ${href}` } });
  };
  return calls;
}

test('Facebook: сторис-фото — неопубликованное фото, затем photo_stories', async () => {
  const calls = fakeFacebook();
  const out = await facebook.publishStory({
    item: { kind: 'image', url: 'https://smm.example/media/a.jpg' },
    publicUrl: (m) => m.url,
    creds: { pageId: '1128', pageToken: 't' },
  });
  assert.equal(calls[0].body.published, 'false', 'фото не должно выйти в ленту');
  assert.equal(calls[1].body.photo_id, 'photo-1');
  assert.equal(out.externalId, 'story-photo');
});

test('Facebook: сторис-видео — start → загрузка по адресу → готовность → finish', async () => {
  const calls = fakeFacebook();
  const out = await facebook.publishStory({
    item: { kind: 'video', url: 'https://smm.example/media/v.mp4' },
    publicUrl: (m) => m.url,
    creds: { pageId: '1128', pageToken: 't' },
    waitMs: 1,
  });
  const steps = calls.map((c) =>
    c.href.includes('rupload') ? 'upload' : c.body.upload_phase || (c.href.includes('fields=status') ? 'status' : c.href)
  );
  assert.deepEqual(steps, ['start', 'upload', 'status', 'finish']);
  assert.equal(calls[1].headers.file_url, 'https://smm.example/media/v.mp4');
  assert.equal(out.externalId, 'story-video');
});

test('Facebook: альбом с видео не публикуется молча без ролика', async () => {
  fakeFacebook();
  await assert.rejects(
    () =>
      facebook.publish({
        text: 'т',
        media: [{ kind: 'image' }, { kind: 'video' }],
        formatId: 'feed-square',
        publicUrl: () => 'u',
        creds: { pageId: '1', pageToken: 't' },
      }),
    /фотоальбомом/
  );
});

test('идущая публикация этого процесса не считается зависшей', () => {
  const { postId } = makePost(['busy.jpg'], [{ platform: 'instagram', format_id: 'story' }]);
  db.prepare("UPDATE posts SET status = 'publishing', publishing_since = datetime('now', '-40 minutes') WHERE id = ?").run(postId);
  db.prepare("UPDATE post_targets SET status = 'sending', sending_since = datetime('now', '-40 minutes') WHERE post_id = ?").run(postId);

  const busy = recoverStuck(db, noop, { busyPostIds: new Set([postId]) });
  assert.equal(busy.unknown, 0);
  assert.equal(busy.resumed, 0);
  assert.equal(getPost(postId).status, 'publishing', 'серия ещё идёт — в очередь не возвращаем');

  // Процесс перезапустился — идущих публикаций у него нет, и это уже обрыв.
  db.prepare('UPDATE post_targets SET parts = ? WHERE post_id = ?').run('[{"media_id":1}]', postId);
  const orphan = recoverStuck(db, noop, { busyPostIds: new Set() });
  assert.equal(orphan.unknown, 1);
  assert.match(getPost(postId).targets[0].error, /вышли 1 кадр/);
});

test('вечнозелёная копия переносит выбор кадров на свои id', () => {
  for (let day = 1; day <= 7; day++) schedule.addSlot(projectId, { weekday: day, time: '11:00' });
  const cat = schedule.createCategory(projectId, { title: 'Вечные сторис', evergreen: true, recycleDays: 1 });
  const { postId, ids } = makePost(['e1.jpg', 'e2.jpg'], [
    { platform: 'instagram', format_id: 'story', pick: (list) => [list[1]] },
  ]);
  db.prepare("UPDATE posts SET status = 'published', recycle = 1, category_id = ? WHERE id = ?").run(cat.id, postId);

  const copy = schedule.requeueEvergreen(postId);
  const clone = getPost(copy.postId);
  const picked = JSON.parse(clone.targets[0].media_ids);
  assert.equal(picked.length, 1);
  assert.notEqual(picked[0], ids[1], 'id кадра оригинала копии не принадлежит');
  assert.equal(clone.media.find((m) => m.id === picked[0]).original_name, 'e2.jpg');
});
