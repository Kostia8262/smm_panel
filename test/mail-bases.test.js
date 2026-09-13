/**
 * Базы рассылки на настоящей (временной) базе данных.
 *
 * Главное здесь — не «загружается ли файл», а три обещания, нарушение которых
 * видно получателям, а не нам:
 *   — отписавшийся не возвращается с повторной загрузкой той же базы;
 *   — стёртый по просьбе человек не возвращается никогда;
 *   — опечатка в адресе не исправляется молча.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-mail-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const staff = await import('../src/staff.js');
const store = await import('../src/mail/store.js');
const pipeline = await import('../src/mail/import/pipeline.js');
const { clearDomainCache } = await import('../src/mail/import/mx.js');

let projectId;
let otherProjectId;
let ownerId;

/** DNS без сети: у «dead.example» почты нет, остальные домены живы. */
const resolver = {
  async resolveMx(domain) {
    if (domain === 'dead.example') throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return [{ exchange: `mx.${domain}`, priority: 10 }];
  },
  async resolve4() {
    return [];
  },
  async resolve6() {
    return [];
  },
};

const CSV = [
  'Имя;Email;Курс',
  'Ірина Коваль;ira@gmail.com;Дизайн',
  'Олег;OLEG@ukr.net;Python',
  'Олег повтор;oleg@ukr.net;Python',
  'Катя;katya@gmial.com;Дизайн',
  'Бухгалтерия;info@school.example;',
  'Мёртвый домен;ghost@dead.example;',
  'Без адреса;;Дизайн',
  '"=cmd|\' /C calc\'!A0";formula@gmail.com;',
].join('\r\n');

const bytes = (text) => new TextEncoder().encode(text);

async function importText(text, extra = {}) {
  const { id, check } = pipeline.createImport({ projectId, staffId: ownerId, bytes: bytes(text), sourceName: 'база.csv', resolver, ...extra });
  await check;
  return id;
}

before(() => {
  clearDomainCache();
  db.exec("INSERT INTO projects (slug, title, position) VALUES ('mail-a', 'Академия', 90), ('mail-b', 'FluentFox', 91)");
  projectId = db.prepare("SELECT id FROM projects WHERE slug = 'mail-a'").get().id;
  otherProjectId = db.prepare("SELECT id FROM projects WHERE slug = 'mail-b'").get().id;
  ownerId = staff.create({ name: 'Владелец рассылки', role: 'owner' }).id;
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // База может быть ещё занята — временный каталог подчистит система.
  }
});

test('права: содержимое баз — только владельцу, названия баз — и СММщику', () => {
  assert.equal(staff.can('smm', 'mail'), true);
  assert.equal(staff.can('smm', 'mail_contacts'), false);
  assert.equal(staff.can('owner', 'mail_contacts'), true);
});

let firstImport;
let listId;

test('предпросмотр раскладывает строки по вердиктам, ничего не записывая в базу школы', async () => {
  firstImport = await importText(CSV);
  const data = pipeline.readImport(firstImport, { projectId });

  assert.equal(data.import.status, 'preview');
  assert.equal(data.import.format, 'csv');
  assert.equal(data.import.hasHeader, true);
  assert.deepEqual(data.import.columns.map((c) => c.label), ['Имя', 'Email', 'Курс']);
  assert.deepEqual(data.counts, { ok: 3, warning: 1, fixable: 1, invalid: 2, duplicate: 1, suppressed: 0 });

  const dead = pipeline.readImport(firstImport, { projectId, verdict: 'invalid' }).rows.find((r) => r.email === 'ghost@dead.example');
  assert.match(dead.issues[0], /нет почтового сервера/);

  const contacts = db.prepare('SELECT COUNT(*) AS n FROM mail_contacts').get().n;
  assert.equal(contacts, 0, 'до подтверждения база школы не тронута');
});

test('опечатка не добавляется, пока человек не решил; решение «исправить» даёт исправленный адрес', () => {
  const before = pipeline.forecast(firstImport, { projectId });
  assert.equal(before.add, 4, 'три готовых и одно предупреждение; опечатка ждёт решения');

  pipeline.setDecisions(firstImport, { projectId, all: 'fix' });
  const after = pipeline.forecast(firstImport, { projectId });
  assert.equal(after.add, 5);

  const result = pipeline.commitImport(firstImport, {
    projectId,
    staffId: ownerId,
    newList: { name: 'Ученики 2026', consentBasis: 'client' },
  });
  listId = result.list.id;
  assert.equal(result.stats.added, 5);
  assert.deepEqual(result.list.columns, ['Курс']);

  const katya = db.prepare("SELECT email FROM mail_contacts WHERE email LIKE 'katya@%'").get();
  assert.equal(katya.email, 'katya@gmail.com');

  const row = db.prepare('SELECT source FROM mail_imports WHERE id = ?').get(firstImport);
  assert.equal(row.source, null, 'исходный файл стёрт после подтверждения');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_import_rows WHERE import_id = ?').get(firstImport).n, 0);
});

test('повторная загрузка той же базы не задваивает', async () => {
  const again = await importText(CSV);
  pipeline.setDecisions(again, { projectId, all: 'fix' });
  const forecast = pipeline.forecast(again, { projectId, listId });
  assert.equal(forecast.add, 0);
  assert.equal(forecast.existed, 5);

  const result = pipeline.commitImport(again, { projectId, staffId: ownerId, listId });
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.existed, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_contacts WHERE project_id = ?').get(projectId).n, 5);
});

test('отписанный вручную не возвращается повторной загрузкой', async () => {
  const oleg = db.prepare("SELECT id FROM mail_contacts WHERE email = 'oleg@ukr.net'").get();
  store.bulk({ projectId, ids: [oleg.id], action: 'unsubscribe', note: 'попросил по телефону' });

  const again = await importText(CSV);
  const data = pipeline.readImport(again, { projectId, verdict: 'suppressed' });
  assert.equal(data.counts.suppressed, 1);
  assert.equal(data.rows[0].email, 'oleg@ukr.net');

  pipeline.commitImport(again, { projectId, staffId: ownerId, listId });
  const status = db.prepare('SELECT status FROM mail_contacts WHERE id = ?').get(oleg.id).status;
  assert.equal(status, 'unsubscribed');
});

test('стёртый по просьбе исчезает, но в стоп-листе остаётся хешем', async () => {
  const ira = db.prepare("SELECT id FROM mail_contacts WHERE email = 'ira@gmail.com'").get();
  store.erase(ira.id);
  assert.equal(store.getContactRow(ira.id), null);

  const dump = JSON.stringify(db.prepare('SELECT * FROM mail_suppressions').all());
  assert.ok(!dump.includes('ira@gmail.com'), 'адреса открытым текстом в стоп-листе нет');

  const again = await importText(CSV);
  const suppressed = pipeline.readImport(again, { projectId, verdict: 'suppressed' }).rows.map((r) => r.email);
  assert.ok(suppressed.includes('ira@gmail.com'));
  assert.throws(() => store.addContactManually({ listId, email: 'ira@gmail.com' }), /стоп-листе/);
  pipeline.discardImport(again, { projectId });
  assert.equal(db.prepare('SELECT source FROM mail_imports WHERE id = ?').get(again).source, null);
});

test('подписку возвращают только с причиной', () => {
  const oleg = db.prepare("SELECT id FROM mail_contacts WHERE email = 'oleg@ukr.net'").get();
  assert.throws(() => store.resubscribe(oleg.id, '  '), /почему/);
  const contact = store.resubscribe(oleg.id, 'написал сам, хочет письма');
  assert.equal(contact.status, 'active');
  assert.equal(store.isSuppressed(projectId, 'oleg@ukr.net'), false);
});

test('ручное добавление: опечатку не принимает, адрес чистит', () => {
  assert.throws(() => store.addContactManually({ listId, email: 'new@gmial.com' }), /gmail\.com/);
  const out = store.addContactManually({ listId, email: ' New.Person@Gmail.com ', name: 'Нова' });
  assert.equal(out.created, true);
  assert.equal(store.getContactRow(out.contactId).email, 'new.person@gmail.com');
});

test('поиск по имени без учёта регистра — и по кириллице', () => {
  store.addContactManually({ listId, email: 'olena@ukr.net', name: 'Олена Шевчук' });
  const found = store.listContacts({ projectId, listId, q: 'ОЛЕНА' });
  assert.equal(found.total, 1);
  assert.equal(found.contacts[0].email, 'olena@ukr.net');
  assert.equal(store.listContacts({ projectId, listId, status: 'unsubscribed' }).total, 0);
});

test('выгрузка открывается в Excel кириллицей и не запускает формулы', () => {
  const { csv } = store.exportCsv({ projectId, listId });
  assert.ok(csv.startsWith('\uFEFF'), 'BOM нужен Excel для UTF-8');
  assert.match(csv, /^\uFEFFEmail;Имя;Состояние;Добавлен;Курс/);
  assert.ok(!/;=cmd/.test(csv) && !/\r\n=cmd/.test(csv), 'ячейка-формула экранирована');
  assert.match(csv, /'=cmd/);
});

test('школы не видят и не трогают контакты друг друга', () => {
  const foreignList = store.createList(otherProjectId, { name: 'Чужая база', consentBasis: 'form' });
  const foreign = store.addContactManually({ listId: foreignList.id, email: 'ira@gmail.com' });
  assert.equal(foreign.created, true, 'стоп-лист академии не действует на FluentFox');

  assert.equal(store.listContacts({ projectId: otherProjectId }).total, 1);
  assert.throws(() => store.bulk({ projectId, ids: [foreign.contactId], action: 'unsubscribe' }), /другой школы/);
  assert.throws(() => store.bulk({ projectId, ids: [store.listContacts({ projectId, listId }).contacts[0].id], action: 'copy', targetListId: foreignList.id }), /этой школы/);
});

test('база в архиве не принимает адреса, сводка школы считает людей один раз', () => {
  const second = store.createList(projectId, { name: 'Родители', consentBasis: 'client' });
  const oleg = db.prepare("SELECT id FROM mail_contacts WHERE email = 'oleg@ukr.net' AND project_id = ?").get(projectId);
  store.bulk({ projectId, ids: [oleg.id], action: 'copy', targetListId: second.id });

  const summary = store.projectSummary(projectId);
  const people = db.prepare('SELECT COUNT(*) AS n FROM mail_contacts WHERE project_id = ?').get(projectId).n;
  assert.equal(summary.total, people, 'человек в двух базах — один контакт');

  store.updateList(second.id, { archived: true });
  assert.throws(() => store.addContactManually({ listId: second.id, email: 'x@ukr.net' }), /архиве/);
  assert.equal(store.listLists(projectId).some((l) => l.id === second.id), false);
  assert.equal(store.listLists(projectId, { includeArchived: true }).some((l) => l.id === second.id), true);
});

test('основание согласия обязательно, для «Другого» — с пояснением', () => {
  assert.throws(() => store.createList(projectId, { name: 'Без основания' }), /основании/);
  assert.throws(() => store.createList(projectId, { name: 'Прочие', consentBasis: 'other' }), /опишите/);
});

test('вставленный текст и смена настроек разбора без повторной загрузки', async () => {
  const pasted = await importText('Кому: Ірина <ira2@gmail.com>, Петро <petro@ukr.net>');
  const data = pipeline.readImport(pasted, { projectId });
  assert.equal(data.import.format, 'text');
  assert.equal(data.counts.ok, 2);

  const csvId = await importText('Email;Имя\nfirst@ukr.net;Перший\nsecond@ukr.net;Другий');
  assert.equal(pipeline.readImport(csvId, { projectId }).import.hasHeader, true);
  const { check } = pipeline.reparseImport(csvId, { projectId, hasHeader: false, resolver });
  await check;
  const reread = pipeline.readImport(csvId, { projectId });
  assert.equal(reread.counts.invalid, 1, 'строка заголовка без флага стала строкой без адреса');
});

test('пробел, разрезавший имя ящика, не превращается в чужой готовый адрес', async () => {
  const id = await importText('Имя;Email\nЛіна;lina danyliuk@gmail.com\nІрина;Ірина ira3@gmail.com\nТарас;taras@gmail.com');
  const rows = pipeline.readImport(id, { projectId }).rows;
  const lina = rows.find((r) => r.email.includes('danyliuk'));
  assert.equal(lina.verdict, 'fixable', 'хвост «danyliuk@gmail.com» — чужой ящик, его нельзя считать готовым');
  assert.equal(lina.suggestion, 'linadanyliuk@gmail.com');
  const shifted = await importText('Имя;Email;Город\nГанна;hanna@gmail.com;Дніпро\nyevhen@ukr.net;;Київ');
  const moved = pipeline.readImport(shifted, { projectId }).rows.find((r) => r.email === 'yevhen@ukr.net');
  assert.equal(moved.verdict, 'ok', 'адрес, уехавший в колонку имени, не теряется');
  assert.equal(moved.name, '', 'сам адрес не становится именем');
  assert.ok(moved.issues.includes('адрес не в своей колонке'));
  pipeline.discardImport(shifted, { projectId });

  const ira = rows.find((r) => r.email.includes('ira3'));
  assert.equal(ira.verdict, 'ok', 'имя перед адресом в той же ячейке — не часть адреса');
  assert.equal(ira.email, 'ira3@gmail.com');
  pipeline.discardImport(id, { projectId });
});

test('брошенная загрузка стирается через сутки', async () => {
  const id = await importText('stale@ukr.net');
  db.prepare("UPDATE mail_imports SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(id);
  assert.ok(pipeline.dropStaleImports() >= 1);
  assert.equal(db.prepare('SELECT status FROM mail_imports WHERE id = ?').get(id).status, 'discarded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_import_rows WHERE import_id = ?').get(id).n, 0);
});
