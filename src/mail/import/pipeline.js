/**
 * Загрузка базы: файл → строки предпросмотра → подтверждение.
 *
 * Ничего не попадает в базу школы до подтверждения. Разобранные строки ждут в
 * `mail_import_rows`, исходный файл — в `mail_imports.source`: без него не
 * сменить кодировку или лист, не загружая файл заново. Подтверждение или отказ
 * стирают и то и другое; брошенная загрузка стирается через сутки.
 *
 * Проверка доменов (DNS) идёт после ответа, в фоне: у большой базы это минута,
 * и держать её внутри запроса значит упереться в таймаут прокси. Предпросмотр
 * открывается сразу и дописывает результат.
 */

import { db, log } from '../../db.js';
import { IMPORT_LIMITS, VERDICTS, PAGE_SIZE } from '../specs.js';
import { decodeBytes, ENCODINGS } from './decode.js';
import { parseCsv, sniffDelimiter, DELIMITERS } from './csv.js';
import { isZip, isLegacyXls, openXlsx } from './xlsx.js';
import { looksLikeVcard, parseVcard } from './vcard.js';
import { extractFromText, emailsIn, NAMED_ADDRESS } from './text.js';
import { detectHeader, detectRoles, columnLabels, COLUMN_ROLES } from './columns.js';
import { checkAddress, emailHash } from './address.js';
import { checkDomains } from './mx.js';
import * as store from '../store.js';

const { MailError } = store;

export const FORMATS = {
  csv: 'CSV',
  tsv: 'Таблица через табуляцию',
  xlsx: 'Excel',
  vcf: 'vCard',
  text: 'Текст',
};

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* ------------------------------ разбор файла ------------------------------ */

/**
 * @param {Uint8Array} bytes
 * @param {{encoding?: string, delimiter?: string|null, sheet?: number, hasHeader?: boolean}} overrides
 * @returns {{format: string, encoding: string|null, delimiter: string|null, sheets: string[], sheet: number|null,
 *   hasHeader: boolean, header: string[]|null, data: string[][]}}
 */
export function parseSource(bytes, overrides = {}) {
  if (!bytes?.length) throw new MailError('Файл пустой');
  if (isLegacyXls(bytes)) {
    throw new MailError('Это старый формат .xls — откройте файл в Excel и сохраните как .xlsx или CSV');
  }

  if (isZip(bytes)) {
    let book;
    try {
      book = openXlsx(bytes);
    } catch (err) {
      throw new MailError(err.message);
    }
    const sheet = Math.min(Math.max(Number(overrides.sheet) || 0, 0), book.sheets.length - 1);
    const rows = book.read(sheet).filter((r) => r.some((c) => String(c).trim()));
    return withHeader({ format: 'xlsx', encoding: null, delimiter: null, sheets: book.sheets, sheet }, rows, overrides);
  }

  const { text, encoding } = decodeBytes(bytes, overrides.encoding);
  const base = { encoding, sheets: [], sheet: null };

  if (looksLikeVcard(text)) {
    const card = parseVcard(text);
    return { ...base, format: 'vcf', delimiter: null, hasHeader: true, header: card.header, data: card.rows };
  }

  const delimiter = overrides.delimiter !== undefined ? overrides.delimiter || null : sniffDelimiter(text);
  if (delimiter) {
    const rows = parseCsv(text, delimiter, { maxRows: IMPORT_LIMITS.maxRows + 2 });
    const cells = rows.flat();
    // Таблица — это хотя бы две строки с адресами в ячейках. «Кому: Ірина
    // <ira@…>, Петро <petro@…>» тоже режется запятой на колонки, но это
    // строка из письма: разобрав её таблицей, мы потеряли бы имена.
    const tabular =
      overrides.delimiter !== undefined ||
      (rows.length >= 2 && cells.some((c) => emailsIn(c).length) && !cells.some((c) => NAMED_ADDRESS.test(c)));
    if (tabular) {
      return withHeader({ ...base, format: delimiter === '\t' ? 'tsv' : 'csv', delimiter }, rows, overrides);
    }
  }

  // Колонок нет или в них не нашлось адресов — это текст: письмо, список,
  // переписка. Адреса вынимаем откуда угодно.
  const free = extractFromText(text);
  return { ...base, format: 'text', delimiter: null, hasHeader: true, header: free.header, data: free.rows };
}

function withHeader(base, rows, overrides) {
  const hasHeader = overrides.hasHeader !== undefined ? Boolean(overrides.hasHeader) : detectHeader(rows);
  return {
    ...base,
    hasHeader,
    header: hasHeader ? rows[0] : null,
    data: hasHeader ? rows.slice(1) : rows,
  };
}

/* --------------------------- строки предпросмотра --------------------------- */

function validRoles(roles, width) {
  const out = {};
  for (let col = 0; col < width; col++) {
    const role = roles?.[col];
    out[col] = COLUMN_ROLES[role] ? role : 'attr';
  }
  return out;
}

/**
 * Таблица → строки предпросмотра с вердиктами. Без DNS: он идёт отдельно.
 * @returns {{rows: object[], columns: {label: string, samples: string[]}[], roles: object}}
 */
export function buildRows(parsed, { projectId, roles = null }) {
  const { data, header, hasHeader } = parsed;
  if (data.length > IMPORT_LIMITS.maxRows) {
    throw new MailError(`В файле больше ${IMPORT_LIMITS.maxRows.toLocaleString('ru-RU')} строк — разделите его на части`);
  }

  const width = Math.max(header?.length || 0, ...data.slice(0, 2000).map((r) => r.length), 1);
  const finalRoles = validRoles(roles || detectRoles(data, header), width);
  const labels = columnLabels(header, width);

  if (!Object.values(finalRoles).includes('email')) {
    throw new MailError('В таблице не нашлось колонки с адресами. Проверьте, что это та таблица, или укажите колонку вручную');
  }

  const columns = labels.map((label, col) => ({
    label,
    samples: data
      .map((r) => String(r[col] ?? '').trim())
      .filter(Boolean)
      .slice(0, 3),
  }));

  const col = (role) => Object.keys(finalRoles).filter((c) => finalRoles[c] === role).map(Number);
  const emailCols = col('email');
  const [nameCol] = col('name');
  const [firstCol] = col('first');
  const [lastCol] = col('last');
  const attrCols = col('attr');

  const rows = [];
  const firstLine = hasHeader ? 2 : 1;
  let seq = 0;

  data.forEach((cells, index) => {
    if (!cells.some((c) => String(c ?? '').trim())) return;
    const cell = (c) => (c === undefined ? '' : String(cells[c] ?? '').trim());
    const name =
      nameCol !== undefined ? cell(nameCol) : [cell(firstCol), cell(lastCol)].filter(Boolean).join(' ');
    const attrs = {};
    for (const c of attrCols) {
      const value = cell(c);
      if (value) attrs[labels[c]] = value.slice(0, 500);
    }

    const found = [];
    for (const c of emailCols) {
      const value = cell(c);
      if (!value) continue;
      const candidates = emailsIn(value);
      // Ячейка есть, а адреса в ней не нашлось — показываем её как ошибочную,
      // а не теряем молча: «ivan.gmail.com» стоит увидеть глазами.
      found.push(...(candidates.length ? candidates : [value]));
    }

    const rowNo = index + firstLine;
    if (!found.length) {
      rows.push({ rowNo, seq: seq++, email: null, name, attrs, verdict: 'invalid', issues: ['в строке нет адреса'], suggestion: null });
      return;
    }
    for (const raw of found) {
      const check = checkAddress(raw);
      rows.push({
        rowNo,
        seq: seq++,
        email: check.email || String(raw).slice(0, 200),
        name: name.slice(0, 200),
        attrs,
        verdict: check.verdict,
        issues: found.length > 1 ? [...check.issues, 'несколько адресов в строке'] : check.issues,
        suggestion: check.suggestion,
      });
    }
  });

  if (!rows.length) throw new MailError('В файле не нашлось ни одного адреса');

  // Повторы внутри файла: первая строка остаётся, остальные — «повтор».
  const firstSeen = new Map();
  for (const row of rows) {
    if (!row.email || row.verdict === 'invalid') continue;
    const key = row.email;
    if (firstSeen.has(key)) {
      row.verdict = 'duplicate';
      row.issues = [`уже есть в строке ${firstSeen.get(key)}`];
      row.suggestion = null;
    } else firstSeen.set(key, row.rowNo);
  }

  // Стоп-лист школы: не добавляется активным ни при каком выборе.
  const suppressed = db.prepare('SELECT reason FROM mail_suppressions WHERE project_id = ? AND email_hash = ?');
  for (const row of rows) {
    if (!['ok', 'warning', 'fixable'].includes(row.verdict)) continue;
    const hit = suppressed.get(projectId, emailHash(row.email)) || (row.suggestion && suppressed.get(projectId, emailHash(row.suggestion)));
    if (hit) {
      row.verdict = 'suppressed';
      row.issues = [hit.reason === 'erased' ? 'стёрт по просьбе человека' : hit.reason === 'bounced' ? 'адрес не существует' : 'отписался'];
      row.suggestion = null;
    }
  }

  return { rows, columns, roles: finalRoles };
}

function saveRows(importId, rows) {
  db.prepare('DELETE FROM mail_import_rows WHERE import_id = ?').run(importId);
  const insert = db.prepare(
    `INSERT INTO mail_import_rows (import_id, row_no, seq, email, name, attrs, verdict, issues, suggestion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    insert.run(importId, r.rowNo, r.seq, r.email, r.name, JSON.stringify(r.attrs), r.verdict, JSON.stringify(r.issues), r.suggestion);
  }
}

/* ------------------------------- проверка DNS ------------------------------- */

const runs = new Map(); // importId → номер последнего запуска

function startDomainCheck(importId, { resolver = null } = {}) {
  const run = (runs.get(importId) || 0) + 1;
  runs.set(importId, run);

  const domains = db
    .prepare(
      `SELECT DISTINCT substr(email, instr(email, '@') + 1) AS domain FROM mail_import_rows
        WHERE import_id = ? AND verdict IN ('ok', 'warning')`
    )
    .all(importId)
    .map((r) => r.domain);

  const setProgress = (done, total) => {
    if (runs.get(importId) !== run) return;
    db.prepare('UPDATE mail_imports SET progress = ? WHERE id = ?').run(JSON.stringify({ done, total }), importId);
  };
  setProgress(0, domains.length);

  let lastWrite = 0;
  const promise = checkDomains(domains, {
    resolver,
    onProgress: (done, total) => {
      // В базу — не чаще раза в полсекунды: предпросмотр спрашивает раз в секунду.
      if (Date.now() - lastWrite > 500 || done === total) {
        lastWrite = Date.now();
        setProgress(done, total);
      }
    },
  })
    .then((states) => {
      if (runs.get(importId) !== run) return;
      const dead = [...states].filter(([, state]) => state === 'none').map(([domain]) => domain);
      const mark = db.prepare(
        `UPDATE mail_import_rows SET verdict = 'invalid', issues = ?, suggestion = NULL
          WHERE import_id = ? AND verdict IN ('ok', 'warning') AND substr(email, instr(email, '@') + 1) = ?`
      );
      db.exec('BEGIN');
      try {
        for (const domain of dead) mark.run(JSON.stringify([`у домена ${domain} нет почтового сервера`]), importId, domain);
        const unknown = [...states.values()].filter((s) => s === 'unknown').length;
        db.prepare("UPDATE mail_imports SET status = 'preview', progress = ? WHERE id = ? AND status = 'checking'").run(
          JSON.stringify({ done: domains.length, total: domains.length, dead: dead.length, unknown }),
          importId
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    })
    .catch((err) => {
      // DNS не должен хоронить загрузку: без проверки доменов предпросмотр
      // всё равно полезен, просто без одного вида ошибок.
      if (runs.get(importId) !== run) return;
      db.prepare("UPDATE mail_imports SET status = 'preview', progress = ? WHERE id = ? AND status = 'checking'").run(
        JSON.stringify({ failed: err.message }),
        importId
      );
    })
    .finally(() => {
      if (runs.get(importId) === run) runs.delete(importId);
    });
  return promise;
}

/* --------------------------------- операции --------------------------------- */

function getImportRow(id) {
  return db.prepare('SELECT * FROM mail_imports WHERE id = ?').get(Number(id)) || null;
}

function requireOpen(id, projectId = null) {
  const row = getImportRow(id);
  if (!row || (projectId && row.project_id !== Number(projectId))) throw new MailError('Загрузка не найдена', 404);
  if (row.status === 'done') throw new MailError('Эта загрузка уже добавлена в базу', 409);
  if (row.status === 'discarded') throw new MailError('Эта загрузка отменена — загрузите файл заново', 410);
  return row;
}

/** Брошенные загрузки старше суток: чужие адреса не лежат без дела. */
export function dropStaleImports(now = Date.now()) {
  const cutoff = new Date(now - IMPORT_LIMITS.staleHours * 3600000).toISOString();
  const stale = db
    .prepare("SELECT id FROM mail_imports WHERE status IN ('checking', 'preview', 'failed') AND created_at < ?")
    .all(cutoff);
  for (const { id } of stale) discardImport(id, { quiet: true });
  return stale.length;
}

/**
 * @param {{projectId: number, staffId: number|null, bytes: Uint8Array, sourceName: string, listId?: number|null, resolver?: object}} opts
 * @returns {{id: number, check: Promise<void>|null}}
 */
export function createImport({ projectId, staffId = null, bytes, sourceName, listId = null, resolver = null }) {
  dropStaleImports();
  if (bytes.length > IMPORT_LIMITS.maxBytes) throw new MailError('Файл больше 20 МБ — разделите его на части', 413);

  const list = listId ? store.getList(listId) : null;
  if (listId && (!list || list.projectId !== Number(projectId))) throw new MailError('База не найдена', 404);

  const parsed = parseSource(bytes);
  const built = buildRows(parsed, { projectId });

  let id;
  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO mail_imports (project_id, list_id, source_name, source, format, encoding, delimiter, sheet, sheets,
                                   has_header, header, roles, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checking', ?)`
      )
      .run(
        Number(projectId),
        list?.id ?? null,
        String(sourceName || 'файл').slice(0, 200),
        bytes,
        parsed.format,
        parsed.encoding,
        parsed.delimiter,
        parsed.sheet,
        JSON.stringify(parsed.sheets),
        parsed.hasHeader ? 1 : 0,
        JSON.stringify(built.columns),
        JSON.stringify(built.roles),
        staffId
      );
    id = Number(info.lastInsertRowid);
    saveRows(id, built.rows);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { id, check: startDomainCheck(id, { resolver }) };
}

/**
 * Разобрать заново с другими настройками: кодировка, разделитель, лист,
 * заголовок, роли колонок. Решения по опечаткам сбрасываются вместе со строками.
 */
export function reparseImport(id, { projectId, encoding, delimiter, sheet, hasHeader, roles, resolver = null }) {
  const row = requireOpen(id, projectId);
  if (!row.source) throw new MailError('Исходный файл уже удалён — загрузите его заново', 410);

  const overrides = {
    encoding: encoding !== undefined ? encoding : row.encoding || '',
    delimiter: delimiter !== undefined ? delimiter : row.delimiter ?? undefined,
    sheet: sheet !== undefined ? Number(sheet) : row.sheet ?? 0,
    hasHeader: hasHeader !== undefined ? Boolean(hasHeader) : Boolean(row.has_header),
  };
  if (overrides.encoding && !ENCODINGS[overrides.encoding]) throw new MailError('Неизвестная кодировка');
  if (delimiter !== undefined && delimiter !== null && delimiter !== '' && !DELIMITERS[delimiter]) {
    throw new MailError('Неизвестный разделитель');
  }
  // Сменили лист или кодировку — заголовок и колонки могли стать другими.
  if (sheet !== undefined && Number(sheet) !== row.sheet) delete overrides.hasHeader;

  const parsed = parseSource(new Uint8Array(row.source), overrides);
  const built = buildRows(parsed, { projectId: row.project_id, roles: roles || null });

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE mail_imports SET format = ?, encoding = ?, delimiter = ?, sheet = ?, sheets = ?, has_header = ?,
              header = ?, roles = ?, status = 'checking', progress = '{}' WHERE id = ?`
    ).run(
      parsed.format,
      parsed.encoding,
      parsed.delimiter,
      parsed.sheet,
      JSON.stringify(parsed.sheets),
      parsed.hasHeader ? 1 : 0,
      JSON.stringify(built.columns),
      JSON.stringify(built.roles),
      row.id
    );
    saveRows(row.id, built.rows);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { check: startDomainCheck(row.id, { resolver }) };
}

/** Решения по опечаткам: исправить, оставить как есть или пропустить. */
export function setDecisions(id, { projectId, rows = [], all = null }) {
  const row = requireOpen(id, projectId);
  const allowed = ['fix', 'add', 'skip'];
  if (all !== null) {
    if (!allowed.includes(all)) throw new MailError('Неизвестное решение');
    db.prepare("UPDATE mail_import_rows SET decision = ? WHERE import_id = ? AND verdict = 'fixable'").run(all, row.id);
    return;
  }
  const update = db.prepare(
    "UPDATE mail_import_rows SET decision = ? WHERE import_id = ? AND seq = ? AND verdict = 'fixable'"
  );
  for (const r of rows) {
    if (!allowed.includes(r.decision)) throw new MailError('Неизвестное решение');
    update.run(r.decision, row.id, Number(r.seq));
  }
}

/** Какой адрес в итоге добавится из строки. */
function effectiveEmail(r) {
  return r.verdict === 'fixable' && r.decision === 'fix' ? r.suggestion : r.email;
}

function candidateRows(importId, includeWarnings) {
  return db
    .prepare(
      `SELECT seq, row_no, email, name, attrs, verdict, suggestion, decision FROM mail_import_rows
        WHERE import_id = ?
          AND (verdict = 'ok'
               OR (verdict = 'warning' AND ?)
               OR (verdict = 'fixable' AND decision IN ('fix', 'add')))
        ORDER BY seq`
    )
    .all(importId, includeWarnings ? 1 : 0);
}

/**
 * Что произойдёт при подтверждении — без записи. Показывается в предпросмотре
 * до нажатия кнопки: «будет добавлено N, уже в базе M».
 */
export function forecast(id, { projectId, listId = null, includeWarnings = true }) {
  const row = getImportRow(id);
  if (!row || row.project_id !== Number(projectId)) throw new MailError('Загрузка не найдена', 404);

  const suppressed = db.prepare('SELECT 1 FROM mail_suppressions WHERE project_id = ? AND email_hash = ?');
  const member = listId
    ? db.prepare(
        `SELECT 1 FROM mail_contacts c JOIN mail_list_members m ON m.contact_id = c.id
          WHERE c.project_id = ? AND c.email = ? AND m.list_id = ? AND m.removed_at IS NULL`
      )
    : null;
  const known = db.prepare('SELECT 1 FROM mail_contacts WHERE project_id = ? AND email = ?');

  const seen = new Set();
  let add = 0;
  let existed = 0;
  let newContacts = 0;
  let blocked = 0;
  for (const r of candidateRows(row.id, includeWarnings)) {
    const email = effectiveEmail(r);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (r.decision === 'fix' && suppressed.get(row.project_id, emailHash(email))) {
      blocked++;
      continue;
    }
    if (member && member.get(row.project_id, email, Number(listId))) existed++;
    else add++;
    if (!known.get(row.project_id, email)) newContacts++;
  }
  return { add, existed, newContacts, blocked };
}

function verdictCounts(importId) {
  const counts = Object.fromEntries(Object.keys(VERDICTS).map((v) => [v, 0]));
  for (const r of db
    .prepare('SELECT verdict, COUNT(*) AS n FROM mail_import_rows WHERE import_id = ? GROUP BY verdict')
    .all(importId)) {
    counts[r.verdict] = r.n;
  }
  const decisions = { fix: 0, add: 0, skip: 0, undecided: 0 };
  for (const r of db
    .prepare("SELECT decision, COUNT(*) AS n FROM mail_import_rows WHERE import_id = ? AND verdict = 'fixable' GROUP BY decision")
    .all(importId)) {
    decisions[r.decision || 'undecided'] += r.n;
  }
  return { counts, decisions };
}

/**
 * Предпросмотр: как разобрано, что найдено, страница строк.
 * @param {{projectId: number, verdict?: string, page?: number, resolver?: object}} opts
 */
export function readImport(id, { projectId, verdict = '', page = 1, resolver = null }) {
  const row = getImportRow(id);
  if (!row || row.project_id !== Number(projectId)) throw new MailError('Загрузка не найдена', 404);

  // Панель перезапустили посреди проверки доменов — продолжаем, а не висим.
  if (row.status === 'checking' && !runs.has(row.id)) startDomainCheck(row.id, { resolver });

  const where = ['import_id = ?'];
  const params = [row.id];
  if (VERDICTS[verdict]) {
    where.push('verdict = ?');
    params.push(verdict);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM mail_import_rows WHERE ${where.join(' AND ')}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = db
    .prepare(
      `SELECT * FROM mail_import_rows WHERE ${where.join(' AND ')}
        ORDER BY CASE verdict WHEN 'fixable' THEN 0 WHEN 'invalid' THEN 1 WHEN 'warning' THEN 2
                              WHEN 'suppressed' THEN 3 WHEN 'duplicate' THEN 4 ELSE 5 END, seq
        LIMIT ? OFFSET ?`
    )
    .all(...params, PAGE_SIZE, (current - 1) * PAGE_SIZE)
    .map((r) => ({
      seq: r.seq,
      rowNo: r.row_no,
      email: r.email,
      name: r.name,
      attrs: parseJson(r.attrs, {}),
      verdict: r.verdict,
      issues: parseJson(r.issues, []),
      suggestion: r.suggestion,
      decision: r.decision,
    }));

  const fresh = getImportRow(row.id);
  const { counts, decisions } = verdictCounts(row.id);
  return {
    import: {
      id: fresh.id,
      status: fresh.status,
      sourceName: fresh.source_name,
      format: fresh.format,
      formatTitle: FORMATS[fresh.format] || fresh.format,
      encoding: fresh.encoding,
      delimiter: fresh.delimiter,
      sheets: parseJson(fresh.sheets, []),
      sheet: fresh.sheet,
      hasHeader: Boolean(fresh.has_header),
      columns: parseJson(fresh.header, []),
      roles: parseJson(fresh.roles, {}),
      progress: parseJson(fresh.progress, {}),
      listId: fresh.list_id,
      createdAt: fresh.created_at,
      canReparse: Boolean(fresh.source),
    },
    counts,
    decisions,
    rows,
    total,
    page: current,
    pages,
    options: {
      encodings: ENCODINGS,
      delimiters: DELIMITERS,
      roles: COLUMN_ROLES,
      verdicts: VERDICTS,
    },
  };
}

/**
 * Подтверждение: всё — одной транзакцией. Либо база получила адреса и
 * загрузка закрыта, либо не изменилось ничего.
 *
 * @param {{projectId: number, staffId: number|null, listId?: number|null,
 *   newList?: {name: string, consentBasis: string, consentNote?: string, description?: string},
 *   includeWarnings?: boolean}} opts
 */
export function commitImport(id, { projectId, staffId = null, listId = null, newList = null, includeWarnings = true }) {
  const row = requireOpen(id, projectId);
  if (row.status === 'checking') throw new MailError('Дождитесь конца проверки доменов — осталось немного', 409);

  let list = null;
  let stats;
  db.exec('BEGIN');
  try {
    if (listId) {
      list = store.getList(listId);
      if (!list || list.projectId !== row.project_id) throw new MailError('База не найдена', 404);
      if (list.archivedAt) throw new MailError('База в архиве — верните её или выберите другую');
    } else if (newList) {
      list = store.createList(row.project_id, newList, staffId);
    } else {
      throw new MailError('Выберите базу или заведите новую');
    }

    const suppressed = db.prepare('SELECT 1 FROM mail_suppressions WHERE project_id = ? AND email_hash = ?');
    const seen = new Set();
    stats = { added: 0, existed: 0, newContacts: 0, blocked: 0 };
    const attrNames = new Set();

    for (const r of candidateRows(row.id, includeWarnings)) {
      const email = effectiveEmail(r);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      if (suppressed.get(row.project_id, emailHash(email))) {
        stats.blocked++;
        continue;
      }
      const attrs = parseJson(r.attrs, {});
      for (const key of Object.keys(attrs)) attrNames.add(key);
      const contact = store.upsertContact(row.project_id, email, r.name);
      if (contact.created) stats.newContacts++;
      const result = store.addMembership(list.id, contact.id, { attrs, importId: row.id, staffId });
      stats[result === 'added' ? 'added' : 'existed']++;
    }

    // Порядок колонок — как в файле, а не как попались непустые значения.
    const roles = parseJson(row.roles, {});
    const columns = parseJson(row.header, []);
    const ordered = Object.keys(roles)
      .filter((c) => roles[c] === 'attr')
      .map((c) => columns[Number(c)]?.label)
      .filter((label) => label && attrNames.has(label));
    store.mergeListColumns(list.id, ordered);

    const { counts } = verdictCounts(row.id);
    stats.skipped = counts;
    db.prepare(
      `UPDATE mail_imports SET status = 'done', list_id = ?, stats = ?, source = NULL, finished_at = ? WHERE id = ?`
    ).run(list.id, JSON.stringify(stats), nowIso(), row.id);
    db.prepare('DELETE FROM mail_import_rows WHERE import_id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  runs.delete(row.id);
  log(
    'info',
    `рассылка: загружена база «${list.name}» из «${row.source_name}» — добавлено ${stats.added}, уже были ${stats.existed}` +
      (stats.blocked ? `, в стоп-листе ${stats.blocked}` : '')
  );
  return { list: store.getList(list.id), stats };
}

export function discardImport(id, { projectId = null, quiet = false } = {}) {
  const row = getImportRow(id);
  if (!row || (projectId && row.project_id !== Number(projectId))) throw new MailError('Загрузка не найдена', 404);
  if (row.status === 'done') throw new MailError('Эта загрузка уже добавлена в базу', 409);
  runs.delete(row.id);
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE mail_imports SET status = 'discarded', source = NULL, finished_at = ? WHERE id = ?").run(nowIso(), row.id);
    db.prepare('DELETE FROM mail_import_rows WHERE import_id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (!quiet) log('info', `рассылка: загрузка «${row.source_name}» отменена`);
}

/** Незавершённые загрузки школы — чтобы брошенный предпросмотр можно было найти. */
export function pendingImports(projectId) {
  dropStaleImports();
  return db
    .prepare(
      `SELECT i.id, i.source_name, i.status, i.created_at, s.name AS created_by,
              (SELECT COUNT(*) FROM mail_import_rows r WHERE r.import_id = i.id) AS rows
         FROM mail_imports i LEFT JOIN staff s ON s.id = i.created_by
        WHERE i.project_id = ? AND i.status IN ('checking', 'preview')
        ORDER BY i.id DESC`
    )
    .all(Number(projectId))
    .map((r) => ({ id: r.id, sourceName: r.source_name, status: r.status, createdAt: r.created_at, createdBy: r.created_by, rows: r.rows }));
}
