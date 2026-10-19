/**
 * Сбор материалов с сайта школы.
 *
 * Сайты сети отдают всё нужное машиночитаемо, и разбирать разметку глазами не
 * нужно (проверено 19.10.2026 на mycomputer.education):
 *
 *   /api/content   — тарифы с составом и частые вопросы СРАЗУ НА ДВУХ ЯЗЫКАХ;
 *   JSON-LD главной — Course на каждый курс (возраст, цена, формат, ссылка),
 *                     EducationalOrganization (телефон, почта, филиалы),
 *                     FAQPage (те же вопросы, уже собранные).
 *
 * Разбор отделён от загрузки намеренно: тесты проверяют разбор на образцах,
 * не ходя в сеть.
 */

/** Сайт школы по слагу проекта. Владелец может задать свой в настройках. */
export const SITE_BY_SLUG = {
  education: 'https://mycomputer.education',
  school: 'https://mycomputer.school',
  fluentfox: 'https://fluent-fox.site',
  child: 'https://child.mycomputer.education',
};

export class ImportError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const clean = (text) =>
  String(text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Значение schema.org человеческим текстом.
 *
 * Поля бывают строкой, объектом и списком вперемешку: `areaServed` на главной
 * оказался объектом Place, и в блок контактов уехало «[object Object]».
 */
function textOf(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const inner = value.name || value.addressLocality || value.addressRegion || value.addressCountry || value.streetAddress;
    return inner ? textOf(inner) : '';
  }
  return clean(value);
}

/**
 * Нагрузка курса приходит в формате ISO 8601 («PT3H»). Боту и человеку это
 * ничего не говорит, поэтому переводим в часы и минуты.
 */
function workload(value) {
  const raw = clean(value);
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(raw);
  if (!m) return raw;
  const parts = [];
  if (m[1]) parts.push(`${m[1]} тиж.`);
  if (m[2]) parts.push(`${m[2]} дн.`);
  if (m[3]) parts.push(`${m[3]} год`);
  if (m[4]) parts.push(`${m[4]} хв`);
  return parts.length ? parts.join(' ') : raw;
}

/** Формат занятий словами, а не словарём schema.org. */
function courseMode(value) {
  const map = { online: 'онлайн', onsite: 'офлайн', blended: 'змішаний', offline: 'офлайн' };
  return clean(value)
    .split(/[,;]+/)
    .map((v) => map[v.trim().toLowerCase()] || v.trim())
    .filter(Boolean)
    .join(', ');
}

/** Двуязычное поле сайта: {ua, ru} либо просто строка. */
const pick = (value, lang) => {
  if (value && typeof value === 'object') return clean(value[lang] ?? value.ua ?? value.ru ?? '');
  return clean(value);
};

/* ------------------------------- разбор ------------------------------- */

/**
 * Тарифы и частые вопросы из /api/content.
 *
 * Вопросы отдаются готовыми парами «вопрос — ответ» на двух языках: это
 * прямая заготовка ответов бота, а не просто справка.
 */
export function parseContent(content) {
  const materials = [];
  const answers = [];

  for (const [i, plan] of (content?.pricing || []).entries()) {
    const title = pick(plan.title, 'ua');
    if (!title) continue;
    const features = (plan.features || []).map((f) => `• ${pick(f, 'ua')}`).filter((f) => f.length > 2);
    const price = [plan.price, pick(plan.priceUnit, 'ua')].filter(Boolean).join(' ');
    materials.push({
      section: 'prices',
      sourceKey: `content:pricing:${i}`,
      title: `Тариф «${title}»${price ? ` — ${price}` : ''}`,
      body: [price ? `Ціна: ${price}` : '', ...features].filter(Boolean).join('\n'),
    });
  }

  for (const item of content?.faq || []) {
    const quk = pick(item.question, 'ua');
    const auk = pick(item.answer, 'ua');
    const qru = pick(item.question, 'ru');
    const aru = pick(item.answer, 'ru');
    if (!quk || !auk) continue;

    materials.push({
      section: 'faq',
      sourceKey: `content:faq:${item.id ?? quk}`,
      title: quk,
      body: [auk, qru && qru !== quk ? `\n\nПо-русски: ${qru}` : '', aru && aru !== auk ? `\n${aru}` : '']
        .filter(Boolean)
        .join(''),
    });

    // Ответ бота — на каждом языке свой: клиент пишет на том, на каком читает.
    answers.push({ topic: 'часті питання', question: quk, answer: auk, lang: 'uk', triggers: quk });
    if (qru && aru) answers.push({ topic: 'часті питання', question: qru, answer: aru, lang: 'ru', triggers: qru });
  }

  return { materials, answers };
}

/** Все блоки JSON-LD страницы, развёрнутые из @graph. */
export function jsonLdNodes(html) {
  const out = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue; // один битый блок не должен ронять весь сбор
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (node?.['@graph']) out.push(...node['@graph']);
      else out.push(node);
    }
  }
  return out;
}

/** Курсы, контакты и филиалы со страницы школы. */
export function parseJsonLd(html, { baseUrl = '' } = {}) {
  const nodes = jsonLdNodes(html);
  const materials = [];

  for (const node of nodes) {
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];

    if (types.includes('Course')) {
      const name = clean(node.name);
      if (!name) continue;
      const instance = Array.isArray(node.hasCourseInstance) ? node.hasCourseInstance[0] : node.hasCourseInstance;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const lines = [
        clean(node.description),
        node.typicalAgeRange ? `Вік: ${clean(node.typicalAgeRange)}` : '',
        offer?.price ? `Ціна: ${clean(offer.price)} ${clean(offer.priceCurrency || '')}`.trim() : '',
        instance?.courseMode ? `Формат: ${courseMode(instance.courseMode)}` : '',
        instance?.courseWorkload ? `Навантаження: ${workload(instance.courseWorkload)}` : '',
        node.inLanguage ? `Мова: ${textOf(node.inLanguage)}` : '',
      ];
      materials.push({
        section: 'courses',
        sourceKey: `ld:course:${node['@id'] || node.url || name}`,
        title: name,
        body: lines.filter(Boolean).join('\n'),
        sourceUrl: clean(node.url) || baseUrl,
      });
    }

    if (types.includes('EducationalOrganization') || types.includes('Organization')) {
      // Телефоны на сайте идут одной строкой через запятую — разводим.
      const phones = textOf(node.telephone)
        .split(/[,;]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .join(', ');
      const priceRange = clean(node.priceRange);
      const lines = [
        phones ? `Телефон: ${phones}` : '',
        node.email ? `Пошта: ${textOf(node.email)}` : '',
        // «$» в priceRange — разметка для поисковиков, человеку она ничего не
        // говорит: берём, только если там есть числа.
        /\d/.test(priceRange) ? `Діапазон цін: ${priceRange}` : '',
        textOf(node.areaServed) ? `Працюємо: ${textOf(node.areaServed)}` : '',
      ];
      const departments = (Array.isArray(node.department) ? node.department : [node.department]).filter(Boolean);
      for (const d of departments) {
        const addr = d.address || {};
        const parts = [textOf(d.name), clean(addr.streetAddress), clean(addr.addressLocality), textOf(d.telephone)].filter(Boolean);
        if (parts.length) lines.push(`• ${parts.join(', ')}`);
      }
      if (lines.filter(Boolean).length) {
        materials.push({
          section: 'contacts',
          sourceKey: `ld:org:${node['@id'] || clean(node.name)}`,
          title: `Контакти та філії — ${clean(node.name) || 'школа'}`,
          body: lines.filter(Boolean).join('\n'),
          sourceUrl: clean(node.url) || baseUrl,
        });
      }
    }
  }

  return { materials };
}

/* ------------------------------- загрузка ------------------------------- */

async function get(url, { json = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'MyComputer-SMM-Panel/1.0 (bot knowledge import)' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new ImportError(`Сайт не ответил (${url}): ${err.message}`, 502);
  }
  if (!res.ok) throw new ImportError(`Сайт ответил ${res.status} на ${url}`, 502);
  return json ? res.json() : res.text();
}

/**
 * Собрать материалы с сайта. Сеть трогается только здесь.
 *
 * Частичный отказ — не повод падать: если `/api/content` у сайта нет (а у
 * FluentFox и «Дошколярика» своя кухня), берём хотя бы JSON-LD главной.
 */
export async function collectFromSite(siteUrl) {
  const base = String(siteUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new ImportError('Нужен адрес сайта целиком, вместе с https://');

  const notes = [];
  let materials = [];
  let answers = [];

  try {
    const content = await get(`${base}/api/content`, { json: true });
    const parsed = parseContent(content);
    materials.push(...parsed.materials);
    answers.push(...parsed.answers);
    notes.push(`тарифы и вопросы с ${base}/api/content`);
  } catch (err) {
    notes.push(`без /api/content: ${err.message}`);
  }

  try {
    const html = await get(base);
    const parsed = parseJsonLd(html, { baseUrl: base });
    materials.push(...parsed.materials);
    notes.push(`курсы и контакты с главной`);
  } catch (err) {
    notes.push(`без главной: ${err.message}`);
  }

  if (!materials.length) throw new ImportError(`С ${base} собирать нечего — проверьте адрес`, 502);

  // Источник у всех блоков один, если курс не дал своей ссылки.
  materials = materials.map((m) => ({ ...m, sourceUrl: m.sourceUrl || base, origin: 'site' }));
  return { materials, answers, notes };
}
