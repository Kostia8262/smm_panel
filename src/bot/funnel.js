/**
 * Шаги воронки поверх подбора по базе знаний (docs/бот.md, §5b).
 *
 * Главное правило из «Таблиці реакцій»: бот не ведёт сценарий рельсами, а
 * отвечает на то, что спросили, и одним рядком возвращает шаг вперёд.
 * Сценарий — «Ланцюжок 2» из Figma: возраст → ответ по возрастной ветке с
 * ценой и пробным → имя, телефон, удобные дни → человек.
 *
 * ЕДИНСТВЕННАЯ точка выбора ответа — `chooseReply()`. Решение владельца
 * 17.11.2026: сейчас это подбор по словам без языковой модели; гибрид с
 * Claude Haiku подключается позже ровно сюда — модель получит то же
 * состояние диалога и вернёт тот же объект, а стоп-темы останутся ДО неё.
 *
 * Модуль чистый: в базу не пишет и в сеть не ходит. Тексты берёт через
 * `say(key, vars)` — их правит владелец на экране «Бот → Реплики».
 */

import { decide, hasPhrase, matchStop } from './match.js';
import { flat } from './normalize.js';
import { DECISION } from './specs.js';

/** Где диалог стоит. */
export const STEP = {
  start: 'start', // мы ещё ничего не спрашивали
  askAge: 'ask_age', // спросили возраст
  trial: 'trial', // назвали цену и предложили пробное
  contacts: 'contacts', // попросили имя, телефон, дни
  birthday: 'birthday', // младше 6 — спросили день рождения
  abroad: 'abroad', // за границей — спросили удобное время
  done: 'done', // передали человеку
};

/** Шаги, на которых мы ждём ответа на свой вопрос — тут работают напоминания. */
export const WAITING_STEPS = [STEP.askAge, STEP.trial, STEP.contacts, STEP.abroad];

/* ------------------------------ распознавание ------------------------------ */

const NUM_WORDS = {
  шість: 6, шесть: 6, сім: 7, семь: 7, вісім: 8, восемь: 8, девять: 9, девʼять: 9, "дев'ять": 9,
  десять: 10, одинадцять: 11, одиннадцать: 11, дванадцять: 12, двенадцать: 12,
  тринадцять: 13, тринадцать: 13, чотирнадцять: 14, четырнадцать: 14,
  пʼятнадцять: 15, "п'ятнадцять": 15, пятнадцать: 15, шістнадцять: 16, шестнадцать: 16,
  сімнадцять: 17, семнадцать: 17, пять: 5, "п'ять": 5, пʼять: 5, чотири: 4, четыре: 4,
};

/**
 * Все возрасты в сообщении: «8», «8 років», «сину 9», «восемь лет».
 *
 * Число — не возраст, если это время («о 18:00», «в 17»), деньги («1900 грн»),
 * разы в неделю или часть телефона. Возраст — от 1 до 18: всё, что больше,
 * скорее год рождения, сумма или возраст родителя.
 */
export function parseAges(text) {
  const t = String(text ?? '').toLowerCase().replace(/[’`]/g, "'");
  const out = [];
  const re = /(^|[^\d:.,+\-])(\d{1,2})(?!\d|[:.,]\d|\s*(?:грн|uah|₴|раз|рази|разів|разу|година|годин|час|хв|мин|%|:\d))/g;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[2]);
    const before = t.slice(Math.max(0, m.index - 6), m.index + m[1].length);
    // Время: «о 18», «в 17», «після 15», «с 10 до 12».
    if (/(^|\s)(о|об|в|во|після|после|с|з|до|від|от)\s*$/.test(before) && !/(рок|лет|год|рочк)/.test(t.slice(re.lastIndex, re.lastIndex + 8))) continue;
    if (n >= 1 && n <= 18) out.push(n);
  }
  for (const [word, n] of Object.entries(NUM_WORDS)) {
    if (new RegExp(`(^|[^\\p{L}])${word}(?![\\p{L}])`, 'u').test(t)) out.push(n);
  }
  return [...new Set(out)];
}

/**
 * Язык клиента. Украинская буква — украинский, даже среди русских слов:
 * суржик отвечаем украинским (решение в Figma, «Російська версія»).
 * Нерешительное сообщение («8», «ок») не меняет язык диалога.
 */
export function dialogLang(text, previous = null) {
  const t = String(text ?? '').toLowerCase();
  if (/[іїєґ]/.test(t)) return 'uk';
  if (/[ыэъё]/.test(t)) return 'ru';
  const ruWords = ['что', 'сколько', 'стоит', 'ребенок', 'ребенку', 'лет', 'здравствуйте', 'добрый', 'да', 'можно', 'есть', 'хочу', 'нам', 'сыну', 'дочке', 'спасибо', 'как', 'какие', 'где'];
  const ukWords = ['що', 'скільки', 'коштує', 'дитина', 'років', 'рік', 'вітаю', 'добрий', 'так', 'можна', 'є', 'хочу', 'нам', 'сину', 'доньці', 'дякую', 'як', 'які', 'де'];
  const words = t.split(/[^\p{L}']+/u);
  const ru = words.filter((w) => ruWords.includes(w) && !ukWords.includes(w)).length;
  const uk = words.filter((w) => ukWords.includes(w) && !ruWords.includes(w)).length;
  if (ru > uk) return 'ru';
  if (uk > ru) return 'uk';
  return previous || 'uk';
}

const any = (text, phrases) => {
  const f = flat(text);
  return phrases.some((p) => hasPhrase(f, p));
};

const GREETINGS = ['вітаю', 'привіт', 'добрий день', 'доброго дня', 'добрий вечір', 'доброго ранку', 'здравствуйте', 'здрасте', 'привет', 'добрый день', 'добрый вечер', 'доброе утро', 'hello', 'hi', 'хай', 'салют'];
const FILLER = ['ок', 'ok', 'окей', 'угу', 'ага', 'добре', 'хорошо', 'ясно', 'зрозуміло', 'понятно', 'дякую', 'спасибо', 'спс', 'дяк'];
const YES = ['так', 'да', 'давайте', 'хочу', 'записуйте', 'записывайте', 'запишіть', 'запишите', 'можна', 'можно', 'звісно', 'конечно', 'ок', 'окей', 'ok', 'згода', 'гаразд', 'було б добре', 'было бы хорошо', 'цікаво', 'интересно', 'yes', 'ага'];
const PRICE = ['ціна', 'ціни', 'цена', 'цены', 'скільки коштує', 'сколько стоит', 'вартість', 'стоимость', 'прайс', 'почем', 'почому', 'скільки буде', 'сколько будет'];
const ADULT = ['для себе', 'для себя', 'для дорослих', 'для взрослых', 'дорослому', 'взрослому', 'я сам', 'я сама', 'сам навчитись', 'сама навчитись', 'сам научиться', 'сама научиться', 'мені 30', 'мне 30'];
const CLIENT = ['перенести', 'перенос', 'не прийдемо', 'не придем', 'не зможемо', 'не сможем', 'не буде на занятті', 'не будет на занятии', 'відпрацюв', 'отработ', 'пропуст', 'захворів', 'захворіла', 'заболел', 'заболела', 'у нас заняття', 'у нас занятие', 'наше заняття', 'наше занятие', 'наш урок', 'посилання на заняття', 'ссылка на занятие', 'не можемо зайти', 'не можем зайти'];
const CHILD_SELF = ['мені', 'мне'];
const CHILD_WORDS = ['дитин', 'дитя', 'ребен', 'ребён', 'сину', 'сина', 'сын', 'дочк', 'доньк', 'дочці', 'доньці', 'дочь', 'донечк', 'малий', 'малая', 'малий', 'онук', 'внук', 'племін', 'племян'];
const ABROAD = ['за кордоном', 'за границей', 'в польщі', 'в польше', 'у польщі', 'в німеччині', 'в германии', 'у німеччині', 'в чехії', 'в чехии', 'в іспанії', 'в испании', 'в італії', 'в италии', 'в канаді', 'в канаде', 'в англії', 'в англии', 'в австрії', 'в австрии', 'в нідерландах', 'в нидерландах', 'різниця в часі', 'разница во времени', 'в євро', 'в евро', 'європ', 'европ'];
const OFFLINE = ['не онлайн', 'наживо', 'вживу', 'вживую', 'офлайн', 'оффлайн', 'в класі', 'в классе', 'з дніпра', 'из днепра', 'в дніпрі', 'в днепре', 'ваша адреса', 'ваш адрес', 'де ви знаходитесь', 'где вы находитесь'];
const CERTIFICATE = ['сертифікат', 'сертификат', 'подарувати', 'подарить', 'у подарунок', 'в подарок'];
const TWO_KIDS = ['двоє дітей', 'двое детей', 'у мене двоє', 'у меня двое', 'брат і сестра', 'брат и сестра', 'двох дітей', 'двоих детей'];

/** Сообщение, в котором нет ничего, кроме приветствия. */
function isGreetingOnly(text) {
  const f = flat(text);
  if (!f) return false;
  let rest = ` ${f} `;
  for (const g of [...GREETINGS, 'вам', 'вас', 'ви', 'вы', 'будь ласка', 'пожалуйста', 'ще раз', 'еще раз']) {
    rest = rest.replaceAll(` ${flat(g)} `, ' ').replaceAll(` ${flat(g)} `, ' ');
  }
  return rest.trim().length === 0 && any(text, GREETINGS);
}

/** Точки, эмодзи, стикер, «ок», «угу» — сообщение без смысла для воронки. */
export function isFiller(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  const f = flat(t);
  const filler = FILLER.map(flat);
  return f.split(' ').every((w) => filler.includes(w));
}

/* ------------------------------- контакты -------------------------------- */

/** Телефон: десять и больше цифр подряд с пробелами, скобками и дефисами. */
export function parsePhone(text) {
  const m = String(text ?? '').match(/\+?\d[\d\s()\-]{8,18}\d/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  if (digits.length === 10 && digits.startsWith('0')) return `+38${digits}`;
  if (digits.length === 12 && digits.startsWith('380')) return `+${digits}`;
  return `+${digits}`;
}

const NOT_NAMES = new Set([
  'вітаю', 'привіт', 'добрий', 'доброго', 'дякую', 'дякуємо', 'здравствуйте', 'привет', 'добрый', 'спасибо',
  'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'пʼятниця', 'субота', 'неділя',
  'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье',
  'так', 'да', 'ок', 'можна', 'можно', 'краще', 'лучше', 'після', 'после', 'зранку', 'утром', 'ввечері', 'вечером',
  'наш', 'мій', 'мой', 'номер', 'телефон', 'тел', 'імʼя', "ім'я", 'имя', 'дитина', 'ребенок', 'звати', 'зовут', 'вона', 'він', 'она', 'он',
  'будь', 'ласка', 'пожалуйста', 'мене', 'меня', 'нам', 'нас', 'зручно', 'удобно', 'щодня', 'вихідні', 'выходные', 'будні', 'будни',
  'instagram', 'direct',
]);

/**
 * Имя из ответа на шаг 3: «звати Марк», «Марк, 0671234567, вівторок».
 * Берём явное «звати/зовут/імʼя», иначе первое слово с заглавной, которое не
 * приветствие и не день недели. Не нашли — null: человек прочитает сам.
 */
export function parseName(text) {
  const src = String(text ?? '').replace(/\+?\d[\d\s()\-]{8,18}\d/g, ' ');
  const explicit = src.match(/(?:звати|зовут|імʼя|ім'я|имя)\s*[:\-—]?\s*([\p{Lu}][\p{Ll}'ʼ-]{1,30})/u);
  if (explicit) return explicit[1];
  const words = src.match(/[\p{L}'ʼ-]{2,30}/gu) || [];
  for (const w of words) {
    if (!/^\p{Lu}/u.test(w)) continue;
    if (NOT_NAMES.has(w.toLowerCase())) continue;
    return w;
  }
  return null;
}

const DAY_WORDS = /(понеділ|вівтор|серед|четвер|пʼятниц|п'ятниц|субот|неділ|понедел|вторник|сред|пятниц|воскрес|будн|вихідн|выходн|щодня|каждый день|зранку|вранці|утром|вдень|днем|днём|ввечері|вечером|після|после|\d{1,2}[:.]\d{2}|\bо \d{1,2}\b|\bв \d{1,2}\b)/i;

/** Удобные дни — сам текст, если в нём есть дни или часы. Расписание подбирает человек. */
export function parsePreferredTime(text) {
  const t = String(text ?? '').replace(/\+?\d[\d\s()\-]{8,18}\d/g, ' ').replace(/\s+/g, ' ').trim();
  const clean = t.replace(/(\s*[,;]\s*)+/g, ', ').replace(/^[\s,;.]+|[\s,;]+$/g, '');
  return DAY_WORDS.test(clean) ? clean.slice(0, 200) : null;
}

/* ------------------------------- выбор ответа ------------------------------- */

/**
 * Что бот делает с очередной порцией сообщений клиента.
 *
 * @param {object} ctx
 * @param {object} ctx.dialog    состояние диалога (строка bot_dialogs)
 * @param {string} ctx.text      сообщения клиента с нашего последнего ответа, склеенные
 * @param {'reply'|'remind'} [ctx.kind]
 * @param {Array<object>} ctx.entries   живые записи базы знаний
 * @param {object} ctx.settings  настройки бота проекта
 * @param {(key: string, vars?: object) => string} ctx.say  реплика на языке диалога
 * @param {string} [ctx.channel]
 * @returns {{text: string|null, replyKey: string|null, patch: object,
 *   handoff: string|null, lead: boolean, why: string, draftText?: string}}
 *   handoff — причина передачи человеку (диалог дальше за ним); text — что
 *   отправить (может быть и вместе с передачей: «передаю адміністратору»).
 */
export function chooseReply(ctx) {
  const { dialog, kind = 'reply', entries = [], settings = {}, channel = 'direct' } = ctx;
  const text = String(ctx.text ?? '');
  const lang = kind === 'remind' ? dialog.lang || 'uk' : dialogLang(text, dialog.lang);
  const tags = new Set(String(dialog.tags || '').split(',').filter(Boolean));
  const say = (key, vars) => ctx.say(key, { lang, ...vars });
  const out = (o) => ({
    text: null,
    replyKey: null,
    handoff: null,
    lead: false,
    why: '',
    ...o,
    patch: { lang, tags: [...tags].join(','), ...(o.patch || {}) },
  });

  /* Напоминания по тишине — только на шагах, где мы задали вопрос. */
  if (kind === 'remind') {
    if (!WAITING_STEPS.includes(dialog.step)) return out({ why: 'напоминать не о чем' });
    const key = (dialog.reminders_sent || 0) === 0 ? 'remind_2h' : 'remind_24h';
    if ((dialog.reminders_sent || 0) >= 2) return out({ why: 'два напоминания уже было' });
    return out({ text: say(key), replyKey: key, patch: { reminders_sent: (dialog.reminders_sent || 0) + 1 }, why: 'тишина после нашего вопроса' });
  }

  /* 1. Стоп-тема перебивает всё: молчим, диалог — человеку. */
  const stop = matchStop(text, settings.stopExtra);
  if (stop) return out({ handoff: `стоп-тема: ${stop.title} («${stop.trigger}»)`, why: 'стоп-тема' });

  // Клиент ответил — счётчики тишины обнуляются.
  const base = { reminders_sent: 0 };

  /* 2. Шаг 3: ждём имя и телефон. */
  if (dialog.step === STEP.contacts) {
    const phone = parsePhone(text);
    if (!phone) {
      return out({ handoff: 'ответ на шаге 3 без телефона — дочитать человеку', patch: base, why: 'нет телефона' });
    }
    const name = parseName(text);
    const when = parsePreferredTime(name ? text.replace(name, ' ') : text);
    return out({
      text: say('contacts_thanks'),
      replyKey: 'contacts_thanks',
      handoff: 'контакты собраны — подобрать время и подтвердить пробное',
      lead: true,
      patch: { ...base, phone, contact_name: name || dialog.contact_name || null, preferred_time: when || dialog.preferred_time || null, step: STEP.done },
      why: 'контакты',
    });
  }

  /* 3. Ситуации, в которых воронка не нужна. */
  if (any(text, CLIENT)) {
    tags.add('client');
    return out({ text: say('client_ack'), replyKey: 'client_ack', handoff: 'пишет наш клиент (пропуск, перенос, вопрос по занятиям)', patch: base, why: 'наш клиент' });
  }
  if (any(text, ADULT)) {
    tags.add('adult');
    return out({ text: say('adult'), replyKey: 'adult', handoff: 'взрослый «для себе»', patch: { ...base, step: STEP.done }, why: 'взрослый' });
  }

  const ages = parseAges(text);
  const mentionsChild = any(text, CHILD_WORDS);
  const childSelf = !mentionsChild && ages.length === 1 && new RegExp(`(^|\\s)(${CHILD_SELF.join('|')})\\s+\\d`, 'iu').test(text);
  if (childSelf || tags.has('child')) {
    tags.add('child');
    // С ребёнком не обсуждаем оплату и не берём его данные — только зовём родителей.
    const key = any(text, PRICE) ? 'child_price' : 'child_trial';
    return out({ text: say(key), replyKey: key, handoff: 'пишет сам ребёнок — нужен контакт родителей', patch: { ...base, child_age: ages[0] ?? dialog.child_age }, why: 'пишет ребёнок' });
  }

  if (ages.length >= 2 || any(text, TWO_KIDS)) {
    tags.add('two_kids');
    // Условия на двоих — вопрос к владельцу (оранжевая карточка в Figma).
    return out({ handoff: 'двое детей — условия знает только администратор', patch: base, why: 'двое детей' });
  }

  if (dialog.step === STEP.birthday) {
    return out({ handoff: 'младше 6 — ответ про день рождения, поставить напоминание', patch: base, why: 'день рождения' });
  }

  if (dialog.step === STEP.abroad && !ages.length) {
    return out({ text: say('ask_contacts'), replyKey: 'ask_contacts', patch: { ...base, step: STEP.contacts, preferred_time: parsePreferredTime(text) }, why: 'за границей → контакты' });
  }

  if (any(text, ABROAD) && !tags.has('abroad')) {
    tags.add('abroad');
    return out({ text: say('abroad'), replyKey: 'abroad', patch: { ...base, step: STEP.abroad, child_age: ages[0] ?? dialog.child_age }, why: 'за границей' });
  }
  if (any(text, OFFLINE) && !tags.has('offline')) {
    tags.add('offline');
    if (!ages.length && !dialog.child_age) {
      return out({ text: say('offline'), replyKey: 'offline', patch: { ...base, step: STEP.askAge }, why: 'офлайн: адреса и возраст' });
    }
  }
  if (any(text, CERTIFICATE) && !tags.has('certificate')) {
    tags.add('certificate');
    if (!ages.length) return out({ text: say('certificate'), replyKey: 'certificate', patch: { ...base, step: STEP.askAge }, why: 'сертификат' });
  }

  /* 4. Назвали возраст — шаг 2 по возрастной ветке. */
  if (ages.length === 1 && [STEP.start, STEP.askAge].includes(dialog.step || STEP.start)) {
    const age = ages[0];
    if (age < 6) {
      return out({ text: say('age_under6'), replyKey: 'age_under6', patch: { ...base, child_age: age, step: STEP.birthday }, why: 'младше 6' });
    }
    // Офлайн-цены владелец не подтвердил: после возраста сразу контакты.
    if (tags.has('offline')) {
      return out({ text: say('ask_contacts'), replyKey: 'ask_contacts', patch: { ...base, child_age: age, step: STEP.contacts }, why: 'офлайн: возраст → контакты' });
    }
    const branch = age <= 9 ? 'age_6_9' : age <= 13 ? 'age_10_13' : 'age_14_18';
    return out({
      text: `${say(branch, { age })}\n\n${say('step2_common')}`,
      replyKey: branch,
      patch: { ...base, child_age: age, step: STEP.trial },
      why: `возраст ${age}`,
    });
  }

  /* 5. Предложили пробное — согласие ведёт к шагу 3. */
  if (dialog.step === STEP.trial && any(text, YES) && !/\?/.test(text)) {
    return out({ text: say('ask_contacts'), replyKey: 'ask_contacts', patch: { ...base, step: STEP.contacts }, why: 'согласие на пробное' });
  }

  const ageUnknown = !dialog.child_age;
  const waitingAge = [STEP.start, STEP.askAge].includes(dialog.step || STEP.start);

  /* 6. Цену спросили раньше возраста — отвечаем ценой, не уклоняясь. */
  if (ageUnknown && waitingAge && any(text, PRICE)) {
    return out({ text: say('price_then_age'), replyKey: 'price_then_age', patch: { ...base, step: STEP.askAge }, why: 'цена до возраста' });
  }

  /* 7. Пустое, «ок», точки — одно мягкое перепитывание, дальше молчим. */
  if (isFiller(text)) {
    if (dialog.step === STEP.askAge && !dialog.reprompted) {
      return out({ text: say('soft_reprompt'), replyKey: 'soft_reprompt', patch: { ...base, reprompted: 1 }, why: 'перепитывание' });
    }
    if (dialog.step === STEP.start) {
      return out({ text: say('ask_age'), replyKey: 'ask_age', patch: { ...base, step: STEP.askAge }, why: 'первое сообщение' });
    }
    return out({ patch: base, why: 'пустое сообщение — ждём' });
  }

  /* 8. Приветствие: первое — шаг 1, повторное — без второго «Вітаємо». */
  if (isGreetingOnly(text)) {
    if (dialog.step === STEP.start || !dialog.step) {
      return out({ text: say('ask_age'), replyKey: 'ask_age', patch: { ...base, step: STEP.askAge }, why: 'приветствие' });
    }
    if (waitingAge) return out({ text: say('second_hello'), replyKey: 'second_hello', patch: base, why: 'повторное приветствие' });
  }

  /* 9. Свой вопрос — ответ из базы знаний и тот же рядок про возраст. */
  const kb = decide(text, entries, { channel, stopExtra: settings.stopExtra });
  if (kb.decision === DECISION.answer) {
    const tail = ageUnknown && waitingAge ? `\n\n${say('age_line')}` : '';
    return out({
      text: `${kb.entry.answer}${tail}`,
      replyKey: null,
      knowledgeId: kb.entry.id,
      patch: { ...base, ...(tail ? { step: STEP.askAge } : {}) },
      why: `база знаний: ${kb.why}`,
    });
  }

  /* 10. Первое сообщение без ответа в базе — шаг 1 воронки. */
  if (dialog.step === STEP.start || !dialog.step) {
    return out({ text: say('ask_age'), replyKey: 'ask_age', patch: { ...base, step: STEP.askAge }, why: 'первое сообщение' });
  }

  /* 11. Непонятное — не выдумываем: человеку, с черновиком, если он есть. */
  return out({
    handoff: kb.decision === DECISION.draft ? 'неуверенный ответ из базы — вычитать' : 'вопрос вне базы знаний',
    draftText: kb.decision === DECISION.draft ? kb.entry.answer : undefined,
    patch: base,
    why: kb.why,
  });
}
