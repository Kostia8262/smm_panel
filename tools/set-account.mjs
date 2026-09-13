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
 *
 * Второй режим — дата выпуска токена, от которой сторож считает срок там, где
 * площадка его не отдаёт (Threads). Нужна, когда токен выпустили раньше, чем
 * вписали в панель:
 *
 *   node tools/set-account.mjs --project 1 --platform threads --token-issued 2026-09-11T00:00:00+03:00
 *
 * Точного часа обычно никто не помнит — берите начало суток: ранняя дата
 * заставит сторожа продлить на несколько часов раньше, поздняя — опоздать.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { listProjects, credentialsFor, saveAccount, ACCOUNT_FIELDS, tokenSavedAt, setTokenSavedAt } =
  await import('../src/projects.js');
const { DAY_MS, TOKEN_POLICY } = await import('../src/tokens.js');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const projectId = Number(flag('project'));
const platform = flag('platform');
const field = flag('field');
const value = flag('value');
const issued = flag('token-issued');

const project = listProjects().find((p) => p.id === projectId);
if (!project) {
  console.error('Проект не найден (--project)');
  process.exit(1);
}

// Только посмотреть: когда вписан токен и чем он кончается. Отвечает на вопрос
// «сменился ли токен вообще» — 13.09.2026 права на удаление не появились, и
// первым делом надо было понять, лежит ли в карточке новый токен или старый.
// Хвост — те же шесть знаков, что карточка показывает в поле; целиком токен
// не печатается.
if (args.includes('--show')) {
  const creds = credentialsFor(projectId, platform);
  console.log(`${project.title} · ${platform}`);
  for (const f of ACCOUNT_FIELDS[platform] || []) {
    const v = creds[f.key];
    const shown = !v ? '— пусто —' : f.secret ? `…${String(v).slice(-6)} (${String(v).length} знаков)` : v;
    console.log(`  ${f.title}: ${shown}`);
  }
  console.log(`  дата выпуска токена: ${tokenSavedAt(projectId, platform) || '— пусто —'}`);
  process.exit(0);
}

if (issued !== null) {
  const before = tokenSavedAt(projectId, platform);
  let after;
  try {
    after = setTokenSavedAt(projectId, platform, issued);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`${project.title} · ${platform} · дата выпуска токена`);
  console.log(`  было:  ${before || '— пусто —'}`);
  console.log(`  стало: ${after}`);

  const days = TOKEN_POLICY[platform]?.kind === 'estimate' ? TOKEN_POLICY[platform].days : null;
  if (days) {
    const dies = new Date(new Date(after).getTime() + days * DAY_MS).toISOString();
    console.log(`  токен умрёт по расчёту: ${dies}`);
  } else {
    console.log('  у этой площадки срок читается у самой площадки — дата выпуска на расчёт не влияет');
  }
  process.exit(0);
}

if (!platform || !field || value === null) {
  console.error('Нужны --platform, --field и --value (или --token-issued)');
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
