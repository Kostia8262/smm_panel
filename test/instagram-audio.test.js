/**
 * Звук Instagram: разбор ответа площадки, поля Reels, сторож пропавших треков.
 *
 * Проба 13.09.2026 показала, что список звуков приходит в `audio`, а не в
 * `data`, как написано в документации, — первый запуск честно показал «0 шт.»
 * при полном ответе. Такие вещи проверяются здесь, а не глазами в панели.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-audio-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const ig = await import('../src/platforms/instagram-audio.js');
const { sanitizeAudio, checkUpcomingAudio } = await import('../src/audio.js');
const instagram = await import('../src/platforms/instagram.js');
const { validatePost, mediaFor } = await import('../src/validate.js');
const schedule = await import('../src/schedule.js');

const realFetch = globalThis.fetch;
const creds = { userId: '1784', pageToken: 'page-token' };
const CDN = 'https://scontent.fvno8-1.fna.fbcdn.net/o1/v/t2/f2/m69/track.mp4?oh=1';

function fakeGraph(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const { status = 200, body } = handler(u);
    return { ok: status < 400, status, json: async () => body };
  };
  return calls;
}

test('поиск читает список из поля audio и передаёт запрос, курсор и аккаунт', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeGraph(() => ({
    body: {
      audio: [
        { audio_id: '1581803845934560', audio_type: 'music', title: 'Romantic', display_artist: 'Sugartapes', duration_in_ms: 21000, download_url: CDN, cover_artwork_thumbnail_uri: 'https://static.xx.fbcdn.net/c.jpg' },
        { audio_id: '27989644220656167', audio_type: 'original_sound', title: 'Оригинальное аудио', ig_username: 'demaimp', on_platform_audio_preview_link: 'https://www.instagram.com/reels/audio/27989644220656167/' },
        { title: 'без id — отбрасывается' },
      ],
      paging: { cursors: { before: 'MA', after: 'MjU' } },
    },
  }));

  const out = await ig.searchAudio(creds, { type: 'music', q: 'lofi', after: 'MA' });

  assert.equal(calls[0].pathname.endsWith('/ig_audio'), true);
  assert.equal(calls[0].searchParams.get('audio_type'), 'music');
  assert.equal(calls[0].searchParams.get('search_query'), 'lofi');
  assert.equal(calls[0].searchParams.get('after'), 'MA');
  assert.equal(calls[0].searchParams.get('user_id'), '1784');
  assert.equal(out.items.length, 2);
  assert.equal(out.after, 'MjU');
  assert.deepEqual(
    { id: out.items[0].id, artist: out.items[0].artist, preview: out.items[0].previewUrl, cover: Boolean(out.items[0].cover) },
    { id: '1581803845934560', artist: 'Sugartapes', preview: CDN, cover: true }
  );
  assert.equal(out.items[1].username, 'demaimp');
  assert.equal(out.items[1].previewUrl, null, 'у оригинального звука файла для прослушки нет');
  assert.match(out.items[1].pageUrl, /^https:\/\/www\.instagram\.com\//);
});

test('ссылки не с CDN Meta наружу не отдаются', () => {
  const a = ig.normalizeAudio({ audio_id: '123456', download_url: 'https://evil.example/x.mp4', cover_artwork_thumbnail_uri: 'http://scontent.fbcdn.net/c.jpg', on_platform_audio_preview_link: 'https://instagram.com.evil.example/' });
  assert.equal(a.previewUrl, null);
  assert.equal(a.cover, null, 'только https');
  assert.equal(a.pageUrl, null);
});

test('поля Reels: трек — audio_configuration с громкостями в пределах, иначе audio_name', () => {
  const withTrack = ig.reelAudioParams({ id: '1581803845934560', audioVolume: 140, videoVolume: -5 });
  assert.deepEqual(JSON.parse(withTrack.audio_configuration), {
    audio_id: '1581803845934560',
    audio_volume: 100,
    video_volume: 0,
  });
  assert.equal(withTrack.audio_name, undefined, 'название своего звука при треке не шлём — его меняют один раз');

  assert.deepEqual(ig.reelAudioParams({ ownName: 'Мій комп’ютер · Excel' }), { audio_name: 'Мій комп’ютер · Excel' });
  assert.deepEqual(ig.reelAudioParams(null), {});
});

test('пропавший трек — понятная ошибка, сбой сети — исходная', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeGraph(() => ({ status: 400, body: { error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } } }));
  await assert.rejects(
    () => ig.assertAudioAvailable({ id: '1581803845934561', title: 'Romantic', artist: 'Sugartapes' }, creds),
    /Звук «Romantic» — Sugartapes больше недоступен в Instagram/
  );

  fakeGraph(() => ({ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } }));
  await assert.rejects(
    () => ig.assertAudioAvailable({ id: '1581803845934560', title: 'Romantic' }, creds),
    /access token/
  );
});

test('очистка: чужой id и чужая обложка не проходят, громкость зажимается', () => {
  assert.equal(sanitizeAudio({ id: '12; DROP', title: 'x' }), null);
  assert.equal(sanitizeAudio({}), null);
  assert.equal(sanitizeAudio('не json'), null);

  const clean = sanitizeAudio({ id: '909327397007094', type: 'hack', title: ' All For You ', cover: 'https://evil.example/c.jpg', audioVolume: '80', videoVolume: 500 });
  assert.deepEqual(clean, {
    id: '909327397007094',
    type: 'music',
    title: 'All For You',
    artist: null,
    username: null,
    durationMs: null,
    cover: null,
    audioVolume: 80,
    videoVolume: 100,
  });

  assert.deepEqual(sanitizeAudio({ ownName: '  Мій комп’ютер  ' }), { ownName: 'Мій комп’ютер' });
  assert.equal(sanitizeAudio(JSON.stringify({ id: '909327397007094', missing: true })).missing, true);
});

test('сторож: пропажа отмечается и пишется в журнал один раз, возвращение снимает отметку', async () => {
  const projectId = projects.createProject({ slug: 'audio', title: 'Звук' }).id;
  const addPost = (hoursAhead) => {
    const when = db.prepare("SELECT datetime('now', 'localtime', ?) AS w").get(`+${hoursAhead} hours`).w;
    const postId = Number(
      db.prepare("INSERT INTO posts (title, status, scheduled_at, project_id) VALUES ('т', 'scheduled', ?, ?)").run(when, projectId).lastInsertRowid
    );
    const targetId = Number(
      db
        .prepare("INSERT INTO post_targets (post_id, platform, format_id, audio) VALUES (?, 'instagram', 'reels', ?)")
        .run(postId, JSON.stringify({ id: '1581803845934560', title: 'Romantic' })).lastInsertRowid
    );
    return { postId, targetId };
  };
  const soon = addPost(3);
  const later = addPost(24 * 5);

  const logs = [];
  const log = (level, message) => logs.push({ level, message });
  const audioOf = (id) => JSON.parse(db.prepare('SELECT audio FROM post_targets WHERE id = ?').get(id).audio);
  const gone = async () => {
    throw new ig.GraphError('does not exist', { code: 100, subcode: 33 });
  };

  const first = await checkUpcomingAudio({ db, fetchInfo: gone, log });
  assert.equal(first.missing, 1, 'пост через пять дней за горизонтом');
  assert.equal(audioOf(soon.targetId).missing, true);
  assert.equal(audioOf(later.targetId).missing, undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /^пост #\d+: звук Instagram «Romantic» больше недоступен/);

  await checkUpcomingAudio({ db, fetchInfo: gone, log });
  assert.equal(logs.length, 1, 'повторный обход журнал не засоряет');

  await checkUpcomingAudio({
    db,
    fetchInfo: async () => {
      throw new ig.GraphError('сеть');
    },
    log,
  });
  assert.equal(audioOf(soon.targetId).missing, true, 'сбой сети отметку не снимает');

  await checkUpcomingAudio({ db, fetchInfo: async () => ({}), log });
  assert.equal(audioOf(soon.targetId).missing, undefined);
  assert.match(logs.at(-1).message, /снова доступен/);
});

/* ------------------------ публикация, проверка, копия ------------------------ */

/** Graph API Instagram по сценарию: контейнер, готовность, публикация, звук. */
function fakeInstagram({ audioGone = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ path: u.pathname, method: init.method || 'GET', body });
    const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (u.pathname.endsWith('/media') && init.method === 'POST') return reply({ id: 'container-1' });
    if (u.pathname.endsWith('/media_publish')) return reply({ id: 'media-1' });
    if (u.searchParams.get('fields') === 'status_code,status') return reply({ status_code: 'FINISHED' });
    if (u.searchParams.get('fields') === 'media_audio_type') return reply({ media_audio_type: 'MUSIC' });
    if (/\/\d+$/.test(u.pathname)) {
      return audioGone
        ? reply({ error: { message: 'does not exist', code: 100, error_subcode: 33 } }, 400)
        : reply({ audio_id: '1581803845934560', title: 'Romantic' });
    }
    return reply({ error: { message: `неожиданный вызов ${u.pathname}` } }, 400);
  };
  return calls;
}

const video = { id: 1, kind: 'video', url: 'https://smm.example/media/reel.mp4' };
const photo = (id) => ({ id, kind: 'image', url: `https://smm.example/media/${id}.jpg` });
const track = { id: '1581803845934560', type: 'music', title: 'Romantic', audioVolume: 80, videoVolume: 0 };
const wait = { tries: 1, pauseMs: 1 };
const publicUrl = (m) => m.url;

test('Reels со звуком: трек проверяется до контейнера и уходит в audio_configuration', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeInstagram();
  const out = await instagram.publish({ text: 'п', media: [video], formatId: 'reels', publicUrl, creds, wait, audio: track });

  const container = calls.find((c) => c.path.endsWith('/media') && c.method === 'POST');
  const check = calls.findIndex((c) => c.path.endsWith('/1581803845934560'));
  assert.ok(check >= 0 && check < calls.indexOf(container), 'проверка трека — раньше контейнера');
  assert.deepEqual(JSON.parse(container.body.audio_configuration), {
    audio_id: '1581803845934560',
    audio_volume: 80,
    video_volume: 0,
  });
  assert.equal(container.body.media_type, 'REELS');
  assert.equal(out.audioType, 'MUSIC');
});

test('пропавший трек — отказ до контейнера, пост не создаётся', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeInstagram({ audioGone: true });
  await assert.rejects(
    () => instagram.publish({ text: 'п', media: [video], formatId: 'reels', publicUrl, creds, wait, audio: track }),
    /больше недоступен в Instagram/
  );
  assert.ok(!calls.some((c) => c.path.endsWith('/media') && c.method === 'POST'), 'контейнер не создавался');
});

test('звук у карусели — отказ, а не пост без музыки; без звука карусель идёт как раньше', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeInstagram();
  await assert.rejects(
    () => instagram.publish({ text: 'п', media: [photo(2), photo(3)], formatId: 'feed-portrait', publicUrl, creds, wait, audio: track }),
    /только к Reels/
  );
  const out = await instagram.publish({ text: 'п', media: [photo(2), photo(3)], formatId: 'feed-portrait', publicUrl, creds, wait });
  assert.equal(out.externalId, 'media-1');
  assert.equal(out.audioType, undefined, 'без звука лишнего запроса нет');
});

test('проверка поста: звук только у Reels, пропажа — блокер, ролик из фото не уходит в чужие цели', () => {
  const photos = [
    { id: 11, kind: 'image', mime: 'image/jpeg', bytes: 1000, width: 1080, height: 1350, focus_x: 0.5, focus_y: 0.5 },
    { id: 12, kind: 'image', mime: 'image/jpeg', bytes: 1000, width: 1080, height: 1350, focus_x: 0.3, focus_y: 0.5 },
  ];
  const reel = {
    id: 13,
    kind: 'video',
    mime: 'video/mp4',
    bytes: 6e6,
    width: 1080,
    height: 1920,
    duration: 9,
    video_codec: 'h264',
    fps: 30,
    derived: JSON.stringify({
      from: 'photos',
      secondsPerSlide: 3,
      sources: [
        { id: 11, focus_x: 0.5, focus_y: 0.5 },
        { id: 12, focus_x: 0.3, focus_y: 0.5 },
      ],
    }),
  };
  const base = { body: 'текст', media: [...photos, reel] };
  const telegram = { platform: 'telegram', format_id: 'any', media_ids: null };
  const reels = { platform: 'instagram', format_id: 'reels', media_ids: [13], audio: track };

  assert.deepEqual(mediaFor(base, telegram).map((m) => m.id), [11, 12], 'в Telegram — фото, без собранного ролика');
  assert.deepEqual(mediaFor(base, reels).map((m) => m.id), [13]);

  const ok = validatePost({ ...base, targets: [telegram, reels] });
  assert.equal(ok.blockers.filter((b) => b.platform === 'instagram').length, 0, JSON.stringify(ok.blockers));

  const silent = validatePost({ ...base, targets: [{ ...reels, audio: null }] });
  assert.ok(silent.warnings.some((w) => /без звука/.test(w.message)));

  const gone = validatePost({ ...base, targets: [{ ...reels, audio: { ...track, missing: true } }] });
  assert.ok(gone.blockers.some((b) => /пропал из библиотеки/.test(b.message)));

  const carousel = validatePost({
    ...base,
    targets: [{ platform: 'instagram', format_id: 'feed-portrait', media_ids: [11, 12], audio: track }],
  });
  assert.ok(carousel.blockers.some((b) => /только к Reels/.test(b.message)));

  const moved = { ...base, media: [photos[0], { ...photos[1], focus_x: 0.9 }, reel] };
  assert.ok(validatePost({ ...moved, targets: [reels] }).blockers.some((b) => /соберите Reels из фото заново/.test(b.message)));
});

test('вечнозелёная копия уносит звук и ролик из фото с перекладкой id фото', () => {
  const projectId = projects.createProject({ slug: 'evergreen-audio', title: 'Повтор' }).id;
  const categoryId = Number(
    db
      .prepare("INSERT INTO categories (project_id, title, evergreen, recycle_days) VALUES (?, 'Вечная', 1, 30)")
      .run(projectId).lastInsertRowid
  );
  for (let day = 1; day <= 7; day++) {
    db.prepare("INSERT INTO slots (project_id, weekday, time, active) VALUES (?, ?, '10:00', 1)").run(projectId, day);
  }
  const postId = Number(
    db
      .prepare("INSERT INTO posts (title, status, project_id, category_id, recycle) VALUES ('в', 'published', ?, ?, 1)")
      .run(projectId, categoryId).lastInsertRowid
  );
  const addMedia = (kind, name, derived = null, focus = 0.5) =>
    Number(
      db
        .prepare(
          "INSERT INTO media (post_id, kind, original_name, stored_name, mime, bytes, focus_x, position, derived) VALUES (?, ?, ?, ?, 'x', 1, ?, 0, ?)"
        )
        .run(postId, kind, name, name, focus, derived).lastInsertRowid
    );
  const photoId = addMedia('image', 'a.jpg', null, 0.4);
  const reelId = addMedia('video', 'r.mp4', JSON.stringify({ from: 'photos', sources: [{ id: photoId, focus_x: 0.4, focus_y: 0.5 }] }));
  db.prepare(
    "INSERT INTO post_targets (post_id, platform, format_id, status, media_ids, audio) VALUES (?, 'instagram', 'reels', 'published', ?, ?)"
  ).run(postId, JSON.stringify([reelId]), JSON.stringify({ ...track, missing: true, checkedAt: '2026-09-13T10:00:00Z' }));

  const copy = schedule.requeueEvergreen(postId);
  assert.ok(copy, 'копия поставлена');
  const media = db.prepare('SELECT id, stored_name, derived FROM media WHERE post_id = ? ORDER BY id').all(copy.postId);
  const copyPhoto = media.find((m) => m.stored_name === 'a.jpg');
  const copyReel = media.find((m) => m.stored_name === 'r.mp4');
  assert.equal(JSON.parse(copyReel.derived).sources[0].id, copyPhoto.id, 'ролик ссылается на фото копии');

  const target = db.prepare('SELECT media_ids, audio FROM post_targets WHERE post_id = ?').get(copy.postId);
  assert.deepEqual(JSON.parse(target.media_ids), [copyReel.id]);
  const audio = JSON.parse(target.audio);
  assert.equal(audio.id, track.id);
  assert.equal(audio.missing, undefined, 'отметка о пропаже не переносится — сторож перепроверит');
});
