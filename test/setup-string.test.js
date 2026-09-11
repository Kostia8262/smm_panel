/**
 * Проверки строки настройки расширения.
 *
 * Полупустая настройка опаснее отсутствующей: расширение сочтёт себя
 * настроенным и будет молчать, а человек будет ждать данных.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decodeSetup, encodeSetup } = await import('../extension/src/setup.js');

const valid = { panelUrl: 'https://smm.mycomputer.education', projectId: 3, ingestKey: 'abc123' };

test('строка собирается и разбирается обратно', () => {
  const parsed = decodeSetup(encodeSetup(valid));
  assert.deepEqual(parsed, valid);
});

test('хвостовой слеш в адресе убирается', () => {
  const parsed = decodeSetup(encodeSetup({ ...valid, panelUrl: 'https://smm.mycomputer.education/' }));
  assert.equal(parsed.panelUrl, 'https://smm.mycomputer.education');
});

test('пробелы вокруг строки не мешают', () => {
  assert.ok(decodeSetup(`  ${encodeSetup(valid)}  `));
});

test('чужая или битая строка отвергается', () => {
  assert.equal(decodeSetup(''), null);
  assert.equal(decodeSetup('просто текст'), null);
  assert.equal(decodeSetup('smm1.не-база64'), null);
  assert.equal(decodeSetup('smm2.' + encodeSetup(valid).slice(5)), null, 'чужая версия формата');
});

test('неполная настройка не принимается', () => {
  assert.equal(decodeSetup(encodeSetup({ ...valid, ingestKey: '' })), null, 'без ключа');
  assert.equal(decodeSetup(encodeSetup({ ...valid, projectId: 0 })), null, 'без проекта');
  assert.equal(decodeSetup(encodeSetup({ ...valid, panelUrl: 'smm.mycomputer.education' })), null, 'адрес без схемы');
});
