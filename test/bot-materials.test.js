/**
 * Материалы бота: разбор того, что отдают сайты сети, и правила хранения.
 *
 * Разбор проверяется на образцах — теми же формами, что живые сайты отдали
 * 19.10.2026 (`/api/content` и JSON-LD главной). В сеть тесты не ходят:
 * иначе упавший сайт ронял бы сборку.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-bot-mat-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const projects = await import('../src/projects.js');
const materials = await import('../src/bot/materials.js');
const knowledge = await import('../src/bot/knowledge.js');
const { parseContent, parseJsonLd, SITE_BY_SLUG } = await import('../src/bot/site-import.js');

let projectId;
before(() => {
  projectId = projects.createProject({ slug: 'mat', title: 'Материалы' }).id;
});

/* Образцы — та же форма, что у живых сайтов, значения выдуманные. */
const CONTENT = {
  pricing: [
    {
      title: { ua: 'Груповий формат', ru: 'Групповой формат' },
      features: [
        { ua: '8 занять на місяць, 90 хв', ru: '8 занятий в месяц, 90 мин' },
        { ua: 'Група до 6 осіб', ru: 'Группа до 6 человек' },
      ],
      price: '3 800',
      priceUnit: { ua: 'грн/міс', ru: 'грн/мес' },
    },
  ],
  faq: [
    {
      id: 1,
      question: { ua: 'З якого віку ви берете дітей?', ru: 'С какого возраста берёте детей?' },
      answer: { ua: 'З 7 років.', ru: 'С 7 лет.' },
    },
  ],
};

const HTML = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Course","@id":"https://site.test/#course-python","name":"Python для підлітків",
  "description":"Пишемо перші програми.","typicalAgeRange":"12-16","url":"https://site.test/courses/python",
  "offers":{"@type":"Offer","price":"3800","priceCurrency":"UAH"},
  "hasCourseInstance":{"@type":"CourseInstance","courseMode":"online","courseWorkload":"PT3H"}},
 {"@type":"EducationalOrganization","@id":"https://site.test/#org","name":"Школа","url":"https://site.test",
  "telephone":"+380000000000","email":"hi@site.test","priceRange":"3800-4200 UAH",
  "department":[{"@type":"EducationalOrganization","name":"Філія Центр",
   "address":{"@type":"PostalAddress","streetAddress":"вул. Тестова, 1","addressLocality":"Київ"},
   "telephone":"+380000000001"}]}
]}</script></head><body></body></html>`;

test('тарифы с сайта становятся блоком с ценой и составом', () => {
  const { materials: blocks } = parseContent(CONTENT);
  const plan = blocks.find((b) => b.section === 'prices');
  assert.match(plan.title, /Груповий формат/);
  assert.match(plan.title, /3 800 грн\/міс/);
  assert.match(plan.body, /Група до 6 осіб/);
});

test('частые вопросы дают и материал, и пару готовых ответов на двух языках', () => {
  const { materials: blocks, answers } = parseContent(CONTENT);
  assert.ok(blocks.some((b) => b.section === 'faq'));

  assert.equal(answers.length, 2, 'украинский и русский — отдельные ответы');
  const uk = answers.find((a) => a.lang === 'uk');
  const ru = answers.find((a) => a.lang === 'ru');
  assert.equal(uk.answer, 'З 7 років.');
  assert.equal(ru.answer, 'С 7 лет.');
  assert.equal(uk.triggers, uk.question, 'сам вопрос сайта — первая зацепка');
});

test('курс из JSON-LD складывается в блок с возрастом, ценой и форматом', () => {
  const { materials: blocks } = parseJsonLd(HTML, { baseUrl: 'https://site.test' });
  const course = blocks.find((b) => b.section === 'courses');
  assert.equal(course.title, 'Python для підлітків');
  assert.match(course.body, /Вік: 12-16/);
  assert.match(course.body, /Ціна: 3800 UAH/);
  assert.match(course.body, /Формат: онлайн/);
  assert.equal(course.sourceUrl, 'https://site.test/courses/python');
});

test('нагрузка и формат переводятся на человеческий', () => {
  const { materials: blocks } = parseJsonLd(HTML);
  const course = blocks.find((b) => b.section === 'courses');
  assert.match(course.body, /Навантаження: 3 год/, 'PT3H в панели читать невозможно');
  assert.doesNotMatch(course.body, /PT3H/);
});

test('контакты и филиалы собираются в один блок', () => {
  const { materials: blocks } = parseJsonLd(HTML);
  const contacts = blocks.find((b) => b.section === 'contacts');
  assert.match(contacts.body, /\+380000000000/);
  assert.match(contacts.body, /Філія Центр, вул\. Тестова, 1, Київ/);
});

test('объект вместо строки не превращается в [object Object]', () => {
  // Живой сайт отдал areaServed объектом Place — в блок контактов уехало
  // «Працюємо: [object Object]».
  const html = HTML.replace('"priceRange":"3800-4200 UAH"', '"areaServed":{"@type":"Country","name":"Ukraine"},"priceRange":"$"');
  const { materials: blocks } = parseJsonLd(html);
  const contacts = blocks.find((b) => b.section === 'contacts');
  assert.match(contacts.body, /Працюємо: Ukraine/);
  assert.doesNotMatch(contacts.body, /object Object/);
  assert.doesNotMatch(contacts.body, /Діапазон цін/, 'priceRange без чисел человеку ничего не говорит');
});

test('битый JSON-LD не роняет сбор', () => {
  const broken = '<script type="application/ld+json">{ это не json }</script>' + HTML;
  const { materials: blocks } = parseJsonLd(broken);
  assert.ok(blocks.length >= 2, 'остальные блоки всё равно разобрались');
});

test('повторный сбор правит свой блок и не плодит двойников', () => {
  const collected = {
    materials: [{ section: 'courses', sourceKey: 'ld:course:1', title: 'Курс', body: 'Вік: 7-10' }],
  };
  const first = materials.applyCollected(projectId, collected);
  assert.equal(first.added, 1);

  const second = materials.applyCollected(projectId, collected);
  assert.equal(second.added, 0);
  assert.equal(second.same, 1, 'ничего не изменилось — и трогать нечего');

  collected.materials[0].body = 'Вік: 7-12';
  const third = materials.applyCollected(projectId, collected);
  assert.equal(third.updated, 1);
  assert.equal(materials.list(projectId).filter((m) => m.sourceKey === 'ld:course:1').length, 1);
});

test('сбор не трогает написанное владельцем', () => {
  const own = materials.create(projectId, { section: 'own', title: 'Моя заметка', body: 'Только моё' });
  materials.applyCollected(projectId, {
    materials: [{ section: 'courses', sourceKey: 'ld:course:2', title: 'Ещё курс', body: 'текст' }],
  });
  const fresh = materials.get(own.id);
  assert.equal(fresh.body, 'Только моё');
  assert.equal(fresh.origin, 'own');
});

test('блок без содержания не заводится', () => {
  assert.throws(() => materials.create(projectId, { title: 'Пусто', body: '  ' }), /Пустой блок/);
  assert.throws(() => materials.create(projectId, { title: '', body: 'есть' }), /название/);
});

test('«удаление» блока — архив, и он возвращается', () => {
  const m = materials.create(projectId, { title: 'Временный', body: 'текст' });
  materials.setArchived(m.id, true);
  assert.ok(!materials.list(projectId).some((x) => x.id === m.id));
  assert.ok(materials.list(projectId, { archived: true }).some((x) => x.id === m.id));
  materials.setArchived(m.id, false);
  assert.ok(materials.list(projectId).some((x) => x.id === m.id));
});

test('из блока делается заготовка ответа', () => {
  const m = materials.create(projectId, { section: 'prices', title: 'Скільки коштує', body: '3800 грн на місяць' });
  const draft = materials.toAnswer(m.id);
  assert.equal(draft.answer, '3800 грн на місяць');
  assert.equal(draft.triggers, 'Скільки коштує');
  assert.ok(draft.topic, 'рубрика подставляется из раздела материалов');
});

test('заготовки с сайта не предлагаются повторно, если ответ уже заведён', () => {
  const answers = [
    { question: 'З якого віку ви берете дітей?', answer: 'З 7 років.', lang: 'uk', triggers: 'з якого віку' },
    { question: 'Нове питання?', answer: 'Нова відповідь.', lang: 'uk', triggers: 'нове' },
  ];
  knowledge.create(projectId, { question: 'З якого віку ви берете дітей?', answer: 'З 7 років.', triggers: 'вік' });

  const pending = materials.pendingAnswers(projectId, answers);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].question, 'Нове питання?');
});

test('похожие материалы находятся по вопросу клиента', () => {
  materials.create(projectId, { section: 'courses', title: 'Курс Python для підлітків', body: 'Вік 12-16, онлайн' });
  const found = materials.relevant(projectId, 'а є курс пайтон для підлітка?');
  assert.ok(found.length >= 1, 'материал по курсу нашёлся');
  assert.match(found[0].title, /Python/);
});

test('совпадение в названии перевешивает совпадение в тексте', () => {
  // Живой прогон 19.10: на вопрос про Roblox первым шёл блок про Minecraft —
  // в его описании нашлось слово «вивчають», и оно весило как название.
  materials.create(projectId, { section: 'courses', title: 'Minecraft для дітей', body: 'Що саме вивчають: механіки гри' });
  materials.create(projectId, { section: 'courses', title: 'Roblox Studio', body: 'Створюємо свою гру' });
  const found = materials.relevant(projectId, 'а що саме вивчають на Roblox?');
  assert.match(found[0].title, /Roblox/);
});

test('адрес сайта берётся из настроек, иначе по названию проекта', () => {
  assert.equal(materials.siteUrlFor({ slug: 'education' }, {}), SITE_BY_SLUG.education);
  assert.equal(materials.siteUrlFor({ slug: 'education' }, { siteUrl: 'https://своє.site' }), 'https://своє.site');
  assert.equal(materials.siteUrlFor({ slug: 'неизвестный' }, {}), '');
});
