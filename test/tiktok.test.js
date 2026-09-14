/**
 * TikTok: вход, суточный токен, загрузка кусками, прямая публикация и черновик.
 *
 * Здесь проверяется то, на чём TikTok отказывает молча или поздно: refresh
 * token, который при обновлении сменился (старый больше не примут), число
 * кусков у файла чуть больше 5 МБ, видимость, недоступная до аудита, и то, что
 * панель не выбирает за человека ни видимость, ни комментарии.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-tiktok-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

await import('../src/db.js');
const projects = await import('../src/projects.js');
const oauth = await import('../src/oauth/tiktok.js');
const { liveCredentials } = await import('../src/live-creds.js');
const tiktok = await import('../src/platforms/tiktok.js');
const { storeOptions, optionIssues } = await import('../src/target-options.js');

const MB = 1024 * 1024;
let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'tiktok', title: 'TikTok' }).id;
});

const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('ссылка на согласие: права для ленты, черновиков и имени аккаунта', () => {
  const url = new URL(oauth.authorizeUrl({ clientKey: 'ck', redirectUri: 'https://smm.example/oauth/tiktok', state: 'st' }));
  assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(url.searchParams.get('scope'), 'user.info.basic,video.publish,video.upload');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'st');
});

test('обмен кода: сроки датами, недостающие права названы', async () => {
  const now = Date.parse('2026-09-14T10:00:00Z');
  const fetchImpl = async (_url, init) => {
    assert.equal(new URLSearchParams(init.body).get('grant_type'), 'authorization_code');
    return reply({ access_token: 'act', refresh_token: 'rft', open_id: 'oid', expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic,video.upload' });
  };
  const out = await oauth.exchangeCode({ clientKey: 'ck', clientSecret: 'cs', redirectUri: 'r', code: 'c' }, { fetchImpl, now });
  assert.equal(out.values.accessExpiresAt, '2026-09-15T10:00:00.000Z');
  assert.equal(out.values.refreshExpiresAt, '2027-09-14T10:00:00.000Z');
  assert.deepEqual(out.missing, ['video.publish']);

  const failing = async () => reply({ error: 'invalid_grant', error_description: 'Authorization code is expired.' }, 400);
  await assert.rejects(() => oauth.exchangeCode({ clientKey: 'ck', clientSecret: 'cs', redirectUri: 'r', code: 'c' }, { fetchImpl: failing }), /code is expired/);
});

test('обновление: новый refresh token сохраняется, отсутствующий — остаётся прежний', async () => {
  const rotated = await oauth.refreshTokens(
    { clientKey: 'ck', clientSecret: 'cs', refreshToken: 'old' },
    { fetchImpl: async () => reply({ access_token: 'a2', refresh_token: 'new', expires_in: 86400, refresh_expires_in: 100 }) }
  );
  assert.equal(rotated.refreshToken, 'new');
  const same = await oauth.refreshTokens(
    { clientKey: 'ck', clientSecret: 'cs', refreshToken: 'old' },
    { fetchImpl: async () => reply({ access_token: 'a3', expires_in: 86400 }) }
  );
  assert.equal(same.refreshToken, 'old');
});

test('свежие доступы: живой токен не трогаем, протухший обновляем и сохраняем', async () => {
  const now = Date.now();
  projects.saveAccount(projectId, 'tiktok', {
    clientKey: 'ck', clientSecret: 'cs', accessToken: 'live', refreshToken: 'r1',
    accessExpiresAt: new Date(now + 5 * 3600 * 1000).toISOString(),
  });
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    return { accessToken: 'renewed', refreshToken: 'r2', accessExpiresAt: new Date(now + 86400000).toISOString(), refreshExpiresAt: '', openId: 'o', scopes: '' };
  };
  assert.equal((await liveCredentials(projectId, 'tiktok', { refresh })).accessToken, 'live');
  assert.equal(calls, 0);

  projects.saveAccount(projectId, 'tiktok', { accessExpiresAt: new Date(now + 10 * 60 * 1000).toISOString() });
  const creds = await liveCredentials(projectId, 'tiktok', { refresh });
  assert.equal(creds.accessToken, 'renewed');
  assert.equal(projects.credentialsFor(projectId, 'tiktok').refreshToken, 'r2', 'новый refresh token лёг в карточку');
});

test('свежие доступы: соседний процесс уже обновил — берём его токен, иначе честный отказ', async () => {
  const now = Date.now();
  projects.saveAccount(projectId, 'tiktok', { accessToken: 'stale', accessExpiresAt: new Date(now - 1000).toISOString() });
  const racedRefresh = async () => {
    projects.saveAccount(projectId, 'tiktok', { accessToken: 'from-worker', accessExpiresAt: new Date(now + 86400000).toISOString() });
    throw new Error('TikTok, обновление токена: refresh_token is invalid');
  };
  assert.equal((await liveCredentials(projectId, 'tiktok', { refresh: racedRefresh })).accessToken, 'from-worker');

  projects.saveAccount(projectId, 'tiktok', { accessToken: 'dead', accessExpiresAt: new Date(now - 1000).toISOString() });
  const broken = async () => {
    throw new Error('TikTok, обновление токена: refresh_token is invalid');
  };
  await assert.rejects(() => liveCredentials(projectId, 'tiktok', { refresh: broken }), /Подключите TikTok кнопкой заново/);
});

test('нарезка: мелкий и средний файл — одним куском, крупный — по 10 МБ с остатком в последнем', () => {
  assert.deepEqual(tiktok.chunkPlan(3 * MB), { chunkSize: 3 * MB, total: 1, ranges: [[0, 3 * MB - 1]] });
  const six = tiktok.chunkPlan(6 * MB);
  assert.equal(six.total, 1, 'файл 6 МБ не должен дать ноль кусков');
  assert.equal(six.chunkSize, 6 * MB);

  const big = tiktok.chunkPlan(25 * MB + 123);
  assert.equal(big.chunkSize, 10 * MB);
  assert.equal(big.total, Math.floor((25 * MB + 123) / (10 * MB)));
  assert.deepEqual(big.ranges.at(-1), [10 * MB, 25 * MB + 122], 'остаток — в последнем куске');
});

/** Площадка по сценарию: автор, init, загрузка, статус. */
function fakeTikTok({ privacy = ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], statuses = [{ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7412] }], creator = {} } = {}) {
  const calls = [];
  let poll = 0;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body && !Buffer.isBuffer(init.body) ? JSON.parse(init.body) : null;
    calls.push({ href, method: init.method, body, headers: init.headers || {}, bytes: Buffer.isBuffer(init.body) ? init.body.length : 0 });
    const ok = (data) => reply({ data, error: { code: 'ok' } });
    if (href.includes('creator_info')) {
      return ok({ creator_username: 'my_computer', creator_nickname: 'Мій комп’ютер', privacy_level_options: privacy, comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 600, ...creator });
    }
    if (href.includes('/init/')) return ok({ publish_id: 'pub_1', upload_url: 'https://upload.tiktok.example/u1' });
    if (href.includes('upload.tiktok.example')) return reply({});
    if (href.includes('status/fetch')) return ok(statuses[Math.min(poll++, statuses.length - 1)]);
    return reply({ error: { code: 'unexpected', message: href } }, 400);
  };
  return { fetchImpl, calls };
}

const videoFile = join(dir, 'clip.mp4');
writeFileSync(videoFile, Buffer.alloc(1024 * 64, 1));
const video = { kind: 'video', path: videoFile, bytes: 1024 * 64, mime: 'video/mp4', duration: 12, url: 'https://smm.example/media/clip.mp4' };
const creds = { clientKey: 'ck', clientSecret: 'cs', accessToken: 'at', refreshToken: 'rt', audited: 'true' };
const wait = { tries: 3, pauseMs: 1 };
const publicUrl = (m) => m.url;

test('сразу в ленту: выбор человека уходит как есть, выключенное — выключено, файл кусками', async () => {
  const { fetchImpl, calls } = fakeTikTok();
  const out = await tiktok.publish({
    text: 'Урок Scratch за минуту', media: [video], formatId: 'video', publicUrl, creds, wait, fetchImpl,
    options: { mode: 'direct', privacy: 'PUBLIC_TO_EVERYONE', allowComment: true },
  });
  const init = calls.find((c) => c.href.endsWith('/post/publish/video/init/'));
  assert.deepEqual(init.body.post_info, {
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_comment: false,
    brand_content_toggle: false,
    brand_organic_toggle: false,
    title: 'Урок Scratch за минуту',
    disable_duet: true,
    disable_stitch: true,
  });
  assert.deepEqual(init.body.source_info, { source: 'FILE_UPLOAD', video_size: video.bytes, chunk_size: video.bytes, total_chunk_count: 1 });
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.headers['Content-Range'], `bytes 0-${video.bytes - 1}/${video.bytes}`);
  assert.equal(put.bytes, video.bytes);
  assert.equal(out.externalId, '7412');
  assert.equal(out.url, 'https://www.tiktok.com/@my_computer/video/7412');
});

test('в черновики: без автора и без настроек поста, итог — «во входящих»', async () => {
  const { fetchImpl, calls } = fakeTikTok({ statuses: [{ status: 'PROCESSING_UPLOAD' }, { status: 'SEND_TO_USER_INBOX' }] });
  const out = await tiktok.publish({ text: 't', media: [video], formatId: 'video', publicUrl, creds, wait, fetchImpl, options: { mode: 'draft' } });
  assert.ok(!calls.some((c) => c.href.includes('creator_info')), 'черновику автор не нужен');
  const init = calls.find((c) => c.href.includes('/inbox/video/init/'));
  assert.equal(init.body.post_info, undefined);
  assert.equal(out.draft, true);
  assert.match(out.warning, /черновиках TikTok/);
});

test('до аудита — только «Только я»; невыбранная видимость и чужой уровень — отказ до загрузки', async () => {
  const { fetchImpl, calls } = fakeTikTok();
  const args = { text: 't', media: [video], formatId: 'video', publicUrl, wait, fetchImpl };
  await assert.rejects(
    () => tiktok.publish({ ...args, creds: { ...creds, audited: 'false' }, options: { privacy: 'PUBLIC_TO_EVERYONE' } }),
    /только с видимостью «Только я»/
  );
  await assert.rejects(() => tiktok.publish({ ...args, creds, options: {} }), /не выбрано, кто увидит/);
  await assert.rejects(() => tiktok.publish({ ...args, creds, options: { privacy: 'FOLLOWER_OF_CREATOR' } }), /видимость этому аккаунту недоступна/);
  assert.ok(!calls.some((c) => c.href.includes('/init/')), 'до init дело не дошло');
});

test('отказ обработки — понятной причиной; долгая обработка — предупреждение, а не повтор', async () => {
  const failed = fakeTikTok({ statuses: [{ status: 'FAILED', fail_reason: 'duration_check_failed' }] });
  await assert.rejects(
    () => tiktok.publish({ text: 't', media: [video], formatId: 'video', publicUrl, creds, wait, fetchImpl: failed.fetchImpl, options: { privacy: 'SELF_ONLY' } }),
    /ролик длиннее или короче/
  );
  const slow = fakeTikTok({ statuses: [{ status: 'PROCESSING_DOWNLOAD' }] });
  const out = await tiktok.publish({ text: 't', media: [video], formatId: 'video', publicUrl, creds, wait, fetchImpl: slow.fetchImpl, options: { privacy: 'SELF_ONLY' } });
  assert.match(out.warning, /ещё обрабатывает/);
  assert.equal(out.externalId, 'pub_1');
});

test('фото-пост — только с подтверждённого адреса, ссылками, заголовок до 90 знаков', async () => {
  const photos = [1, 2].map((i) => ({ kind: 'image', url: `https://smm.example/media/p${i}.jpg` }));
  const { fetchImpl, calls } = fakeTikTok();
  await assert.rejects(
    () => tiktok.publish({ text: 't', media: photos, formatId: 'photo', publicUrl, creds, wait, fetchImpl, options: { privacy: 'SELF_ONLY' } }),
    /адрес панели не подтверждён/
  );
  const long = `${'Заголовок '.repeat(15)}\nОписание поста`;
  await tiktok.publish({
    text: long, media: photos, formatId: 'photo', publicUrl, creds: { ...creds, domainVerified: 'true' }, wait, fetchImpl,
    options: { privacy: 'SELF_ONLY', autoMusic: true },
  });
  const init = calls.find((c) => c.href.includes('/content/init/'));
  assert.equal(init.body.post_mode, 'DIRECT_POST');
  assert.equal(init.body.post_info.title.length, 90);
  assert.equal(init.body.post_info.auto_add_music, true);
  assert.deepEqual(init.body.source_info.photo_images, photos.map((p) => p.url));
});

test('настройки цели: реклама без отметок не пускает, платное партнёрство не бывает «Только я»', () => {
  const stored = JSON.parse(storeOptions('tiktok', { privacy: 'SELF_ONLY', yourBrand: true, brandedContent: true, hack: 1 }));
  assert.deepEqual(stored, { mode: 'direct', privacy: 'SELF_ONLY' }, 'без «рекламы» метки бренда не хранятся');

  assert.match(optionIssues('tiktok', {}).blockers[0], /выберите, кто увидит пост/);
  assert.match(optionIssues('tiktok', { privacy: 'PUBLIC_TO_EVERYONE', commercial: true }).blockers[0], /свой бренд или чужой/);
  assert.match(optionIssues('tiktok', { privacy: 'SELF_ONLY', commercial: true, brandedContent: true }).blockers[0], /нельзя публиковать с видимостью «Только я»/);
  const draft = optionIssues('tiktok', { mode: 'draft' });
  assert.equal(draft.blockers.length, 0);
  assert.match(draft.warnings[0], /в черновики/);
});
