/**
 * Звуки в тренде Instagram — на доску трендов.
 *
 * Долгое время у Instagram не было никакого машинного сигнала трендов, и
 * звук, главный рычаг охвата Reels, заносился в панель руками или не
 * заносился вовсе. С июня 2026 Instagram Audio API отдаёт трендовые звуки
 * (поиск без запроса) — их и приносим.
 *
 * Звук держим одной строкой на проект: повторный сбор освежает её, а не
 * плодит копии. Тренд звука короткий — три дня; не попадавший в выдачу неделю
 * уходит в архив сам, иначе доска за месяц заросла бы сотней протухших треков.
 */

import { db, log } from '../db.js';
import { credentialsFor } from '../projects.js';
import { searchAudio, audioLabel } from '../platforms/instagram-audio.js';
import { sanitizeAudio } from '../audio.js';

export const SOUND_SOURCE = 'ig_audio';
const FRESH_DAYS = 3;
const ARCHIVE_AFTER_DAYS = 7;

const TYPES = [
  { type: 'music', title: 'музыка' },
  { type: 'original_sound', title: 'оригинальный звук' },
];

function durationText(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * @param {number} projectId
 * @param {object} [opts]
 * @param {number} [opts.perType]  сколько первых мест брать каждого типа
 * @param {Function} [opts.search] подмена поиска в тестах
 */
export async function collectTrendingSounds(projectId, { perType = 5, search = searchAudio } = {}) {
  const creds = credentialsFor(projectId, 'instagram');
  if (!creds.userId || !creds.pageToken) throw new Error('У проекта не подключён Instagram — звуки брать неоткуда');

  const report = { added: 0, refreshed: 0, archived: 0, failed: [] };
  const expires = db.prepare("SELECT datetime('now', 'localtime', ?) AS at").get(`+${FRESH_DAYS} days`).at;

  const find = db.prepare(
    `SELECT id FROM trends WHERE project_id = ? AND source = ? AND json_extract(audio, '$.id') = ?
      ORDER BY id DESC LIMIT 1`
  );
  const refresh = db.prepare(
    `UPDATE trends SET title = ?, summary = ?, metric = ?, url = ?, relevance = ?, audio = ?,
            captured_at = datetime('now'), expires_at = ?, archived = 0
      WHERE id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO trends (platform, title, summary, metric, url, source, relevance, expires_at, project_id, audio)
     VALUES ('instagram', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const { type, title: typeTitle } of TYPES) {
    let items;
    try {
      ({ items } = await search(creds, { type }));
    } catch (err) {
      report.failed.push({ type, error: err.message });
      log('warn', `сбор трендов, звуки Instagram (${typeTitle}): ${err.message}`);
      continue;
    }

    items.slice(0, perType).forEach((item, i) => {
      const rank = i + 1;
      const audio = sanitizeAudio({ ...item, audioVolume: 100, videoVolume: 100 });
      if (!audio?.id) return;
      const length = durationText(audio.durationMs);
      const title = `Звук: ${audioLabel(audio)}`;
      const summary =
        type === 'music'
          ? `Музыка из бесплатной библиотеки Meta${length ? `, ${length}` : ''}. Под неё хорошо ложатся Reels из фото — прав на трек не спросят.`
          : `Оригинальный звук${audio.username ? ` @${audio.username}` : ''} из чужих Reels${length ? `, ${length}` : ''}. Ролик с ним попадает на страницу звука — туда приходят зрители не из подписчиков.`;
      const metric = `№${rank} в тренде · ${typeTitle}`;
      const relevance = rank <= 2 ? 4 : 3;
      const row = find.get(projectId, SOUND_SOURCE, audio.id);
      if (row) {
        refresh.run(title, summary, metric, item.pageUrl || null, relevance, JSON.stringify(audio), expires, row.id);
        report.refreshed += 1;
      } else {
        insert.run(title, summary, metric, item.pageUrl || null, SOUND_SOURCE, relevance, expires, projectId, JSON.stringify(audio));
        report.added += 1;
      }
    });
  }

  report.archived = Number(
    db
      .prepare(
        `UPDATE trends SET archived = 1
          WHERE project_id = ? AND source = ? AND archived = 0 AND used_count = 0
            AND captured_at < datetime('now', ?)`
      )
      .run(projectId, SOUND_SOURCE, `-${ARCHIVE_AFTER_DAYS} days`).changes
  );

  log('info', `сбор трендов: звуки Instagram — новых ${report.added}, освежено ${report.refreshed}, в архив ${report.archived}`);
  return report;
}
