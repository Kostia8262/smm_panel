/**
 * Подписка с сайтов: форма в подвале → база «Подписка с сайта» → приветственное
 * письмо (docs/рассылка.md, фаза 6).
 *
 * Решение владельца 14.09.2026: без подтверждения по письму — новый адрес сразу
 * в базе, человеку уходит приветствие со ссылкой отписки. Обещания:
 *   — **отказавшемуся подписку не возвращает чужая форма**: адрес, который
 *     отписался, стёрт или не принимал письма, возвращается в базу только после
 *     кнопки в письме (иначе любой вписал бы его обратно);
 *   — ответ формы не выдаёт, подписан ли адрес и отписывался ли он;
 *   — домен без почты и опечатка в домене в базу не попадают: без подтверждения
 *     это главный фильтр, а отказы Google бьют по доставляемости всего ящика;
 *   — форму нельзя превратить в рассыльщик: лимиты по обращающемуся и по адресу,
 *     ловушка для роботов;
 *   — у каждой подписки записано доказательство согласия: код текста у формы,
 *     язык страницы, откуда пришёл человек.
 */

import { createHash, randomBytes } from 'node:crypto';
import { db, log } from '../db.js';
import { getSetting, setSetting } from '../staff.js';
import { getProject } from '../projects.js';
import { parseOwnDomains } from '../shortlink.js';
import { tooManyAttempts } from '../ratelimit.js';
import { deriveKey } from '../secrets.js';
import * as store from './store.js';
import { checkAddress, maskEmail, emailHash, domainOf } from './import/address.js';
import { checkDomains } from './import/mx.js';
import { renderLetter } from './compose/render.js';
import { brandFor } from './compose/brand.js';
import { publicPage, tokenFor, unsubscribeUrl } from './unsubscribe.js';
import { CONSENT_BASES } from './specs.js';
import * as senders from './sender/senders.js';

const DAY_MS = 86400000;
const TOKEN_TTL_MS = 7 * DAY_MS;
const nowIso = (now = Date.now()) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

export const SIGNUP_LIMITS = {
  perIpPerHour: 5,
  perEmailPerDay: 3,
  resendAfterMinutes: 10,
  /**
   * Предохранитель от распределённого бота: лимит по IP его не остановит, а
   * без подтверждения каждая подписка — письмо незнакомцу из ящика академии,
   * в счёт его потолка и репутации. Сверх предела за сутки подписки
   * откладываются без писем (`held`), владельцу — тревога в журнал.
   */
  perSchoolPerDay: 60,
  spikeWarnPerDay: 25,
};

/** Код версии текста согласия у формы: `footer-2026-09-uk`. */
const CONSENT_VERSION = /^[a-z0-9][a-z0-9._-]{0,59}$/i;

/**
 * Ответ формы — один на подписку и на «подтвердите по письму»: иначе по нему
 * было бы видно, что адрес когда-то отписывался.
 */
const ACCEPTED = 'Дякуємо! Перевірте пошту — ми надіслали вам лист.';

let ipKey = null;
const ipHash = (ip) => createHash('sha256').update(ipKey ||= deriveKey('mail-signup-ip')).update(String(ip || '')).digest('hex').slice(0, 32);

/**
 * Тестовый стенд: dev-поддомен своего сайта или локальная машина.
 *
 * С 14.09.2026 подписка сразу пишет в базу и шлёт приветствие, а стенды
 * смотрят в боевую панель — проверка формы на dev клала адрес в базу и тратила
 * потолок ящика. Стенду отвечаем как настоящему сайту, но ничего не пишем.
 */
export function testSiteOf(origin) {
  let host;
  try {
    host = new URL(String(origin || '')).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return host;
  const own = parseOwnDomains(getSetting('own_domains', 'mycomputer.education,mycomputer.school'));
  const domain = own.find((d) => host.endsWith(`.${d}`));
  if (!domain) return null;
  const labels = host.slice(0, -(domain.length + 1)).split('.');
  return labels.some((l) => /^(dev|staging|test)(-|$)|-(dev|staging|test)$/.test(l)) ? host : null;
}

/** Сайт, с которого пришла форма, — только свои домены. */
export function siteOf(origin) {
  let host;
  try {
    host = new URL(String(origin || '')).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const own = parseOwnDomains(getSetting('own_domains', 'mycomputer.education,mycomputer.school'));
  return own.some((d) => host === d || host.endsWith(`.${d}`)) ? host : null;
}

/**
 * Откуда пришла форма и чей это адрес.
 *
 * Сайт, чья CSP не пускает fetch на панель (child — строка в конфиге
 * LiteSpeed вне репозитория), шлёт форму через свой сервер. Тогда у панели
 * все подписчики такого сайта оказались бы с одним адресом — сервера сети, и
 * лимит «5 попыток в час» закрыл бы форму для всех разом. Доверенному прокси
 * (запрос пришёл с адреса из `signup_proxy_ips`) панель верит в заголовках
 * `X-Subscribe-Client-Ip` и `X-Subscribe-Origin`; всем остальным — нет.
 */
export function requestSource({ ip, origin, headers = {} }) {
  const trusted = parseOwnDomains(getSetting('signup_proxy_ips', '62.72.21.71,127.0.0.1,::1,::ffff:127.0.0.1'));
  const clientIp = String(headers['x-subscribe-client-ip'] || '').trim();
  const proxiedOrigin = String(headers['x-subscribe-origin'] || '').trim();
  if (trusted.includes(String(ip)) && clientIp && proxiedOrigin) return { ip: clientIp.slice(0, 64), origin: proxiedOrigin };
  return { ip, origin };
}

/** База «Подписка с сайта» школы — заводится при первой подписке. */
function signupList(projectId) {
  const key = `mail_signup_list_${projectId}`;
  const id = Number(getSetting(key, '0'));
  const existing = id ? store.getList(id) : null;
  if (existing && existing.projectId === projectId && !existing.archivedAt) return existing;
  const list = store.createList(projectId, { name: 'Подписка с сайта', consentBasis: 'form', description: 'Подписались формой на сайте' });
  setSetting(key, String(list.id));
  return list;
}

function projectBySlug(slug) {
  const row = db.prepare('SELECT id FROM projects WHERE slug = ? AND active = 1').get(String(slug || ''));
  return row ? getProject(row.id) : null;
}

function welcomeLetter({ project, unsubscribe }) {
  const brand = brandFor(project);
  const subject = `Дякуємо за підписку — ${brand.title}`;
  const blocks = [
    { type: 'heading', text: 'Дякуємо за підписку!' },
    {
      type: 'text',
      text: 'Тепер ви першими дізнаватиметеся про нові курси, події та корисні поради для батьків. Пишемо лише у справі — без щоденних розсилок.',
    },
  ];
  if (brand.site) blocks.push({ type: 'button', text: 'Переглянути курси', href: brand.site });
  const { html, text } = renderLetter({
    brand,
    subject,
    preheader: 'Ви підписалися на листи — ось що буде далі.',
    blocks,
    signature: project.signature,
    reason: CONSENT_BASES.form.footer,
    unsubscribeUrl: unsubscribe,
  });
  return { subject, html, text };
}

function confirmLetter({ project, url }) {
  const brand = brandFor(project);
  const subject = `Підтвердіть підписку — ${brand.title}`;
  const { html, text } = renderLetter({
    brand,
    subject,
    preheader: 'Один клік — і ви знову отримуватимете наші листи.',
    blocks: [
      { type: 'heading', text: 'Підтвердіть підписку' },
      {
        type: 'text',
        text: 'Цю адресу вказали у формі підписки на нашому сайті. Раніше листи на неї не надходили, тож повернемо їх лише з вашої згоди — натисніть кнопку.',
      },
      { type: 'button', text: 'Підтвердити підписку', href: url, note: 'Якщо ви не підписувалися — просто проігноруйте цей лист, і ми більше не напишемо.' },
    ],
    signature: project.signature,
    reason: 'цю адресу вказали у формі підписки на нашому сайті',
  });
  return { subject, html, text };
}

async function sendLetter({ sender, project, address, letter, unsubscribe = null, label, fetchImpl, now }) {
  const out = await senders.sendTestMessage(sender.id, {
    to: [address],
    fromName: sender.displayName || project.title,
    subject: letter.subject,
    html: letter.html,
    text: letter.text,
    unsubscribe,
    label,
    fetchImpl,
    now,
  });
  if (!out.sent.length) throw new Error(out.failed[0]?.error || 'письмо не ушло');
}

const defaultMx = async (domain, now) => (await checkDomains([domain], { now })).get(domain);

/**
 * Приём формы.
 * @param {{email: string, school: string, origin?: string, page?: string, honeypot?: string, ip?: string,
 *   consentVersion: string, lang?: string, utm?: {source?, medium?, campaign?}, referrer?: string, landingPath?: string,
 *   publicBase: string, fetchImpl?: Function, mxCheck?: Function, now?: number}} input
 * @returns {Promise<{status: number, ok: boolean, code: string, message: string, suggestion?: string}>}
 */
export async function subscribe({
  email,
  school,
  origin,
  page = '',
  honeypot = '',
  ip = '',
  consentVersion = '',
  lang = '',
  utm = {},
  referrer = '',
  landingPath = '',
  publicBase,
  fetchImpl,
  mxCheck = defaultMx,
  now = Date.now(),
}) {
  // Стенд: проверки формы те же, что на сайте, но без записи, писем и лимитов.
  if (testSiteOf(origin)) {
    if (!CONSENT_VERSION.test(String(consentVersion || '').trim())) return { status: 400, ok: false, code: 'consent_missing', message: 'Оновіть сторінку й спробуйте ще раз.' };
    const check = checkAddress(email);
    if (check.verdict === 'invalid') return { status: 400, ok: false, code: 'invalid_email', message: 'Схоже, в адресі помилка. Перевірте, будь ласка.' };
    if (check.verdict === 'fixable' && check.suggestion) {
      return { status: 400, ok: false, code: 'typo', message: `Можливо, ви мали на увазі ${check.suggestion}?`, suggestion: check.suggestion };
    }
    return { status: 200, ok: true, code: 'accepted', test: true, message: ACCEPTED };
  }
  const site = siteOf(origin);
  if (!site) return { status: 403, ok: false, code: 'foreign_site', message: 'Форма працює лише на наших сайтах.' };
  const project = projectBySlug(school);
  if (!project) return { status: 400, ok: false, code: 'unknown_school', message: 'Не вдалося визначити школу. Оновіть сторінку.' };
  // Без кода текста согласия подписка ничего не доказывает — такую форму не принимаем.
  const consent = String(consentVersion || '').trim();
  if (!CONSENT_VERSION.test(consent)) return { status: 400, ok: false, code: 'consent_missing', message: 'Оновіть сторінку й спробуйте ще раз.' };

  // Ловушка: поле, которого человек не видит. Роботу отвечаем как человеку.
  if (String(honeypot || '').trim()) return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };

  const ipH = ipHash(ip);
  if (tooManyAttempts(`signup:${ipH}`, { limit: SIGNUP_LIMITS.perIpPerHour, windowMs: 3600000, blockMs: 3600000, now })) {
    return { status: 429, ok: false, code: 'too_many', message: 'Забагато спроб. Спробуйте за годину.' };
  }

  const check = checkAddress(email);
  const invalid = { status: 400, ok: false, code: 'invalid_email', message: 'Схоже, в адресі помилка. Перевірте, будь ласка.' };
  if (check.verdict === 'invalid') return invalid;
  if (check.verdict === 'fixable' && check.suggestion) {
    return { status: 400, ok: false, code: 'typo', message: `Можливо, ви мали на увазі ${check.suggestion}?`, suggestion: check.suggestion };
  }
  const address = check.email;
  // «Не знаем» (DNS не ответил) — не повод отказать человеку; «почты нет» — повод.
  if ((await mxCheck(domainOf(address), now)) === 'none') return invalid;

  const recent = db
    .prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM mail_signups WHERE project_id = ? AND email = ? AND created_at > ?')
    .get(project.id, address, nowIso(now - DAY_MS));
  const tooSoon = recent.last && now - Date.parse(recent.last) < SIGNUP_LIMITS.resendAfterMinutes * 60000;
  if (tooSoon || recent.n >= SIGNUP_LIMITS.perEmailPerDay) return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };

  const clip = (value, max) => String(value || '').trim().slice(0, max);
  const token = randomBytes(24).toString('base64url');
  const record = (status) =>
    Number(
      db
        .prepare(
          `INSERT INTO mail_signups (project_id, email, token_hash, status, site, page, ip_hash, consent_version, lang,
                                     utm_source, utm_medium, utm_campaign, referrer, landing_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          project.id,
          address,
          sha256(token),
          status,
          site,
          clip(page, 300),
          ipH,
          consent,
          lang === 'ru' ? 'ru' : 'uk',
          clip(utm?.source, 100),
          clip(utm?.medium, 100),
          clip(utm?.campaign, 100),
          clip(referrer, 300),
          clip(landingPath, 300)
        ).lastInsertRowid
    );
  const today = db
    .prepare("SELECT COUNT(*) AS n FROM mail_signups WHERE project_id = ? AND created_at > ? AND status IN ('subscribed', 'pending', 'held')")
    .get(project.id, nowIso(now - DAY_MS)).n;
  if (today >= SIGNUP_LIMITS.perSchoolPerDay) {
    record('held');
    if (today === SIGNUP_LIMITS.perSchoolPerDay) {
      log('error', `рассылка: всплеск подписок «${project.title}» — ${today} за сутки, дальше подписки откладываются без писем. Похоже на бота: проверьте «Подписка с сайта» и журнал`);
    }
    return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };
  }
  if (today + 1 === SIGNUP_LIMITS.spikeWarnPerDay) {
    log('warn', `рассылка: необычно много подписок «${project.title}» — ${today + 1} за сутки (предел ${SIGNUP_LIMITS.perSchoolPerDay})`);
  }

  const sender = senders.listSenders().find((s) => !['dead', 'disconnected'].includes(s.state));

  const contact = db.prepare('SELECT id, status FROM mail_contacts WHERE project_id = ? AND email = ?').get(project.id, address);
  const refused = store.isSuppressed(project.id, address) || (contact && contact.status !== 'active');

  /* ---- отказывался раньше: подписку возвращает только кнопка в письме ---- */
  if (refused) {
    if (!sender) {
      log('error', `рассылка: подписка с ${site} не принята — нет живого ящика для письма-подтверждения`);
      return { status: 503, ok: false, code: 'unavailable', message: 'Підписка тимчасово не працює. Спробуйте пізніше.' };
    }
    const id = record('pending');
    const letter = confirmLetter({ project, url: `${String(publicBase).replace(/\/$/, '')}/s/confirm/${token}` });
    try {
      await sendLetter({ sender, project, address, letter, label: `подтверждение возврата подписки с ${site}`, fetchImpl, now });
      db.prepare('UPDATE mail_signups SET confirm_sent_at = ? WHERE id = ?').run(nowIso(now), id);
    } catch (err) {
      db.prepare("UPDATE mail_signups SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 300), id);
      log('warn', `рассылка: письмо-подтверждение подписки (${maskEmail(address)}) не ушло: ${err.message}`);
      return { status: 503, ok: false, code: 'send_failed', message: 'Не вдалося надіслати лист. Спробуйте пізніше.' };
    }
    return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };
  }

  /* ---- новый или уже подписанный: сразу в базу ---- */
  let contactId;
  let added = false;
  const id = record('subscribed');
  db.exec('BEGIN');
  try {
    const list = signupList(project.id);
    contactId = store.upsertContact(project.id, address, '').id;
    added = store.addMembership(list.id, contactId) === 'added';
    db.prepare("INSERT INTO mail_events (project_id, contact_id, type, source, note) VALUES (?, ?, 'subscribed', 'form', ?)").run(project.id, contactId, `${site} · ${consent}`);
    db.prepare('UPDATE mail_signups SET contact_id = ?, confirmed_at = ? WHERE id = ?').run(contactId, nowIso(now), id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.prepare("UPDATE mail_signups SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 300), id);
    log('error', `рассылка: подписка с ${site} не записалась: ${err.message}`);
    return { status: 500, ok: false, code: 'error', message: 'Щось пішло не так. Спробуйте пізніше.' };
  }
  log('info', `рассылка: ${maskEmail(address)} подписался с ${site}${added ? '' : ' (уже был в базе подписки)'}`);

  // Приветствие — только новому в базе подписки: повторная форма не заваливает письмами.
  if (added) {
    if (!sender) {
      log('warn', `рассылка: приветствие ${maskEmail(address)} не ушло — нет живого ящика`);
    } else {
      const unsubscribe = unsubscribeUrl(publicBase, tokenFor({ projectId: project.id, contactId, campaignId: 0 }));
      try {
        await sendLetter({ sender, project, address, letter: welcomeLetter({ project, unsubscribe }), unsubscribe, label: `приветствие подписки с ${site}`, fetchImpl, now });
        db.prepare('UPDATE mail_signups SET confirm_sent_at = ? WHERE id = ?').run(nowIso(now), id);
      } catch (err) {
        // Подписка уже записана — человеку не отказываем из-за приветствия.
        db.prepare('UPDATE mail_signups SET error = ? WHERE id = ?').run(`приветствие не ушло: ${String(err.message).slice(0, 250)}`, id);
        log('warn', `рассылка: приветствие ${maskEmail(address)} не ушло: ${err.message}`);
      }
    }
  }
  return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };
}

/**
 * Страница по ссылке из письма-подтверждения: GET показывает кнопку, POST
 * возвращает подписку. Нужна только адресам, которые раньше отказывались.
 * @returns {{status: number, html: string}}
 */
export function confirmPage({ token, method, now = Date.now() }) {
  const row = token ? db.prepare('SELECT * FROM mail_signups WHERE token_hash = ?').get(sha256(token)) : null;
  if (!row || row.status === 'subscribed') {
    return { status: 404, html: publicPage({ title: 'Посилання не спрацювало', text: 'Можливо, його скопійовано не повністю. Підпишіться ще раз у формі на сайті.' }) };
  }
  const project = getProject(row.project_id);
  const school = project?.title || '';
  if (row.status === 'confirmed') {
    return { status: 200, html: publicPage({ school, title: 'Підписку вже підтверджено', text: 'Дякуємо! Листи надходитимуть на цю адресу.' }) };
  }
  if (row.status !== 'pending' || now - Date.parse(row.created_at) > TOKEN_TTL_MS) {
    return { status: 410, html: publicPage({ school, title: 'Посилання застаріло', text: 'Підпишіться ще раз у формі на сайті — ми надішлемо новий лист.' }) };
  }
  if (method !== 'POST') {
    return {
      status: 200,
      html: publicPage({
        school,
        title: 'Підтвердити підписку?',
        text: `Листи надходитимуть на ${maskEmail(row.email)}. Відписатися можна в будь-якому листі одним кліком.`,
        form: { action: 'confirm', label: 'Підтвердити підписку' },
      }),
    };
  }

  db.exec('BEGIN');
  try {
    const list = signupList(row.project_id);
    const contactId = store.upsertContact(row.project_id, row.email, '').id;
    store.addMembership(list.id, contactId);
    // Подтверждение подписки — новое явное согласие: снимает прежнюю отписку.
    db.prepare('DELETE FROM mail_suppressions WHERE project_id = ? AND email_hash = ?').run(row.project_id, emailHash(row.email));
    db.prepare("UPDATE mail_contacts SET status = 'active', status_note = 'подтвердил подписку на сайте', status_at = ?, updated_at = ? WHERE id = ?").run(nowIso(now), nowIso(now), contactId);
    db.prepare("INSERT INTO mail_events (project_id, contact_id, type, source, note) VALUES (?, ?, 'subscribed', 'form', ?)").run(
      row.project_id,
      contactId,
      [row.site, row.consent_version, 'подтверждено по письму'].filter(Boolean).join(' · ')
    );
    db.prepare("UPDATE mail_signups SET status = 'confirmed', confirmed_at = ?, contact_id = ? WHERE id = ?").run(nowIso(now), contactId, row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    log('error', `рассылка: подтверждение подписки не записалось: ${err.message}`);
    return { status: 500, html: publicPage({ school, title: 'Щось пішло не так', text: 'Спробуйте ще раз за хвилину.' }) };
  }
  log('info', `рассылка: ${maskEmail(row.email)} вернул подписку по письму с ${row.site}`);
  return { status: 200, html: publicPage({ school, title: 'Готово, ви підписані', text: 'Дякуємо! Листи знову надходитимуть на цю адресу.' }) };
}

/** Сводка для панели: сколько подписалось с сайтов за 30 дней. */
export function signupStats(projectId, now = Date.now()) {
  const since = nowIso(now - 30 * DAY_MS);
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM mail_signups WHERE project_id = ? AND created_at > ? GROUP BY status').all(Number(projectId), since);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { days: 30, subscribed: (by.subscribed || 0) + (by.confirmed || 0), pending: by.pending || 0, failed: by.failed || 0 };
}
