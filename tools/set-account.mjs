#!/usr/bin/env node
/**
 * Правка одного поля доступов площадки.
 *
 * Нужен для случаев, когда поле вписано неверно, а лезть в базу руками нельзя:
 * значения там шифрованные, и `UPDATE` мимо `saveAccount` положил бы в поле
 * открытый текст, который потом не расшифруется.
 *
 * Так 12.09.2026 правился id аккаунта Threads: в карточку попал чужой id, и
 * публикация падала с «object does not exist», хотя проверка связи проходила.
 *
 *   node tools/set-account.mjs --project 1 --platform threads --field userId --value 29062313960036757
 *
 * Секретные поля (токены) тоже можно, но значение уйдёт в историю командной
 * строки — для них лучше карточка проекта в панели.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { listProjects, credentialsFor, saveAccount, ACCOUNT_FIELDS } = await import('../src/projects.js');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const projectId = Number(flag('project'));
const platform = flag('platform');
const field = flag('field');
const value = flag('value');

if (!projectId || !platform || !field || value === null) {
  console.error('Нужны все четыре: --project, --platform, --field, --value');
  process.exit(1);
}

const project = listProjects().find((p) => p.id === projectId);
if (!project) {
  console.error('Проект не найден');
  process.exit(1);
}

const known = ACCOUNT_FIELDS[platform];
if (!known) {
  console.error(`Неизвестная площадка «${platform}». Есть: ${Object.keys(ACCOUNT_FIELDS).join(', ')}`);
  process.exit(1);
}

// Опечатка в имени поля иначе создала бы мусорный ключ, который никто больше
// не прочитает: форма в панели рисуется по этому же списку.
const spec = known.find((f) => f.key === field);
if (!spec) {
  console.error(`У ${platform} нет поля «${field}». Есть: ${known.map((f) => f.key).join(', ')}`);
  process.exit(1);
}

const before = credentialsFor(projectId, platform)[field] || '';
const show = (v) => (spec.secret ? (v ? `…${String(v).slice(-6)}` : '— пусто —') : v || '— пусто —');

console.log(`${project.title} · ${platform} · ${spec.title}`);
console.log(`  было:  ${show(before)}`);

saveAccount(projectId, platform, { [field]: value });

const after = credentialsFor(projectId, platform)[field] || '';
console.log(`  стало: ${show(after)}`);

if (String(after) !== String(value)) {
  console.error('Значение не записалось — проверьте ключ шифрования');
  process.exit(1);
}
console.log('Готово. Отметка сторожа по этой площадке снята — он проверит её заново.');
