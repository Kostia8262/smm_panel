#!/usr/bin/env node
/**
 * Как идёт синхронизация сегментов CRM школы (src/mail/crm-segments.js).
 * Только чтение: базу панели не меняет.
 *
 * Показывает итог последнего захода воркера и базы «CRM: …» по школам.
 * С `--live` ещё спрашивает у админки список включённых сегментов тем же
 * ключом, что воркер, — видно, что админка отдаёт прямо сейчас. Составы не
 * запрашиваются и в базы ничего не пишется.
 *
 *   node tools/crm-segments-status.mjs [--live]
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db } = await import('../src/db.js');
const { feedAccess, integrationFetch } = await import('../src/mail/crm-feed.js');
const { segmentsState, SEGMENT_SCHOOLS } = await import('../src/mail/crm-segments.js');

const access = feedAccess();
const state = segmentsState();
const tried = db.prepare("SELECT value FROM settings WHERE key = 'crm_segments_tried'").get()?.value;

console.log(`Ключ ленты: ${access.apiKey ? 'есть' : 'не вписан'}, админка ${access.apiUrl}`);
console.log(`Последний заход: ${tried ? new Date(Number(tried)).toISOString() : 'не было'}`);
console.log(`Удачный: ${state.lastAt || '—'}; ошибка: ${state.lastError || 'нет'}`);
console.log(`Итог: ${state.lastStats ? JSON.stringify(state.lastStats) : '—'}`);

const lists = db
  .prepare(
    `SELECT p.slug, l.id, l.name, l.crm_segment, l.consent_basis, l.archived_at, l.crm_synced_at,
            (SELECT COUNT(*) FROM mail_list_members m WHERE m.list_id = l.id AND m.removed_at IS NULL) AS members,
            (SELECT COUNT(*) FROM mail_list_members m WHERE m.list_id = l.id AND m.removed_at IS NOT NULL) AS dropped
       FROM mail_lists l JOIN projects p ON p.id = l.project_id
      WHERE l.crm_segment IS NOT NULL ORDER BY p.slug, l.crm_segment`
  )
  .all();
console.log(`\nБаз сегментов: ${lists.length}`);
for (const l of lists) {
  console.log(
    `  ${l.slug} · ${l.crm_segment} · #${l.id} «${l.name}» · ${l.consent_basis} · в базе ${l.members}, выбыло ${l.dropped}` +
      `${l.archived_at ? ` · архив ${l.archived_at}` : ''} · сверено ${l.crm_synced_at || '—'}`
  );
}

if (process.argv.includes('--live')) {
  if (!access.apiKey) {
    console.log('\n--live: ключа нет, спрашивать нечем');
  } else {
    console.log('\nАдминка сейчас:');
    for (const slug of SEGMENT_SCHOOLS) {
      try {
        const data = await integrationFetch(`/api/integration/mail/segments?project=${slug}`, access);
        const segs = data?.segments || [];
        console.log(`  ${slug}: ${segs.length ? segs.map((s) => `${s.key} (${s.count})`).join(', ') : 'включённых сегментов нет'}`);
      } catch (err) {
        console.log(`  ${slug}: ошибка — ${err.message}`);
      }
    }
  }
}
