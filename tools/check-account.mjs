#!/usr/bin/env node
/**
 * «Проверить связь» из командной строки — то же, что кнопка в карточке проекта.
 *
 * Только чтение: ничего не публикует. Нужен, чтобы проверить только что
 * заполненную карточку, не дожидаясь шестичасового обхода сторожа и не входя
 * в панель. Токены не печатаются.
 *
 *   node tools/check-account.mjs --project 1 --platform telegram
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { credentialsFor, listProjects } = await import('../src/projects.js');
const { getAdapter, idMismatch } = await import('../src/platforms/index.js');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const projectId = Number(flag('project')) || 1;
const platform = flag('platform');
const project = listProjects().find((p) => p.id === projectId);
if (!project || !platform) {
  console.error('Нужны --project и --platform');
  process.exit(1);
}

const adapter = getAdapter(platform);
const creds = credentialsFor(projectId, platform);
if (!adapter.isConfigured(creds)) {
  console.log(`${project.title} · ${platform}: не заполнено — ${adapter.missingConfig(creds).join(', ')}`);
  process.exit(1);
}

try {
  const res = await adapter.check(creds);
  console.log(`${project.title} · ${platform}: связь есть — ${res.account || res.chat || res.bot || 'ок'}${res.bot ? ` (бот @${res.bot})` : ''}`);
  // Замечание самого адаптера (Telegram: бот публикует, но удалять не может)
  // и расхождение id — разные вещи, печатаем оба.
  for (const warning of [res.warning, idMismatch(creds, res)].filter(Boolean)) {
    console.log(`  внимание: ${warning}`);
  }
} catch (err) {
  console.log(`${project.title} · ${platform}: НЕТ связи — ${err.message}`);
  process.exit(2);
}
