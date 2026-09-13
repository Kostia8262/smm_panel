/**
 * Проверки Telegram после разбора флоу 13.09.2026.
 *
 * Здесь — то, что ломалось или грозило дублем в канале: HTML-разбор обычного
 * текста, резка подписи посреди ссылки, повтор всего поста из-за упавшего
 * продолжения, «связь есть» у бота без прав и ссылка вместо имени канала.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tg = await import('../src/platforms/telegram.js');

const realFetch = globalThis.fetch;
const creds = { botToken: '1:token', chatId: 'https://t.me/my_computer_academy' };

/** Поддельный Bot API: `handlers[method]` отдаёт result или бросает {code, description}. */
function fakeBot(handlers = {}) {
  const calls = [];
  let nextId = 100;
  globalThis.fetch = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    const fields = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : {};
    calls.push({ method, fields, hasBody: init.body !== undefined });
    const handler = handlers[method];
    try {
      const result = handler ? await handler(fields, calls) : { message_id: nextId++ };
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    } catch (e) {
      const body = { ok: false, error_code: e.code || 400, description: e.description || String(e) };
      if (e.retryAfter) body.parameters = { retry_after: e.retryAfter };
      return { ok: false, status: e.code || 400, json: async () => body };
    }
  };
  return calls;
}

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'));
  const path = join(dir, name);
  writeFileSync(path, 'x');
  return path;
}

test('канал из ссылки t.me становится @именем, приглашение — понятной ошибкой', () => {
  assert.equal(tg.normalizeChatId('https://t.me/my_computer_academy'), '@my_computer_academy');
  assert.equal(tg.normalizeChatId('t.me/s/my_computer_academy'), '@my_computer_academy');
  assert.equal(tg.normalizeChatId('@my_computer_academy'), '@my_computer_academy');
  assert.equal(tg.normalizeChatId('my_computer_academy'), '@my_computer_academy');
  assert.equal(tg.normalizeChatId(' -1001234567890 '), '-1001234567890');
  assert.throws(() => tg.normalizeChatId('https://t.me/+AbCdEf'), /числовой id/);
  assert.throws(() => tg.normalizeChatId('мой канал'), /Не похоже на канал/);
});

test('текст режется по пробелу, не посреди ссылки и не пополам эмодзи', () => {
  const link = 'https://smm.mycomputer.education/r/AbCdEfG';
  const text = `${'слово '.repeat(165)}${link} хвост`; // ссылка пересекает 1024-й символ
  const parts = tg.splitText(text, 1024);
  assert.ok(parts[0].length <= 1024);
  assert.ok(!parts[0].includes('https://smm'), 'ссылка не должна разрываться');
  assert.ok(parts[1].startsWith(link));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));

  const emoji = '😀'.repeat(600); // 1200 единиц UTF-16, без пробелов
  const [head] = tg.splitText(emoji, 1025);
  assert.equal(head.length % 2, 0, 'суррогатная пара не должна разрезаться');

  assert.deepEqual(tg.splitText('коротко', 1024), ['коротко']);
  assert.deepEqual(tg.splitText('', 1024), []);
});

test('абзац предпочтительнее пробела', () => {
  const text = `${'а'.repeat(700)}\n\n${'б '.repeat(200)}`;
  const [head] = tg.splitText(text, 1024);
  assert.equal(head, 'а'.repeat(700));
});

test('текст уходит без HTML-разметки — «Q&A <3» не ломает пост', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot();
  const out = await tg.publish({ text: 'Q&A <3 ціна <500 грн', creds });
  assert.equal(calls[0].method, 'sendMessage');
  assert.equal(calls[0].fields.chat_id, '@my_computer_academy');
  assert.equal(calls[0].fields.text, 'Q&A <3 ціна <500 грн');
  assert.equal(calls[0].fields.parse_mode, undefined);
  assert.equal(out.url, 'https://t.me/my_computer_academy/100');
});

test('длинная подпись: фото + продолжение, id всех сообщений в externalId', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot();
  const text = `${'слово '.repeat(300)}конец`;
  const out = await tg.publish({ text, media: [{ kind: 'image', path: tmpFile('a.jpg') }], creds });
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendMessage']);
  assert.ok(calls[0].fields.caption.length <= 1024);
  assert.equal(out.externalId, '100,101');
  assert.equal(out.warning, undefined);
});

test('упавшее продолжение не роняет пост — иначе повтор выпустит фото дублем', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  fakeBot({
    sendMessage: () => {
      throw { code: 400, description: 'Bad Request: something' };
    },
  });
  const text = `${'слово '.repeat(300)}конец`;
  const out = await tg.publish({ text, media: [{ kind: 'image', path: tmpFile('a.jpg') }], creds });
  assert.equal(out.externalId, '100');
  assert.match(out.warning, /продолжение текста/);
});

test('ошибка главного сообщения — это ошибка поста', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  fakeBot({
    sendPhoto: () => {
      throw { code: 403, description: 'Forbidden: bot is not a member of the channel chat' };
    },
  });
  await assert.rejects(
    () => tg.publish({ text: 'x', media: [{ kind: 'image', path: tmpFile('a.jpg') }], creds }),
    /not a member/
  );
});

test('429 пережидается и отправка повторяется', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  let first = true;
  const calls = fakeBot({
    sendMessage: () => {
      if (first) {
        first = false;
        throw { code: 429, description: 'Too Many Requests', retryAfter: 0.01 };
      }
      return { message_id: 7 };
    },
  });
  const out = await tg.publish({ text: 'привет', creds });
  assert.equal(calls.length, 2);
  assert.equal(out.externalId, '7');
});

test('видео уходит с размерами, длительностью и перемоткой', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot();
  await tg.publish({
    text: 'ролик',
    media: [{ kind: 'video', path: tmpFile('v.mp4'), width: 1080, height: 1920, duration: 12.4 }],
    creds,
  });
  const f = calls[0].fields;
  assert.equal(calls[0].method, 'sendVideo');
  assert.deepEqual([f.width, f.height, f.duration, f.supports_streaming], ['1080', '1920', '12', 'true']);
});

test('альбом: id всех кадров, видео в альбоме с размерами', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot({ sendMediaGroup: () => [{ message_id: 1 }, { message_id: 2 }] });
  const out = await tg.publish({
    text: 'альбом',
    media: [
      { kind: 'image', path: tmpFile('a.jpg') },
      { kind: 'video', path: tmpFile('v.mp4'), width: 720, height: 1280, duration: 5 },
    ],
    creds,
  });
  const group = JSON.parse(calls[0].fields.media);
  assert.equal(group[0].caption, 'альбом');
  assert.equal(group[0].parse_mode, undefined);
  assert.equal(group[1].height, 1280);
  assert.equal(out.externalId, '1,2');
});

test('удаление снимает все сообщения поста; уже снятое не мешает', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot({
    deleteMessage: (f) => {
      if (f.message_id === '11') throw { code: 400, description: 'Bad Request: message to delete not found' };
      return true;
    },
  });
  await tg.remove('11,12', creds);
  assert.deepEqual(calls.map((c) => c.fields.message_id), ['11', '12']);

  fakeBot({
    deleteMessage: () => {
      throw { code: 400, description: "Bad Request: message can't be deleted" };
    },
  });
  await assert.rejects(() => tg.remove('5', creds), /can't be deleted/);
});

test('права бота: не админ канала — не «связь есть»', () => {
  const channel = { type: 'channel' };
  assert.equal(tg.botRights(channel, { status: 'left' }).canPost, false);
  assert.equal(tg.botRights(channel, { status: 'administrator', can_post_messages: false }).canPost, false);
  assert.deepEqual(
    tg.botRights(channel, { status: 'administrator', can_post_messages: true, can_delete_messages: false }),
    { canPost: true, canDelete: false, canPin: false, problem: null }
  );
  assert.equal(tg.botRights({ type: 'supergroup' }, { status: 'member' }).canPost, true);
});

test('проверка связи: без прав — ошибка, без удаления — предупреждение', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const base = {
    getMe: () => ({ id: 42, username: 'my_computer_smm_bot' }),
    getChat: () => ({ id: -1001, type: 'channel', title: 'Академія' }),
  };

  const calls = fakeBot({ ...base, getChatMember: () => ({ status: 'left' }) });
  await assert.rejects(() => tg.check(creds), /не администратор/);
  assert.equal(calls[0].hasBody, false, 'getMe без тела — пустую форму Telegram отвергает 400');
  assert.equal(calls[2].fields.user_id, '42');

  fakeBot({ ...base, getChatMember: () => ({ status: 'administrator', can_post_messages: true }) });
  const res = await tg.check(creds);
  assert.equal(res.chat, 'Академія');
  assert.match(res.warning, /Удаление сообщений/);
});

/* ---------------- закреп, превью, кнопка, правка вышедшего (13.09.2026) ---------------- */

const { storeOptions, parseOptions, optionIssues } = await import('../src/target-options.js');

test('настройки: лишнее отбрасывается, включённая кнопка хранится, не у Telegram — ничего', () => {
  assert.equal(storeOptions('telegram', { pin: true, noPreview: false, hack: 1 }), '{"pin":true}');
  assert.equal(storeOptions('telegram', { button: { text: ' ', url: '' } }), '{"button":{"text":"","url":""}}', 'включённая кнопка хранится и пустой');
  assert.equal(storeOptions('telegram', { button: { text: 'Записатися', url: '' } }), '{"button":{"text":"Записатися","url":""}}');
  assert.equal(storeOptions('threads', { pin: true }), null);
  assert.deepEqual(parseOptions('битый json'), {});
});

test('кнопка без ссылки, с кривой ссылкой или у альбома — отказ проверки', () => {
  const issues = (button, mediaCount = 0) => optionIssues('telegram', { button }, { mediaCount }).blockers.join(' | ');
  assert.match(issues({ text: 'Записатися', url: '' }), /нет ссылки/);
  assert.match(issues({ text: '', url: 'https://mycomputer.education' }), /нет текста/);
  assert.match(issues({ text: 'Записатися', url: 'mycomputer' }), /не адрес сайта/);
  assert.match(issues({ text: 'Записатися', url: 'https://mycomputer.education' }, 2), /альбому/);
  assert.equal(issues({ text: 'Записатися', url: 'https://mycomputer.education' }, 1), '');
});

test('публикация: превью выключено, кнопка под последним сообщением, закреп без уведомления', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot({ pinChatMessage: () => true });
  const text = `${'слово '.repeat(900)}конец`; // два сообщения
  const out = await tg.publish({
    text,
    creds,
    options: { pin: true, noPreview: true, button: { text: 'Записатися', url: 'https://x.ua/r/abc' } },
  });
  const [first, second, pin] = calls;
  assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendMessage', 'pinChatMessage']);
  assert.equal(first.fields.reply_markup, undefined, 'кнопка не у первого из двух');
  assert.deepEqual(JSON.parse(second.fields.reply_markup).inline_keyboard[0][0], { text: 'Записатися', url: 'https://x.ua/r/abc' });
  assert.equal(JSON.parse(first.fields.link_preview_options).is_disabled, true);
  assert.equal(pin.fields.message_id, '100');
  assert.equal(pin.fields.disable_notification, 'true');
  assert.equal(out.warning, undefined);
});

test('незакрепившийся пост — замечание, а не ошибка публикации', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  fakeBot({
    pinChatMessage: () => {
      throw { code: 400, description: 'Bad Request: not enough rights to manage pinned messages in the chat' };
    },
  });
  const out = await tg.publish({ text: 'пост', creds, options: { pin: true } });
  assert.equal(out.externalId, '100');
  assert.match(out.warning, /не закрепился/);
});

test('фото с кнопкой: клавиатура у самого фото', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot();
  await tg.publish({
    text: 'подпись',
    media: [{ kind: 'image', path: tmpFile('a.jpg') }],
    creds,
    options: { button: { text: 'Так', url: 'https://x.ua' } },
  });
  assert.ok(calls[0].fields.reply_markup.includes('https://x.ua'));
});

test('правка текстового поста: текст, превью, кнопка; «не изменилось» — не ошибка', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot({
    editMessageText: (f) => {
      if (f.text === 'тот же') throw { code: 400, description: 'Bad Request: message is not modified' };
      return true;
    },
    unpinChatMessage: () => true,
  });
  const out = await tg.edit('7', { text: 'новый текст', creds, options: { noPreview: true, button: { text: 'Так', url: 'https://x.ua' } } });
  assert.equal(calls[0].method, 'editMessageText');
  assert.equal(calls[0].fields.message_id, '7');
  assert.equal(calls[0].fields.text, 'новый текст');
  assert.ok(calls[0].fields.reply_markup.includes('x.ua'));
  assert.equal(calls[1].method, 'unpinChatMessage');
  assert.equal(out.externalId, '7');

  await tg.edit('7', { text: 'тот же', creds });
});

test('правка: кнопку убрали — уходит пустая клавиатура', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot({ editMessageText: () => true, unpinChatMessage: () => true });
  await tg.edit('7', { text: 'текст', creds, options: {} });
  assert.deepEqual(JSON.parse(calls[0].fields.reply_markup), { inline_keyboard: [] });
});

test('правка: текст стал короче — лишнее продолжение удаляется; длиннее — отказ', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot({ editMessageText: () => true, deleteMessage: () => true, unpinChatMessage: () => true });
  const out = await tg.edit('10,11', { text: 'коротко', creds });
  assert.deepEqual(calls.map((c) => c.method), ['editMessageText', 'deleteMessage', 'unpinChatMessage']);
  assert.equal(calls[1].fields.message_id, '11');
  assert.equal(out.externalId, '10');

  fakeBot();
  await assert.rejects(() => tg.edit('10', { text: 'слово '.repeat(1000), creds }), /в середину канала нельзя/);
});

test('правка альбома: подпись у первого файла, хвост — после файлов, кнопка у хвоста', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  const calls = fakeBot({ editMessageCaption: () => true, editMessageText: () => true, unpinChatMessage: () => true });
  const media = [{ kind: 'image' }, { kind: 'image' }];
  const text = `${'слово '.repeat(300)}конец`; // подпись + хвост
  await tg.edit('1,2,3', { text, media, creds, options: { button: { text: 'Так', url: 'https://x.ua' } } });
  assert.equal(calls[0].method, 'editMessageCaption');
  assert.equal(calls[0].fields.message_id, '1');
  assert.equal(calls[0].fields.reply_markup, undefined, 'у альбома клавиатуры нет');
  assert.equal(calls[1].method, 'editMessageText');
  assert.equal(calls[1].fields.message_id, '3');
  assert.ok(calls[1].fields.reply_markup.includes('x.ua'));
});
