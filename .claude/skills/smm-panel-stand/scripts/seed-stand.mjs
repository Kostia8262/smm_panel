#!/usr/bin/env node
/**
 * Одноразовый стенд панели: заводит владельца и СММщика в ПУСТОЙ базе
 * до старта сервера и печатает их токены.
 *
 * Почему до старта: при нулевом числе сотрудников сервер сам зовёт
 * `staffDb.ensureOwner(resolve(here, '../data/owner-token.txt'))`
 * (src/server.js:219) и кладёт токен владельца в `data/owner-token.txt`
 * внутри репозитория — путь прошит, переменными не переносится. Сотрудник,
 * заведённый заранее, делает COUNT(*) > 0, и файл не появляется.
 *
 * Использование:
 *   node .claude/skills/smm-panel-stand/scripts/seed-stand.mjs <папка-стенда> [порт]
 *
 * Печатает JSON: папка, пути базы и ключа, порт, токены владельца и СММщика.
 * Эти же переменные нужны серверу — список в поле `env`.
 */
import { mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// .claude/skills/smm-panel-stand/scripts → корень проекта
const root = resolve(here, '..', '..', '..', '..');

const standArg = process.argv[2];
if (!standArg) {
  console.error('Укажи папку стенда (в scratchpad сессии), например:');
  console.error('  node .claude/skills/smm-panel-stand/scripts/seed-stand.mjs C:/tmp/stand 3310');
  process.exit(1);
}

const stand = resolve(standArg);
const port = Number(process.argv[3] || 3310);

const env = {
  DB_PATH: join(stand, 'stand.db'),
  SECRET_KEY_PATH: join(stand, 'stand.key'),
  UPLOAD_DIR: join(stand, 'uploads'),
  THUMB_DIR: join(stand, 'thumbs'),
};
for (const dir of [stand, env.UPLOAD_DIR, env.THUMB_DIR]) {
  mkdirSync(dir, { recursive: true });
}
Object.assign(process.env, env);

// Импорт после переменных: db.js читает DB_PATH на загрузке модуля и там же
// прогоняет миграции, secrets.js так же читает SECRET_KEY_PATH.
const staff = await import(pathToFileURL(join(root, 'src', 'staff.js')).href);

const existing = staff.list();
if (existing.length) {
  console.error(`В базе ${env.DB_PATH} уже ${existing.length} сотрудник(ов) — это не чистый стенд.`);
  console.error('Возьми новую папку или удали старую: стенд одноразовый.');
  process.exit(2);
}

const owner = staff.create({ name: 'Стенд — владелец', role: 'owner', note: 'одноразовый стенд' });
const smm = staff.create({ name: 'Стенд — СММщик', role: 'smm', note: 'одноразовый стенд' });

console.log(
  JSON.stringify(
    {
      stand,
      port,
      env,
      tokens: { owner: owner.token, smm: smm.token },
      start: `PORT=${port} node src/server.js`,
      url: `http://localhost:${port}/login`,
    },
    null,
    2
  )
);
