/**
 * Шаблон письма: то, что увидит получатель, и то, чего он увидеть не должен.
 *
 * Текст письма пишет человек в редакторе — значит в нём рано или поздно
 * окажутся угловые скобки, `javascript:` в ссылке и подстановка без имени.
 * Письмо от этого не должно ни ломаться, ни исполнять чужое.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderLetter, sampleBlocks, inlineMarkup, safeUrl, personalize, escapeHtml } = await import('../src/mail/compose/render.js');
const { brandFor, IMAGE_SLOTS } = await import('../src/mail/compose/brand.js');

const project = { id: 1, slug: 'education', title: "Комп'ютерна академія", signature: "Комп'ютерна академія My Computer Academy\nТелефон: +38 (095) 000-00-00" };
const brand = brandFor(project);

test('разметка текста: жирный, курсив, ссылка — и ничего сверх', () => {
  const html = inlineMarkup('у 2 групах **важливо** та _тихо_ [сайт](https://example.com/a_b_c) <img src=x onerror=alert(1)>', brand);
  assert.match(html, /у 2 групах/, 'цифры в тексте не превращаются в ссылки');
  assert.match(html, /<strong[^>]*>важливо<\/strong>/);
  assert.match(html, /<em>тихо<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a_b_c"/, 'подчёркивания в адресе не становятся курсивом');
  assert.ok(!html.includes('<img'), 'HTML из текста не проходит');
});

test('ссылки только http(s), mailto и tel', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('https://ok.example/путь'), 'https://ok.example/путь');
  assert.equal(safeUrl('mailto:hi@example.com'), 'mailto:hi@example.com');
  assert.equal(safeUrl('https://x.example/" onmouseover="x'), '');
  assert.ok(!inlineMarkup('[клік](javascript:alert(1))', brand).includes('href'));
});

test('подстановка имени с запасным словом', () => {
  assert.equal(personalize('{{name|Друже}}, доброго дня!', { name: 'Ірина' }), 'Ірина, доброго дня!');
  assert.equal(personalize('{{name|Друже}}, доброго дня!', {}), 'Друже, доброго дня!');
  assert.equal(personalize('{{ name }}!', { name: '  ' }), '!');
});

test('письмо: заголовок экранирован, кнопка без адреса не рисуется, отписка на месте', () => {
  const { html, text } = renderLetter({
    brand,
    subject: 'Тема <script>',
    preheader: 'Прехедер',
    blocks: [
      { type: 'heading', text: 'Заголовок <b>не жирний</b>' },
      { type: 'button', text: 'Без адреси', href: 'javascript:void(0)' },
      { type: 'button', text: 'Записатися', href: 'https://mycomputer.education' },
      { type: 'unknown', text: 'пропадає' },
    ],
    signature: project.signature,
    reason: 'ви підписалися на новини школи',
    unsubscribeUrl: 'https://smm.example/u/abc.def',
  });
  assert.ok(!html.includes('<script>') && !html.includes('<b>не'), 'текст из редактора попал в HTML как разметка');
  assert.ok(!html.includes('Без адреси'), 'кнопка без безопасного адреса нарисована');
  assert.match(html, /href="https:\/\/smm\.example\/u\/abc\.def"/);
  assert.ok(!html.includes('пропадає'), 'неизвестный блок попал в письмо');
  assert.match(text, /Записатися: https:\/\/mycomputer\.education/);
  assert.match(text, /Відписатися: https:\/\/smm\.example\/u\/abc\.def/);
  assert.equal((html.match(/Комп&#39;ютерна академія My Computer Academy/g) || []).length, 1, 'название школы в подвале не повторяется');
});

test('образец укладывается в предел Gmail с запасом и показывает размеры картинок', () => {
  const { html } = renderLetter({ brand, subject: 'Образець', blocks: sampleBlocks(project, brand), signature: project.signature, unsubscribeUrl: 'https://x/u/t' });
  assert.ok(Buffer.byteLength(html) < 95 * 1024, 'Gmail обрезает письма после 102 КБ HTML');
  assert.ok(html.includes(`${IMAGE_SLOTS.hero.width} × ${IMAGE_SLOTS.hero.height} px`));
  assert.ok(html.includes(`${IMAGE_SLOTS.inline.width} × ${IMAGE_SLOTS.inline.height} px`));
  assert.ok(!/\{\{/.test(html), 'подстановка осталась неразобранной');
  assert.match(html, /<meta name="color-scheme" content="light only">/);
});

test('школа без своего бренда получает ту же вёрстку в цвете проекта', () => {
  const other = brandFor({ slug: 'fluentfox', title: 'FluentFox', accent: '#6fc39a' });
  assert.equal(other.primary, '#6fc39a');
  assert.equal(other.logo, '', 'чужой логотип академии не подставляется');
  assert.equal(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
});
