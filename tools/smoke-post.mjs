#!/usr/bin/env node
/**
 * Боевая проба площадок: опубликовать тестовый пост и убрать его за собой.
 *
 * Зачем отдельный скрипт, а не кнопка в панели: «Проверить связь» проверяет
 * только чтение, а публикация упирается в совсем другие разрешения. Пока
 * пост реально не ушёл и не был снят, токены рабочими считать нельзя — это
 * и есть тот самый незакрытый пункт.
 *
 * Ходит прямо в адаптеры, мимо очереди и контент-плана: проба проверяет
 * площадки, и оставлять после неё мусор в календаре школы незачем.
 *
 *   node tools/smoke-post.mjs --project 1 --platforms threads,facebook
 *   node tools/smoke-post.mjs --project 1 --platforms instagram --image https://…/test.jpg
 *   node tools/smoke-post.mjs --project 1 --platforms threads --keep
 *
 * Ключи:
 *   --project N     чей аккаунт пробуем (по умолчанию первый)
 *   --platforms a,b какие площадки (по умолчанию threads,facebook)
 *   --text "…"      свой текст; по умолчанию — служебная строка с отметкой времени
 *   --image URL     публичный JPEG: **обязателен для Instagram**, там текстом нельзя
 *   --wait N        сколько секунд пост повисит перед удалением (по умолчанию 45)
 *   --keep          не удалять — тогда снимать руками
 *
 * Что бы ни случилось, идентификаторы опубликованного пишутся в
 * `data/smoke-<время>.json`: если удаление не прошло, по этому файлу видно,
 * что именно снимать руками.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { listProjects, credentialsFor } = await import('../src/projects.js');
const { getAdapter } = await import('../src/platforms/index.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const projectId = Number(flag('project')) || listProjects()[0]?.id;
const platforms = String(flag('platforms', 'threads,facebook')).split(',').map((s) => s.trim()).filter(Boolean);
const image = flag('image');
const waitSec = Number(flag('wait', 45));
const keep = has('keep');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const text = flag('text') || `Технічна перевірка публікації, ${new Date().toLocaleString('uk-UA')}. Пост буде видалено автоматично.`;

const project = listProjects().find((p) => p.id === projectId);
if (!project) {
  console.error('Проект не найден');
  process.exit(1);
}

console.log(`Проект: ${project.title}`);
console.log(`Площадки: ${platforms.join(', ')}`);
console.log(`Текст: ${text}`);
console.log(keep ? 'Пост останется висеть — снимать руками.' : `Пост будет снят через ${waitSec} с.`);
console.log('');

// Instagram текстом не умеет вовсе — это не наша недоработка, а устройство
// площадки: контейнер требует image_url или video_url. Ловим до публикации,
// иначе проба свалится на середине, уже наследив в двух других сетях.
if (platforms.includes('instagram') && !image) {
  console.error('Instagram не принимает пост без картинки. Дайте --image с публичным адресом JPEG.');
  process.exit(1);
}

const published = [];
const results = [];

for (const platform of platforms) {
  const adapter = getAdapter(platform);
  const creds = credentialsFor(projectId, platform);

  if (!adapter.isConfigured(creds)) {
    console.log(`${platform}: доступы не заполнены — пропускаю`);
    results.push({ platform, step: 'публикация', ok: false, error: 'доступы не заполнены' });
    continue;
  }

  try {
    const out = await adapter.publish({
      text,
      media: image ? [{ kind: 'image', url: image }] : [],
      // Адаптеры сами не знают, где лежит файл: снаружи им дают готовый адрес.
      // Здесь это просто тот адрес, что передали ключом --image.
      publicUrl: () => image,
      creds,
    });
    published.push({ platform, externalId: out.externalId, url: out.url });
    results.push({ platform, step: 'публикация', ok: true, externalId: out.externalId });
    console.log(`${platform}: опубликовано — ${out.externalId}${out.url ? ` · ${out.url}` : ''}`);
  } catch (err) {
    results.push({ platform, step: 'публикация', ok: false, error: err.message });
    console.log(`${platform}: НЕ опубликовано — ${err.message}`);
  }
}

// Записываем до удаления: если сейчас что-то упадёт, по этому файлу будет
// видно, что именно висит в живых аккаунтах.
const dataDir = resolve(here, '../data');
mkdirSync(dataDir, { recursive: true });
const logPath = resolve(dataDir, `smoke-${stamp}.json`);
writeFileSync(logPath, JSON.stringify({ project: project.title, text, published }, null, 2), 'utf8');
console.log(`\nЧто ушло — записано в ${logPath}`);

if (!published.length) {
  console.log('\nПубликовать было нечего — удалять тоже.');
  printSummary();
  process.exit(1);
}

if (keep) {
  console.log('\n--keep: посты оставлены. Снимите их руками.');
  printSummary();
  process.exit(0);
}

console.log(`\nЖду ${waitSec} с, чтобы вы успели посмотреть пост живьём...`);
await new Promise((r) => setTimeout(r, waitSec * 1000));

const stuck = [];
for (const item of published) {
  const adapter = getAdapter(item.platform);
  const creds = credentialsFor(projectId, item.platform);

  if (typeof adapter.remove !== 'function') {
    stuck.push(item);
    results.push({ platform: item.platform, step: 'удаление', ok: false, error: 'площадка не умеет удалять через API' });
    console.log(`${item.platform}: удалять через API нечем — снимите руками (${item.externalId})`);
    continue;
  }

  try {
    await adapter.remove(item.externalId, creds);
    results.push({ platform: item.platform, step: 'удаление', ok: true, externalId: item.externalId });
    console.log(`${item.platform}: удалено`);
  } catch (err) {
    stuck.push(item);
    results.push({ platform: item.platform, step: 'удаление', ok: false, error: err.message });
    console.log(`${item.platform}: НЕ удалено — ${err.message}`);
  }
}

printSummary();

if (stuck.length) {
  console.log('\nОСТАЛОСЬ ВИСЕТЬ В ЖИВЫХ АККАУНТАХ — снять руками:');
  for (const s of stuck) console.log(`  ${s.platform}: ${s.externalId}${s.url ? ` · ${s.url}` : ''}`);
  process.exit(2);
}

function printSummary() {
  console.log('\n=== Итог ===');
  for (const r of results) {
    console.log(`  ${r.platform} · ${r.step}: ${r.ok ? 'ок' : `НЕТ — ${r.error}`}`);
  }
}
