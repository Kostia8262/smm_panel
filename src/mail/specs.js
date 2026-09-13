/**
 * Рассылка: лимиты, пороги и справочники — единственное место.
 *
 * Правило продукта то же, что у площадок (`platforms/specs.js`): разъехавшиеся
 * копии лимитов — это «не ушло, а почему — непонятно». Всё, что распознавание,
 * проверки и интерфейс знают про адреса, читается отсюда.
 *
 * Архитектура и фазы — `docs/рассылка.md`.
 */

export const IMPORT_LIMITS = {
  // База школы на десятки тысяч строк весит единицы мегабайт. Больше — это
  // уже выгрузка CRM с историей переписки, её сперва режут до адресов.
  maxBytes: 20 * 1024 * 1024,
  maxRows: 100_000,
  // Защита от zip-бомбы: XLSX на 20 МБ, раскрывающийся в гигабайт XML.
  maxUnpackedBytes: 150 * 1024 * 1024,
  // Разобранная, но не подтверждённая загрузка — это чужие адреса, лежащие
  // без дела. Дольше суток её не держим.
  staleHours: 24,
};

/** Сколько непустых ячеек колонки должны быть похожи на адрес, чтобы счесть её колонкой адресов. */
export const EMAIL_COLUMN_SHARE = 0.6;

export const MX_CHECK = { concurrency: 10, timeoutMs: 3000, cacheHours: 24 };

export const PAGE_SIZE = 50;

/**
 * На каком основании у школы эти адреса. Обязательно для базы: без основания
 * слать нельзя, а фраза для подвала письма («ви отримали цей лист, бо…») —
 * по-украински, как и сами письма.
 */
export const CONSENT_BASES = {
  form: { title: 'Подписка на сайте', footer: 'ви підписалися на розсилку на нашому сайті' },
  lead: { title: 'Заявка с согласием', footer: 'ви залишили заявку й погодилися отримувати листи' },
  client: { title: 'Ученики и родители', footer: 'ви навчаєтеся в нас або ваша дитина' },
  event: { title: 'Участники мероприятия', footer: 'ви зареєструвалися на наш захід' },
  other: { title: 'Другое', footer: 'ви погодилися отримувати наші листи' },
};

/** Состояние контакта словом — как статус поста, а не цветной полосой. */
export const CONTACT_STATUS = {
  active: 'активен',
  unsubscribed: 'отписался',
  bounced: 'адрес не существует',
  invalid: 'ошибочный адрес',
};

/** Причина записи в стоп-лист. */
export const SUPPRESSION_REASONS = {
  unsubscribed: 'отписался сам',
  manual: 'отписан вручную',
  bounced: 'адрес не существует',
  invalid: 'ошибочный адрес',
  erased: 'стёрт по просьбе',
};

/**
 * Вердикты распознавания. Порядок — порядок показа в предпросмотре: что
 * добавится, что требует решения, что не добавится ни при каком выборе.
 */
export const VERDICTS = {
  ok: 'готовы',
  warning: 'с предупреждением',
  fixable: 'похоже на опечатку',
  invalid: 'ошибочные',
  duplicate: 'повторы',
  suppressed: 'в стоп-листе',
};

/**
 * Популярные почтовые домены. Нужны дважды: опечатка ищется только рядом с
 * ними (иначе любой редкий домен объявлялся бы опечаткой соседнего), и их не
 * проверяем через DNS — почта там заведомо есть.
 */
export const POPULAR_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'ukr.net',
  'i.ua',
  'meta.ua',
  'email.ua',
  'bigmir.net',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'gmx.net',
];

/**
 * Почта Mail.ru и Яндекса. В Украине заблокирована с 2017 года: адрес
 * существует, письмо примут, но человек вряд ли его прочтёт. Предупреждение,
 * а не отказ — решает владелец.
 */
export const BLOCKED_IN_UA = [
  'mail.ru',
  'bk.ru',
  'list.ru',
  'inbox.ru',
  'internet.ru',
  'yandex.ru',
  'yandex.ua',
  'yandex.com',
  'yandex.by',
  'yandex.kz',
  'ya.ru',
];

/** Ящики должностей, а не людей: письмо читает кто угодно или никто. */
export const ROLE_LOCALS = [
  'info', 'admin', 'administrator', 'office', 'support', 'sales', 'noreply', 'no-reply',
  'hr', 'contact', 'contacts', 'marketing', 'webmaster', 'postmaster', 'abuse', 'billing',
  'help', 'team', 'hello', 'manager', 'director', 'reception', 'buh', 'accounting', 'mail',
];

/** Одноразовая почта. Список не полный и не обязан быть: цель — поймать очевидное. */
export const DISPOSABLE_DOMAINS = [
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'temp-mail.org', 'tempmail.com',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com',
  'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'emailondeck.com', 'tempail.com',
  'mohmal.com', 'moakt.com', 'mintemail.com', 'spamgourmet.com', 'mailnesia.com',
];

/**
 * Заголовки колонок, по которым узнаётся имя. Сравнение — после приведения к
 * нижнему регистру и схлопывания пробелов (`columns.js`).
 */
export const NAME_HEADERS = {
  full: [
    'имя', "ім'я", 'імя', 'name', 'full name', 'fullname', 'display name', 'фио', 'ф.и.о.', 'піб',
    'п.і.б.', 'контакт', 'contact', 'клиент', 'клієнт', 'ученик', 'учень', 'учениця', 'родитель',
    'батьки', 'имя и фамилия', "ім'я та прізвище", "ім'я і прізвище", 'фамилия и имя',
    "прізвище та ім'я", 'фамилия имя', "прізвище ім'я",
  ],
  first: ['first name', 'firstname', 'given name', 'имя', "ім'я", 'імя'],
  last: ['last name', 'lastname', 'surname', 'family name', 'фамилия', 'прізвище'],
};

/* ------------------------------ отправка (фаза 2) ------------------------------ */

/**
 * Потолки и дозирование ящика-отправителя (docs/рассылка.md, §8.4).
 *
 * Потолок Google — скользящие 24 часа, а не календарные сутки, и в него
 * входят письма, отправленные человеком руками из того же ящика: панель их
 * не видит. Поэтому панель по умолчанию берёт себе 80 %.
 */
export const SENDING = {
  googleDaily: { gmail: 500, workspace: 2000 },
  panelShare: 0.8,
  /**
   * Прогрев нового ящика: [до какого дня включительно, писем в сутки]. Резкий
   * старт с сотен одинаковых писем Google может принять за взлом ящика.
   */
  warmup: [
    [3, 50],
    [7, 100],
    [14, 200],
    [21, 400],
  ],
  window: { from: '08:00', to: '21:00', timeZone: 'Europe/Kyiv' },
  /** Сколько адресов можно указать для пробного письма. */
  testRecipientsMax: 5,
  /** Пауза между письмами одного ящика, секунды: случайная, ровный ритм похож на робота. */
  gapSeconds: [4, 12],
  /** Сколько раз повторять письмо, на которое Google ответил 5xx. */
  temporaryAttempts: 3,
  /** Захваченное отправщиком письмо без итога дольше этого — судьба неизвестна. */
  stuckMinutes: 10,
  /** Картинки разосланного письма снимаются с диска не сразу — вдруг понадобится копия. */
  purgeAfterMinutes: 10,
  /** Придержать ящик, если Google попросил медленнее, но не назвал срок. */
  rateHoldMinutes: 15,
};

/** Права, которые просим у Google. Больше — нельзя: панель только отправляет. */
export const GOOGLE_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.send'];
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
