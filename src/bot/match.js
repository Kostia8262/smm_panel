/**
 * Подбор ответа: что из базы знаний подходит к сообщению клиента.
 *
 * Модели нет — есть счёт (docs/бот.md, §4). Порядок такой:
 *   1. стоп-тема перебивает всё и зовёт человека;
 *   2. записи отсеиваются по каналу;
 *   3. каждая получает счёт 0…1 по зацепкам, вопросу и рубрике;
 *   4. язык вопроса понижает счёт записи на другом языке, но не выбрасывает
 *      её: лучше ответить по-русски на украинский вопрос, чем молчать.
 *
 * Пороги и решения — в src/bot/specs.js.
 */

import { DECISION, SCORE, STOP_TOPICS } from './specs.js';
import { flat, tokens } from './normalize.js';

/**
 * Есть ли фраза в тексте.
 *
 * Границы слова здесь важнее хитрости: подстрочный поиск «чек» находил его в
 * «чекаю відповіді», а «оплат» должен находиться в «оплатити».
 *   - фраза из нескольких слов — подстрокой, она и так однозначна;
 *   - короткая (меньше пяти букв) — только целым словом;
 *   - длинная — с начала слова, чтобы ловить любые окончания.
 */
export function hasPhrase(flatText, phrase) {
  const needle = flat(phrase);
  if (!needle) return false;
  if (needle.includes(' ')) {
    if (flatText.includes(needle)) return true;
    /*
     * Слова фразы могут стоять врозь: «куди мені переказати» — это «куди
     * переказати» со вставкой. Но считать по всем словам подряд нельзя:
     * предлог «на» есть в каждом втором сообщении, и фраза «на карті»
     * срабатывала на «скиньте картинки» (проверка 19.10).
     *
     * Поэтому смотрим только на значащие слова — служебные отбрасывает
     * `tokens()` — и требуем, чтобы их было не меньше двух. Фраза, которая
     * сводится к одному значащему слову, ищется только подстрокой.
     */
    const meaningful = needle.split(' ').filter((w) => w.length >= 4 && tokens(w).length);
    if (meaningful.length < 2) return false;
    return meaningful.every((w) => hasPhrase(flatText, w));
  }
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = needle.length < 5 ? '(?![\\p{L}\\p{N}])' : '[\\p{L}\\p{N}]*';
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}${tail}`, 'u').test(flatText);
}

/** Язык сообщения: нужен, чтобы ответить тем же, чем спросили. */
export function detectLang(text) {
  const t = String(text ?? '').toLowerCase();
  let uk = (t.match(/[іїєґ]/g) || []).length; // і ї є ґ
  let ru = (t.match(/[ыэъ]/g) || []).length; // ы э ъ
  for (const word of ['что', 'сколько', 'стоит', 'ребенок', 'ребёнок', 'занятия', 'расписание', 'бесплатно', 'где', 'какие']) {
    if (t.includes(word)) ru += 2;
  }
  for (const word of ['що', 'скільки', 'коштує', 'дитина', 'заняття', 'розклад', 'безкоштовно', 'де ', 'які'])  {
    if (t.includes(word)) uk += 2;
  }
  if (uk === ru) return null;
  return uk > ru ? 'uk' : 'ru';
}

/**
 * Стоп-тема сообщения.
 *
 * Основа несъёмная (договорённость 12.09.2026), владелец только дополняет её
 * своими словами — они приходят в `extra` строками из настроек бота.
 */
export function matchStop(text, extra = '') {
  const f = flat(text);
  if (!f) return null;
  for (const topic of STOP_TOPICS) {
    const hit = topic.triggers.find((phrase) => hasPhrase(f, phrase));
    if (hit) return { id: topic.id, title: topic.title, trigger: hit };
  }
  const own = String(extra || '')
    .split(/[\n;,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = own.find((phrase) => hasPhrase(f, phrase));
  if (hit) return { id: 'own', title: 'Своя стоп-тема', trigger: hit };
  return null;
}

/** Зацепки записи строками: по переводу строки и точке с запятой. */
export function triggerList(entry) {
  return String(entry.triggers || '')
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Доля слов образца, нашедшихся в сообщении. */
function coverage(sampleTokens, messageTokens) {
  if (!sampleTokens.length) return 0;
  const hits = sampleTokens.filter((t) => messageTokens.includes(t)).length;
  return hits / sampleTokens.length;
}

/**
 * Счёт одной записи.
 *
 * Зацепка целиком — единица: так владелец задаёт точные формулировки. Дальше
 * по убыванию доверия: слова зацепки, слова нашего вопроса, рубрика. Рубрика
 * весит мало намеренно — «ціни» в рубрике не делает запись ответом на любой
 * вопрос про деньги.
 */
export function scoreEntry(entry, { flatText, messageTokens, lang }) {
  let best = 0;
  let why = '';

  let exact = false;
  for (const trigger of triggerList(entry)) {
    if (hasPhrase(flatText, trigger)) {
      best = 1;
      why = `зацепка «${trigger}»`;
      exact = true;
      break;
    }
    const tTok = tokens(trigger);
    if (!tTok.length) continue;
    /*
     * Зацепка, сводящаяся к ОДНОМУ значащему слову, — это ключевое слово, а
     * не формулировка вопроса. Раньше она весила 0.9, то есть выше порога
     * «отвечаю сам», и запись с зацепкой «коли заняття» отвечала на «курс
     * валют який у вас» и «ваші заняття нудні» (10 попаданий из 10 на
     * проверке 19.10). Решение владельца: такой подбор уходит человеку
     * черновиком, а не клиенту ответом.
     *
     * Точная зацепка целиком (ветка выше) это не затрагивает: «ціна» в
     * сообщении «ціна?» по-прежнему даёт единицу.
     */
    const score = coverage(tTok, messageTokens) * (tTok.length === 1 ? SCORE.ONE_WORD : 1);
    if (score > best) {
      best = score;
      why = `слова зацепки «${trigger}»`;
    }
  }

  const qScore = coverage(tokens(entry.question), messageTokens) * 0.8;
  if (qScore > best) {
    best = qScore;
    why = 'слова вопроса записи';
  }

  const topicScore = coverage(tokens(entry.topic), messageTokens) * 0.45;
  if (topicScore > best) {
    best = topicScore;
    why = 'рубрика';
  }

  // Другой язык — не повод молчать, но повод уступить своему двойнику.
  //
  // Точную зацепку это не касается: «сколько стоит» в украинской записи
  // написано владельцем намеренно — именно для русского вопроса. Пока
  // поблажки не было, такой вопрос уходил человеку черновиком.
  if (!exact && lang && entry.lang && entry.lang !== 'any' && entry.lang !== lang) {
    best *= 0.55;
    if (why) why += ' (другой язык)';
  }

  return { score: Number(best.toFixed(3)), why };
}

/**
 * Что бот сделает с сообщением.
 *
 * @param {string} text сообщение клиента
 * @param {Array<object>} entries записи базы знаний (только живые)
 * @param {{channel?: string, stopExtra?: string}} opts
 * @returns {{decision: string, entry: object|null, score: number, why: string,
 *   lang: string|null, stop: object|null, candidates: Array<object>}}
 */
export function decide(text, entries, { channel = 'direct', stopExtra = '' } = {}) {
  const lang = detectLang(text);
  const stop = matchStop(text, stopExtra);
  if (stop) return { decision: DECISION.stop, entry: null, score: 0, why: `стоп-тема: ${stop.title}`, lang, stop, candidates: [] };

  const flatText = flat(text);
  const messageTokens = tokens(text);

  const scored = entries
    .filter((e) => !e.channel || e.channel === 'any' || e.channel === channel)
    .map((e) => ({ entry: e, ...scoreEntry(e, { flatText, messageTokens, lang }) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.entry.priority || 0) - (a.entry.priority || 0) || a.entry.id - b.entry.id);

  const top = scored[0];
  if (!top) {
    return { decision: DECISION.handoff, entry: null, score: 0, why: 'в базе знаний нет ничего похожего', lang, stop: null, candidates: [] };
  }

  const decision =
    top.score >= SCORE.CONFIDENT ? DECISION.answer : top.score >= SCORE.HINT ? DECISION.draft : DECISION.handoff;

  return {
    decision,
    entry: top.entry,
    score: top.score,
    why: top.why,
    lang,
    stop: null,
    // Три верхних — для экрана проверки: видно, с чем ответ конкурировал.
    candidates: scored.slice(0, 3).map((r) => ({ id: r.entry.id, question: r.entry.question, score: r.score, why: r.why })),
  };
}
