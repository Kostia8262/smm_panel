/**
 * Подключение Facebook и Instagram кнопкой — не ломая бессрочные токены.
 *
 * На 13.09.2026 у Facebook и Instagram академии стоят бессрочные токены
 * страницы (`debug_token`: type PAGE, expires_at 0). Кнопка нужна, чтобы
 * подключать школы без Graph API Explorer и копирования токенов, но заменять
 * рабочий бессрочный токен чем-то худшим она не должна никогда.
 *
 * Порядок:
 *   1. окно входа Facebook (`config_id` Facebook Login for Business — Meta
 *      рекомендует его приложениям Business-типа; без конфигурации — права
 *      списком);
 *   2. код → токен пользователя → долгоживущий токен пользователя;
 *   3. `/me/accounts` — страницы с токенами. **Токен страницы, взятый через
 *      долгоживущий токен пользователя, бессрочный** — это по документации;
 *      но не верим на слово, а проверяем каждый через `debug_token`;
 *   4. результат ждёт выбора страницы (oauth_pending), а замена проходит
 *      проверку `checkReplacement` — только после неё карточка меняется.
 *
 * Сам токен пользователя нигде не сохраняется: после получения токенов
 * страниц он не нужен, а хранить лишний ключ от личного аккаунта владельца —
 * значит увеличивать то, что можно украсть.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Права, которые просим. Ровно те, что есть у нынешнего бессрочного токена
 * академии (13.09.2026): кнопка не должна выдать меньше, чем уже работает, —
 * иначе переподключение отняло бы у приложения права и у старого токена.
 */
export const FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'pages_manage_engagement',
  'business_management',
  'read_insights',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_contents',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'instagram_manage_messages',
];

/** Без этих прав панель не публикует и не снимает посты. */
export const REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_contents',
];

/** Окно входа Facebook. */
export function authorizeUrl({ appId, redirectUri, state, configId = null }) {
  const params = new URLSearchParams({
    client_id: String(appId),
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
  });
  // С конфигурацией права задаёт она, а `scope` Meta просит не передавать.
  if (configId) params.set('config_id', String(configId));
  else params.set('scope', FACEBOOK_SCOPES.join(','));
  return `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
}

async function readJson(res, step) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Facebook, ${step}: ${data.error?.message || res.status}`);
  return data;
}

/** Код → долгоживущий токен пользователя. */
export async function exchangeCode({ appId, appSecret, redirectUri, code }) {
  const short = await readJson(
    await fetch(
      `${GRAPH}/oauth/access_token?${new URLSearchParams({
        client_id: String(appId),
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code: String(code || ''),
      })}`
    ),
    'обмен кода'
  );

  const long = await readJson(
    await fetch(
      `${GRAPH}/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: String(appId),
        client_secret: appSecret,
        fb_exchange_token: short.access_token,
      })}`
    ),
    'долгий токен'
  );
  return long.access_token;
}

/**
 * Что Meta знает о токене: права, срок, валиден ли.
 * `expiresAt: 0` — бессрочный, как отдаёт сама площадка.
 */
export async function inspectToken(token, { appId, appSecret }) {
  const data = await readJson(
    await fetch(`${GRAPH}/debug_token?input_token=${token}&access_token=${appId}|${appSecret}`),
    'проверка токена'
  );
  const d = data.data || {};
  return {
    valid: Boolean(d.is_valid),
    type: d.type || null,
    expiresAt: typeof d.expires_at === 'number' ? d.expires_at : null,
    dataAccessExpiresAt: d.data_access_expires_at || null,
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
  };
}

/**
 * Страницы, которыми управляет вошедший, — с токенами, Instagram и проверкой.
 *
 * Каждый токен страницы проверяется отдельно: документация обещает бессрочный,
 * а решать замену рабочего токена по обещанию нельзя.
 */
export async function listPages(userToken, app) {
  const data = await readJson(
    await fetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username}&limit=100&access_token=${userToken}`
    ),
    'список страниц'
  );

  const pages = [];
  for (const p of data.data || []) {
    let token = { valid: false, expiresAt: null, scopes: [], dataAccessExpiresAt: null };
    try {
      token = await inspectToken(p.access_token, app);
    } catch {
      // Не проверилось — считаем непроверенным; checkReplacement такое не пропустит.
    }
    pages.push({
      pageId: String(p.id),
      name: p.name || '',
      pageToken: p.access_token,
      tasks: p.tasks || [],
      instagram: p.instagram_business_account
        ? { id: String(p.instagram_business_account.id), username: p.instagram_business_account.username || '' }
        : null,
      ...token,
    });
  }
  return pages;
}

/**
 * Можно ли заменить нынешние доступы выбранной страницей.
 *
 * Чистая функция — от неё зависит, останется ли у школы рабочий постинг.
 * Правила, каждое против конкретной поломки:
 *   — новый токен не проверился или невалиден → не заменяем вслепую;
 *   — нынешний бессрочный, а новый срочный → замена сократила бы жизнь токена;
 *   — у нового нет прав, без которых панель не публикует и не удаляет;
 *   — нынешний рабочий, а у нового пропало какое-то из его прав;
 *   — на странице нельзя создавать контент (нет задачи CREATE_CONTENT);
 *   — другая страница — только с явным подтверждением: иначе посты школы
 *     молча уйдут на чужую страницу.
 *
 * @param {{pageId?: string, token?: {valid: boolean, expiresAt: number|null, scopes: string[]}|null}} current
 * @param {object} candidate — страница из listPages
 * @returns {{ok: boolean, problems: string[], warnings: string[], needsConfirm: boolean}}
 */
export function checkReplacement(current = {}, candidate) {
  const problems = [];
  const warnings = [];

  if (!candidate?.valid) problems.push('токен страницы не прошёл проверку Meta');
  if (candidate?.expiresAt !== 0) {
    const now = current?.token?.valid && current.token.expiresAt === 0;
    problems.push(
      now
        ? 'новый токен срочный, а нынешний бессрочный — замена сократила бы ему жизнь'
        : 'новый токен не бессрочный — такие мы не ставим'
    );
  }

  const missing = REQUIRED_SCOPES.filter((s) => !(candidate?.scopes || []).includes(s));
  if (missing.length) problems.push(`не хватает прав: ${missing.join(', ')}`);

  if (current?.token?.valid) {
    const lost = current.token.scopes.filter((s) => !(candidate?.scopes || []).includes(s));
    if (lost.length) problems.push(`у нынешнего токена есть права, которых нет у нового: ${lost.join(', ')}`);
  }

  if (!(candidate?.tasks || []).includes('CREATE_CONTENT')) {
    problems.push('на этой странице у вас нет права публиковать (CREATE_CONTENT)');
  }

  const switching = Boolean(current?.pageId) && String(current.pageId) !== String(candidate?.pageId);
  if (switching) warnings.push(`это другая страница — проект сейчас публикует на ${current.pageId}`);

  if (!candidate?.instagram) warnings.push('к странице не привязан Instagram — карточку Instagram не тронем');

  return { ok: problems.length === 0, problems, warnings, needsConfirm: switching };
}
