/**
 * Лимиты медиа по раскладкам и кадры цели.
 *
 * Пока лимит был один на площадку, проверка либо пропускала заведомый отказ
 * (ролик на 95 с в Reels Facebook, вертикаль 9:16 в ленту Instagram), либо
 * запрещала то, что сеть примет (длинное видео в ленту Facebook). Всё это —
 * отказы, которые человек увидел бы уже после постановки в очередь.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validatePost, mediaFor } = await import('../src/validate.js');
const { mediaRulesFor } = await import('../src/platforms/specs.js');

const MB = 1024 * 1024;

const image = (id, w, h, extra = {}) => ({
  id,
  kind: 'image',
  mime: 'image/jpeg',
  bytes: 300 * 1024,
  width: w,
  height: h,
  original_name: `кадр-${id}.jpg`,
  ...extra,
});

const video = (id, duration, extra = {}) => ({
  id,
  kind: 'video',
  mime: 'video/mp4',
  bytes: 20 * MB,
  width: 1080,
  height: 1920,
  duration,
  video_codec: 'h264',
  audio_codec: 'aac',
  fps: 30,
  original_name: `ролик-${id}.mp4`,
  ...extra,
});

const check = (media, targets, body = 'текст') => validatePost({ body, media, targets, signature: '' });
const blockersOf = (v, target) => v.blockers.filter((b) => b.target === target).map((b) => b.message);
const warningsOf = (v, target) => v.warnings.filter((w) => w.target === target).map((w) => w.message);

test('лимиты раскладки поверх площадки: сторис Instagram — 60 с и 100 МБ, типы файлов общие', () => {
  const story = mediaRulesFor('instagram', 'story');
  assert.equal(story.video.maxSeconds, 60);
  assert.equal(story.video.maxBytes, 100 * MB);
  assert.deepEqual(story.video.codecs, ['h264', 'hevc'], 'кодеки берутся у площадки');
  assert.equal(mediaRulesFor('instagram', 'reels').video.maxBytes, 300 * MB);
  assert.equal(mediaRulesFor('facebook', 'feed-square').video.maxSeconds, null, 'у видео в ленту Facebook предела 90 с нет');
});

test('ролик 95 с: в Reels Facebook — отказ, в ленту Facebook — можно', () => {
  const v = check([video(1, 95)], [
    { platform: 'facebook', format_id: 'reels' },
    { platform: 'facebook', format_id: 'feed-square' },
  ]);
  assert.ok(blockersOf(v, 'facebook:reels').some((m) => /длиннее предела 1 мин 30 с/.test(m)));
  assert.deepEqual(blockersOf(v, 'facebook:feed-square'), []);
});

test('сторис длиннее 60 с и короче 3 с — отказ', () => {
  const long = check([video(1, 61)], [{ platform: 'instagram', format_id: 'story' }]);
  assert.ok(blockersOf(long, 'instagram:story').some((m) => /длиннее предела 1 мин/.test(m)));
  const short = check([video(1, 2)], [{ platform: 'facebook', format_id: 'story' }]);
  assert.ok(blockersOf(short, 'facebook:story').some((m) => /короче 3 с/.test(m)));
});

test('вертикаль 9:16 в ленту Instagram — отказ, в сторис — можно', () => {
  const v = check([image(1, 1080, 1920)], [
    { platform: 'instagram', format_id: 'feed-portrait' },
    { platform: 'instagram', format_id: 'story' },
  ]);
  assert.ok(blockersOf(v, 'instagram:feed-portrait').some((m) => /вытянут вверх/.test(m)));
  assert.deepEqual(blockersOf(v, 'instagram:story'), []);
});

test('Reels из картинки или из двух роликов — отказ', () => {
  const pic = check([image(1, 1080, 1350)], [{ platform: 'instagram', format_id: 'reels' }]);
  assert.ok(blockersOf(pic, 'instagram:reels').some((m) => /только видео/.test(m)));
  const two = check([video(1, 20), video(2, 20)], [{ platform: 'instagram', format_id: 'reels' }]);
  assert.ok(blockersOf(two, 'instagram:reels').some((m) => /ровно один файл/.test(m)));
});

test('ProRes — отказ с советом пересохранить; незнакомый звук — предупреждение', () => {
  const v = check([video(1, 20, { video_codec: 'prores', audio_codec: 'pcm' })], [
    { platform: 'instagram', format_id: 'reels' },
  ]);
  assert.ok(blockersOf(v, 'instagram:reels').some((m) => /ProRes.*H\.264/.test(m)));
  assert.ok(warningsOf(v, 'instagram:reels').some((m) => /звук в PCM/.test(m)));
});

test('длительность не прочитана — предупреждение с пределами, а не молчание', () => {
  const v = check([video(1, null, { video_codec: null })], [{ platform: 'facebook', format_id: 'reels' }]);
  assert.ok(warningsOf(v, 'facebook:reels').some((m) => /длительность не прочитана.*3–90 с/.test(m)));
});

test('горизонтальный ролик в Reels — предупреждение про поля', () => {
  const v = check([video(1, 20, { width: 1920, height: 1080 })], [{ platform: 'facebook', format_id: 'reels' }]);
  assert.ok(warningsOf(v, 'facebook:reels').some((m) => /горизонтальный/.test(m)));
});

test('Facebook: несколько файлов с видео — отказ, альбом его потерял бы', () => {
  const v = check([image(1, 1200, 1200), video(2, 30)], [{ platform: 'facebook', format_id: 'feed-square' }]);
  assert.ok(blockersOf(v, 'facebook:feed-square').some((m) => /фотоальбомом/.test(m)));
});

test('сторис не считает текст: длинный текст ленты её не блокирует', () => {
  const v = check([image(1, 1080, 1920)], [
    { platform: 'threads', format_id: 'portrait' },
    { platform: 'instagram', format_id: 'story' },
  ], 'я'.repeat(700));
  assert.ok(blockersOf(v, 'threads:portrait').some((m) => /длиннее лимита/.test(m)));
  assert.deepEqual(blockersOf(v, 'instagram:story'), []);
});

test('кадры цели: лента берёт свои, сторис — свои, порядок — по кадрам поста', () => {
  const media = [image(1, 1080, 1350), image(2, 1080, 1350), image(3, 1080, 1920)];
  const post = { media };
  assert.deepEqual(mediaFor(post, { media_ids: null }).map((m) => m.id), [1, 2, 3]);
  assert.deepEqual(mediaFor(post, { media_ids: '[3,1]' }).map((m) => m.id), [1, 3], 'порядок поста, не выбора');

  const v = check(media, [
    { platform: 'instagram', format_id: 'feed-portrait', media_ids: [1, 2] },
    { platform: 'instagram', format_id: 'story', media_ids: [3] },
  ]);
  assert.ok(v.ok, JSON.stringify(v.blockers));
});

test('выбор кадров опустел — отказ с понятной причиной', () => {
  const v = check([image(1, 1080, 1350)], [{ platform: 'instagram', format_id: 'story', media_ids: [] }]);
  assert.ok(blockersOf(v, 'instagram:story').some((m) => /Не выбран ни один кадр/.test(m)));
});

test('Reels Facebook без ролика — отказ до очереди, а не при отправке', () => {
  // У Facebook медиа в целом необязательно (текстовый пост есть), а у Reels — да.
  const bare = check([], [{ platform: 'facebook', format_id: 'reels' }]);
  assert.ok(blockersOf(bare, 'facebook:reels').some((m) => /без ролика не бывает/.test(m)));
  const cut = check([image(1, 1200, 1200)], [{ platform: 'facebook', format_id: 'reels', media_ids: [] }]);
  assert.ok(blockersOf(cut, 'facebook:reels').some((m) => /Не выбран ни один кадр/.test(m)));
});

test('лента с пустым выбором кадров — предупреждение: уйдёт только текст', () => {
  const v = check([image(1, 1200, 1200)], [{ platform: 'facebook', format_id: 'feed-square', media_ids: [] }]);
  assert.deepEqual(blockersOf(v, 'facebook:feed-square'), []);
  assert.ok(warningsOf(v, 'facebook:feed-square').some((m) => /уйдёт только текст/.test(m)));
});

test('правило фотоальбома — про ленту Facebook, а не про Reels', () => {
  const v = check([video(1, 30), video(2, 30)], [{ platform: 'facebook', format_id: 'reels' }]);
  const reels = blockersOf(v, 'facebook:reels');
  assert.ok(reels.some((m) => /ровно один файл/.test(m)));
  assert.ok(!reels.some((m) => /фотоальбомом/.test(m)));
});

test('у замечания есть подпись цели: «Instagram · Stories»', () => {
  const v = check([video(1, 61)], [{ platform: 'instagram', format_id: 'story' }]);
  assert.equal(v.blockers[0].label, 'Instagram · Stories');
});
