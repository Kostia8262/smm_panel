/**
 * Ключи от панели: как они лежат, кого пускают и что остаётся в базе.
 *
 * Повод завести отдельный файл — аудит 11.09.2026. Токен сотрудника, он же
 * единственный ключ входа (пароля у панели нет вовсе), лежал в базе открытым:
 * дамп пускал внутрь навсегда, а с этого дня база ещё и уезжает в бэкапы.
 * Здесь проверяется и сам перенос, и то, ради чего он делался.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-access-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.UPLOAD_DIR = join(dir, 'uploads');
mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { db } = await import('../src/db.js');
const staff = await import('../src/staff.js');
const media = await import('../src/media.js');
const { tooManyAttempts, clearAttempts, resetAll } = await import('../src/ratelimit.js');

let smm;

before(() => {
  smm = staff.create({ name: 'Катя', role: 'smm' });
});

/* ----------------------------- токены в базе ----------------------------- */

test('столбца с открытым токеном в базе больше нет', () => {
  const columns = db.prepare('PRAGMA table_info(staff)').all().map((c) => c.name);
  assert.ok(!columns.includes('token'), 'столбец token должен быть снят миграцией 015');
  for (const need of ['token_hash', 'token_enc', 'token_tail']) {
    assert.ok(columns.includes(need), `нет столбца ${need}`);
  }
});

test('токен нельзя вычитать из базы глазами', () => {
  const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(smm.id);
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes(smm.token), 'токен найден в строке базы открытым текстом');
  assert.notEqual(row.token_enc, smm.token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test('вход находит сотрудника по токену', () => {
  const found = staff.findByToken(smm.token);
  assert.equal(found?.id, smm.id);
  assert.equal(staff.findByToken(`${smm.token}x`), undefined);
  assert.equal(staff.findByToken(''), null);
});

test('свой токен можно показать человеку обратно', () => {
  assert.equal(staff.tokenOf(smm.id), smm.token);
});

test('перевыпуск закрывает старый токен и открывает новый', () => {
  const before = smm.token;
  const fresh = staff.reissueToken(smm.id);
  assert.notEqual(fresh.token, before);
  assert.equal(staff.findByToken(before), undefined);
  assert.equal(staff.findByToken(fresh.token)?.id, smm.id);
  smm = fresh;
});

test('в списке сотрудников виден ключ целиком — список отдаётся только владельцу', () => {
  const row = staff.list().find((s) => s.id === smm.id);
  assert.equal(row.tokenTail, smm.token.slice(-6));
  assert.equal(row.token, smm.token);
});

/* --------------------------- приём файлов --------------------------- */

test('расширение берётся из типа файла, а не из присланного имени', () => {
  // Тот самый случай: имя обещает картинку, а внутри страница со скриптом.
  assert.ok(media.storedName('image/jpeg').endsWith('.jpg'));
  assert.ok(media.storedName('video/mp4').endsWith('.mp4'));
  assert.ok(!media.storedName('text/html').endsWith('.html'));
});

test('панель принимает только то, что принимают сети', () => {
  assert.ok(media.isAllowedMedia('image/png'));
  assert.ok(media.isAllowedMedia('IMAGE/PNG'), 'тип приходит и в верхнем регистре');
  for (const bad of ['text/html', 'image/svg+xml', 'application/pdf', '', undefined]) {
    assert.ok(!media.isAllowedMedia(bad), `${bad} не должен приниматься`);
  }
});

test('имена файлов не повторяются', () => {
  const names = new Set(Array.from({ length: 200 }, () => media.storedName('image/png')));
  assert.equal(names.size, 200);
});

test('удаление файла не выходит за каталог загрузок', () => {
  const outside = join(dir, 'посторонний.txt');
  writeFileSync(outside, 'не трогать');
  assert.equal(media.removeStored('../посторонний.txt'), false);
  assert.equal(media.removeStored('/etc/passwd'), false);
  assert.ok(existsSync(outside), 'файл за пределами каталога остался на месте');
});

test('подметаются только сироты, и только не свежие', () => {
  const live = media.storedName('image/png');
  const orphanOld = media.storedName('image/png');
  const orphanNew = media.storedName('image/png');
  for (const name of [live, orphanOld, orphanNew]) {
    writeFileSync(join(process.env.UPLOAD_DIR, name), 'x');
  }
  // Состарим одного: остальные загружены «только что».
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(join(process.env.UPLOAD_DIR, orphanOld), old, old);

  const removed = media.sweepOrphans(new Set([live]));

  assert.equal(removed, 1);
  assert.ok(existsSync(join(process.env.UPLOAD_DIR, live)), 'живой кадр удалять нельзя');
  assert.ok(
    existsSync(join(process.env.UPLOAD_DIR, orphanNew)),
    'свежий файл может быть частью идущей загрузки'
  );
  assert.ok(!existsSync(join(process.env.UPLOAD_DIR, orphanOld)));
});

/* --------------------------- счётчик попыток --------------------------- */

test('дверь закрывается после десяти промахов и открывается по времени', () => {
  resetAll();
  const ip = '10.0.0.1';
  for (let i = 0; i < 10; i += 1) {
    assert.equal(tooManyAttempts(ip), false, `промах ${i + 1} не должен закрывать дверь`);
  }
  assert.equal(tooManyAttempts(ip), true, 'одиннадцатая попытка должна упереться');

  const later = Date.now() + 11 * 60 * 1000;
  assert.equal(tooManyAttempts(ip, { now: later }), false, 'через десять минут пускаем снова');
});

test('счётчики соседей не мешают друг другу', () => {
  resetAll();
  for (let i = 0; i < 11; i += 1) tooManyAttempts('10.0.0.2');
  assert.equal(tooManyAttempts('10.0.0.2'), true);
  assert.equal(tooManyAttempts('10.0.0.3'), false, 'блокировка адресная, а не общая');
});

test('успешный вход снимает накопленные промахи', () => {
  resetAll();
  const ip = '10.0.0.4';
  for (let i = 0; i < 9; i += 1) tooManyAttempts(ip);
  clearAttempts(ip);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(tooManyAttempts(ip), false, 'счёт должен идти заново');
  }
});

test('давние записи не копятся без предела', () => {
  resetAll();
  const now = Date.now();
  for (let i = 0; i < 5200; i += 1) tooManyAttempts(`10.1.${i >> 8}.${i & 255}`, { now });
  // Через сутки первый же заход подчищает всё, что давно не трогали.
  tooManyAttempts('10.9.9.9', { now: now + 24 * 3600 * 1000 });
  assert.equal(
    tooManyAttempts('10.1.0.0', { now: now + 24 * 3600 * 1000 }),
    false,
    'забытый адрес должен быть выметен, а не помнить старый счёт'
  );
});
