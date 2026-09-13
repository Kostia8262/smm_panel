/**
 * Паспорт ролика без ffmpeg.
 *
 * До 13.09.2026 сервер не знал длительности видео, и проверка пределов
 * площадок молчала всегда. Ролики в fixtures настоящие, сделаны ffmpeg:
 *   phone-rotated.mp4 — кадры 96×54 с пометкой «повернуть» (так пишет
 *                       телефон), H.264 + AAC, 3 с, 30 к/с;
 *   prores.mov        — ProRes, который Instagram и Facebook не примут.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { probeVideo } = await import('../src/video-probe.js');

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('телефонный ролик: повёрнутые кадры читаются как вертикаль', () => {
  const p = probeVideo(fixture('phone-rotated.mp4'));
  assert.equal(p.width, 54, 'ширина после поворота');
  assert.equal(p.height, 96, 'высота после поворота');
  assert.ok([90, 270].includes(p.rotation));
  assert.equal(p.duration, 3);
  assert.equal(p.videoCodec, 'h264');
  assert.equal(p.audioCodec, 'aac');
  assert.equal(p.fps, 30);
});

test('ProRes распознаётся как ProRes, а не как «что-то неизвестное»', () => {
  const p = probeVideo(fixture('prores.mov'));
  assert.equal(p.videoCodec, 'prores');
  assert.equal(p.audioCodec, null, 'дорожки звука нет');
  assert.ok(p.duration > 0);
});

test('не видео и битый файл — пустой паспорт, а не исключение', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smm-probe-'));
  const junk = join(dir, 'junk.mp4');
  writeFileSync(junk, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]));
  const cut = join(dir, 'cut.mp4');
  // Заголовок ftyp, а дальше обрыв: загрузка оборвалась на полпути.
  writeFileSync(cut, Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from([0, 0, 0x10, 0])]));

  for (const path of [junk, cut, join(dir, 'нет-такого.mp4')]) {
    const p = probeVideo(path);
    assert.equal(p.duration, null);
    assert.equal(p.videoCodec, null);
  }
});
