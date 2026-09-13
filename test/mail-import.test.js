/**
 * Распознавание баз адресов — без базы данных.
 *
 * Каждый случай взят из того, как базы школ выглядят на деле: CSV из Excel в
 * windows-1251, «Юникод-текст», ячейки из Google Таблиц, контакты Android в
 * quoted-printable, адреса, набранные в русской раскладке. Ошибка здесь не
 * видна сразу — она всплывает письмом «Здравствуйте, Ð˜Ñ€Ð¸Ð½Ð°» или письмом,
 * ушедшим на чужой домен-опечатку.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';

const { decodeBytes } = await import('../src/mail/import/decode.js');
const { parseCsv, sniffDelimiter } = await import('../src/mail/import/csv.js');
const { detectHeader, detectRoles, columnLabels } = await import('../src/mail/import/columns.js');
const { checkAddress, normalize, maskEmail, emailHash } = await import('../src/mail/import/address.js');
const { extractFromText } = await import('../src/mail/import/text.js');
const { parseVcard, looksLikeVcard } = await import('../src/mail/import/vcard.js');
const { openXlsx, isZip } = await import('../src/mail/import/xlsx.js');
const { checkDomain, checkDomains, clearDomainCache } = await import('../src/mail/import/mx.js');

/** windows-1251 без внешних библиотек: кириллица А–я лежит подряд с 0xC0. */
function cp1251(text) {
  return Uint8Array.from([...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (code < 0x80) return code;
    if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
    const extra = { 'Ё': 0xa8, 'ё': 0xb8, 'І': 0xb2, 'і': 0xb3, 'Ї': 0xaf, 'ї': 0xbf, 'Є': 0xaa, 'є': 0xba };
    if (extra[ch]) return extra[ch];
    throw new Error(`нет в тестовой таблице: ${ch}`);
  }));
}

/* -------------------------------- кодировки -------------------------------- */

test('CSV из Excel в windows-1251 читается кириллицей, а не кракозябрами', () => {
  const out = decodeBytes(cp1251('Имя;Email\nІрина;irina@gmail.com\n'));
  assert.equal(out.encoding, 'windows-1251');
  assert.match(out.text, /Ірина/);
});

test('UTF-8 с меткой и без, «Юникод-текст» Excel в UTF-16LE', () => {
  const plain = new TextEncoder().encode('Олена;olena@ukr.net');
  assert.equal(decodeBytes(plain).encoding, 'utf-8');

  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...plain]);
  const withBom = decodeBytes(bom);
  assert.equal(withBom.encoding, 'utf-8');
  assert.ok(withBom.text.startsWith('Олена'), 'метка BOM не должна попасть в первую ячейку');

  const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from('Имя\tEmail\r\nОля\tolya@i.ua', 'utf16le')]);
  const wide = decodeBytes(utf16);
  assert.equal(wide.encoding, 'utf-16le');
  assert.match(wide.text, /olya@i\.ua/);
});

test('кодировку, выбранную человеком, панель не спорит', () => {
  const bytes = new TextEncoder().encode('Имя');
  assert.equal(decodeBytes(bytes, 'windows-1251').encoding, 'windows-1251');
});

/* ----------------------------------- CSV ----------------------------------- */

test('разделитель угадывается: «;» у Excel, табуляция у скопированных ячеек', () => {
  assert.equal(sniffDelimiter('Имя;Email;Курс\nІра;ira@gmail.com;Дизайн\nОля;olya@ukr.net;Python\n'), ';');
  assert.equal(sniffDelimiter('Имя\tEmail\nІра\tira@gmail.com\n'), '\t');
  assert.equal(sniffDelimiter('ira@gmail.com\nolya@ukr.net\n'), null, 'одна колонка — разделителя нет');
});

test('кавычки, «;» и перенос строки внутри ячейки не рвут запись', () => {
  const rows = parseCsv('Имя;Заметка;Email\r\n"Коваль; Ірина";"строка 1\nстрока 2";ira@gmail.com\r\n\r\nОля;"говорит ""привет""";olya@i.ua', ';');
  assert.equal(rows.length, 3, 'пустая строка между записями — не запись');
  assert.deepEqual(rows[1], ['Коваль; Ірина', 'строка 1\nстрока 2', 'ira@gmail.com']);
  assert.equal(rows[2][1], 'говорит "привет"');
});

/* --------------------------------- колонки --------------------------------- */

test('колонка адреса — по содержимому, имя — по заголовку', () => {
  const rows = [
    ['ПІБ', 'Телефон', 'Контакт для зв\'язку'],
    ['Коваль Ірина', '+380501112233', 'ira@gmail.com'],
    ['Петренко Олег', '+380671112233', 'oleg@ukr.net'],
  ];
  assert.equal(detectHeader(rows), true);
  const roles = detectRoles(rows.slice(1), rows[0]);
  assert.equal(roles[2], 'email', 'адрес узнаётся без слова «email» в заголовке');
  assert.equal(roles[0], 'name');
  assert.equal(roles[1], 'attr');
});

test('«Имя» и «Фамилия» склеиваются, без заголовка имя угадывается осторожно', () => {
  const header = ['Имя', 'Фамилия', 'Почта'];
  const roles = detectRoles([['Ірина', 'Коваль', 'ira@gmail.com']], header);
  assert.deepEqual([roles[0], roles[1], roles[2]], ['first', 'last', 'email']);

  const bare = [['Ірина Коваль', 'ira@gmail.com'], ['Олег', 'oleg@ukr.net']];
  assert.equal(detectHeader(bare), false);
  const guessed = detectRoles(bare, null);
  assert.equal(guessed[0], 'name');
  assert.equal(guessed[1], 'email');
});

test('подписи колонок без заголовка и с повторами', () => {
  assert.deepEqual(columnLabels(['Email', '', 'Email'], 3), ['Email', 'Колонка 2', 'Email 2']);
});

/* ---------------------------------- адреса ---------------------------------- */

test('русская «а» в адресе — предложение исправить, а не молчаливая замена', () => {
  const out = checkAddress('ivan@gmаil.com'); // «а» кириллическая
  assert.equal(out.verdict, 'fixable');
  assert.equal(out.suggestion, 'ivan@gmail.com');
  assert.notEqual(out.email, out.suggestion, 'сам адрес не переписан');
});

test('опечатка в популярном домене, но не в редком и не в коротком', () => {
  assert.equal(checkAddress('olga@gmial.com').suggestion, 'olga@gmail.com');
  assert.equal(checkAddress('olga@ukr.nte').suggestion, 'olga@ukr.net');
  assert.equal(checkAddress('olga@gmail.con').suggestion, 'olga@gmail.com');
  assert.equal(checkAddress('olga@mycomputer.education').verdict, 'ok', 'редкий домен — не опечатка');
  assert.equal(checkAddress('olga@i.ua').verdict, 'ok');
});

test('ящик должности, одноразовая и заблокированная в Украине почта — предупреждения', () => {
  assert.equal(checkAddress('info@school.ua').verdict, 'warning');
  assert.equal(checkAddress('x@mailinator.com').verdict, 'warning');
  const ru = checkAddress('x@yandex.ru');
  assert.equal(ru.verdict, 'warning');
  assert.match(ru.issues[0], /заблокирована/);
});

test('обёртка ячейки снимается, мусор отвергается', () => {
  assert.equal(normalize(' mailto:<Ira.K@Gmail.com>; '), 'ira.k@gmail.com');
  assert.equal(checkAddress('\u00A0ira@gmail.com\u200B').verdict, 'ok');
  assert.equal(checkAddress('ivan.gmail.com').verdict, 'invalid');
  assert.equal(checkAddress('a@@b.com').verdict, 'invalid');
  assert.equal(checkAddress('ivan@localhost').verdict, 'invalid');
  const spaced = checkAddress('iva n@gmail.com');
  assert.equal(spaced.verdict, 'fixable', 'пробел внутри не склеивается молча');
  assert.equal(spaced.suggestion, 'ivan@gmail.com');
});

test('кириллический домен приводится к punycode, кириллица в имени ящика — нет', () => {
  const idn = checkAddress('test@пошта.укр');
  assert.equal(idn.verdict, 'ok');
  assert.match(idn.email, /^test@xn--/);
  assert.equal(checkAddress('оля@пошта.укр').verdict, 'invalid');
});

test('маска и хеш адреса', () => {
  assert.equal(maskEmail('irina@gmail.com'), 'i***@gmail.com');
  assert.equal(emailHash(' Irina@Gmail.com '), emailHash('irina@gmail.com'));
});

/* ------------------------------- текст и vCard ------------------------------- */

test('адреса из текста письма вместе с именами', () => {
  const out = extractFromText('Кому: Ірина Коваль <ira@gmail.com>, "Олег" <oleg@ukr.net>\nещё пишите на info@school.ua.');
  assert.deepEqual(out.rows, [
    ['Ірина Коваль', 'ira@gmail.com'],
    ['Олег', 'oleg@ukr.net'],
    ['', 'info@school.ua'],
  ]);
});

test('vCard Android: имя в quoted-printable, по строке на каждый адрес', () => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=9A=D0=BE=D0=B2=D0=B0=D0=BB=D1=8C;=D0=86=D1=80=D0=B8=D0=BD=D0=B0;;;',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=86=D1=80=D0=B8=D0=BD=D0=B0 =D0=9A=D0=BE=D0=B2=D0=B0=D0=BB=D1=8C',
    'EMAIL;HOME:ira@gmail.com',
    'item1.EMAIL;TYPE=INTERNET:ira.work@school.ua',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Петренко;Олег;;;',
    'EMAIL;TYPE=INTERNET:oleg@ukr.net',
    'END:VCARD',
  ].join('\r\n');
  assert.ok(looksLikeVcard(vcf));
  const out = parseVcard(vcf);
  assert.deepEqual(out.rows.map((r) => [r[0], r[1]]), [
    ['Ірина Коваль', 'ira@gmail.com'],
    ['Ірина Коваль', 'ira.work@school.ua'],
    ['Олег Петренко', 'oleg@ukr.net'],
  ]);
});

/* ---------------------------------- XLSX ---------------------------------- */

/** Минимальный zip: достаточно, чтобы проверить свой разбор без Excel под рукой. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBuf, end]));
}

function sampleXlsx() {
  return makeZip({
    'xl/workbook.xml':
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="Учні" sheetId="1" r:id="rId1"/><sheet name="Архів" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Ім\'я</t></si><si><t>Email</t></si><si><r><t>Ірина </t></r><r><t>Коваль</t></r></si><si><t>ira@gmail.com</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="s"><v>3</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Олег &amp; Ко</t></is></c><c r="C3" t="str"><v>oleg@ukr.net</v></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>old@i.ua</t></is></c></row></sheetData></worksheet>',
  });
}

test('XLSX: общие строки, строка из фрагментов, пропущенная ячейка, второй лист', () => {
  const bytes = sampleXlsx();
  assert.ok(isZip(bytes));
  const book = openXlsx(bytes);
  assert.deepEqual(book.sheets, ['Учні', 'Архів']);
  assert.deepEqual(book.read(0), [
    ["Ім'я", '', 'Email'],
    ['Ірина Коваль', '42', 'ira@gmail.com'],
    ['Олег & Ко', '', 'oleg@ukr.net'],
  ]);
  assert.deepEqual(book.read(1), [['old@i.ua']]);
});

test('повреждённый архив — понятная ошибка, а не падение', () => {
  assert.throws(() => openXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), /повреждён/);
});

/* ----------------------------------- DNS ----------------------------------- */

function fakeResolver(map) {
  const fail = (code) => Object.assign(new Error(code), { code });
  return {
    async resolveMx(domain) {
      const entry = map[domain];
      if (entry === 'mx') return [{ exchange: `mx.${domain}`, priority: 10 }];
      if (entry === 'nullmx') return [{ exchange: '', priority: 0 }];
      if (entry === 'nxdomain') throw fail('ENOTFOUND');
      if (entry === 'timeout') throw fail('ETIMEOUT');
      throw fail('ENODATA');
    },
    async resolve4(domain) {
      if (map[domain] === 'a') return ['203.0.113.7'];
      throw fail('ENODATA');
    },
    async resolve6() {
      throw fail('ENODATA');
    },
  };
}

test('домен без почты отличается от медленного DNS', async () => {
  const resolver = fakeResolver({ 'ok.example': 'mx', 'a.example': 'a', 'gone.example': 'nxdomain', 'nomail.example': 'nullmx', 'slow.example': 'timeout', 'bare.example': 'nodata' });
  assert.equal(await checkDomain('ok.example', resolver), 'ok');
  assert.equal(await checkDomain('a.example', resolver), 'ok', 'без MX почту принимает сам адрес домена');
  assert.equal(await checkDomain('gone.example', resolver), 'none');
  assert.equal(await checkDomain('nomail.example', resolver), 'none', 'нулевой MX — прямой отказ');
  assert.equal(await checkDomain('bare.example', resolver), 'none');
  assert.equal(await checkDomain('slow.example', resolver), 'unknown', 'таймаут — не приговор');
});

test('популярные домены не спрашиваются, «не знаем» не кэшируется', async () => {
  clearDomainCache();
  const asked = [];
  const resolver = fakeResolver({ 'slow.example': 'timeout', 'ok.example': 'mx' });
  const spy = {
    resolveMx: (d) => (asked.push(d), resolver.resolveMx(d)),
    resolve4: resolver.resolve4,
    resolve6: resolver.resolve6,
  };
  const first = await checkDomains(['gmail.com', 'ok.example', 'slow.example', 'ok.example'], { resolver: spy });
  assert.equal(first.get('gmail.com'), 'ok');
  assert.deepEqual(asked.sort(), ['ok.example', 'slow.example']);

  asked.length = 0;
  await checkDomains(['ok.example', 'slow.example'], { resolver: spy });
  assert.deepEqual(asked, ['slow.example'], 'известный ответ взят из кэша, неизвестный спрошен снова');
});
