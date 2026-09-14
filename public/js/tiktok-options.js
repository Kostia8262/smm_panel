/**
 * Настройки цели TikTok в композере — ровно то, что правила TikTok требуют
 * показать человеку перед публикацией (Content Sharing Guidelines, сверено
 * 14.09.2026). Без этого приложение не пройдёт аудит:
 *
 *   — в чей аккаунт уйдёт пост — свежим ответом creator_info при показе;
 *   — кто увидит пост — выбор без значения по умолчанию, только из вариантов,
 *     которые TikTok разрешил этому аккаунту;
 *   — комментарии, дуэты, стичи — выключены по умолчанию и серые, если
 *     выключены в самом аккаунте; у фото-поста только комментарии;
 *   — отметка рекламы: свой бренд → «Promotional content», чужой →
 *     «Paid partnership»; платное партнёрство нельзя с видимостью «Только я»;
 *   — фраза согласия с Music Usage Confirmation (и Branded Content Policy);
 *   — предупреждение, что обработка займёт минуты.
 *
 * Режим «в черновики» отдаёт ролик в приложение TikTok: там человек сам
 * выберет видимость и добавит звук, поэтому эти поля здесь не показываются.
 */

import { api } from './api.js';
import { el, note } from './ui.js';

const PRIVACY_TITLES = {
  PUBLIC_TO_EVERYONE: 'Все',
  MUTUAL_FOLLOW_FRIENDS: 'Друзья — взаимные подписки',
  FOLLOWER_OF_CREATOR: 'Подписчики',
  SELF_ONLY: 'Только я',
};

const MUSIC_POLICY = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_POLICY = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

// Автор кэшируется на минуту: блок перерисовывается на каждое изменение, а
// правило «свежие данные при показе» относится к открытию формы, а не к клику.
const creators = new Map();
function loadCreator(projectId) {
  const hit = creators.get(projectId);
  if (hit && Date.now() - hit.at < 60000) return hit.promise;
  const promise = api.tiktokCreator(projectId);
  creators.set(projectId, { at: Date.now(), promise });
  promise.catch(() => creators.delete(projectId));
  return promise;
}

/**
 * @param {object} opts
 * @param {object} opts.post
 * @param {object} opts.target   цель TikTok (video или photo)
 * @param {Array}  opts.media    кадры этой цели
 * @param {() => Promise<void>} opts.onChange  сохранить пост
 */
export function tiktokOptions({ post, target, media, onChange }) {
  const wrap = el('div', 'target__extra tt-options');
  const photo = target.format_id === 'photo';
  const locked = target.status === 'published';
  let creator = null;
  let audited = false;
  let failure = null;

  const options = () => target.options || {};
  const set = async (patch) => {
    const next = { ...options(), ...patch };
    if (!next.commercial) {
      delete next.yourBrand;
      delete next.brandedContent;
    }
    target.options = next;
    render();
    await onChange();
  };

  wrap.append(el('span', 'field__hint', 'Загружаю аккаунт TikTok…'));
  loadCreator(post.project_id)
    .then((data) => {
      creator = data.creator;
      audited = data.audited;
      render();
    })
    .catch((err) => {
      failure = err.message;
      render();
    });
  return wrap;

  function render() {
    wrap.textContent = '';
    const o = options();
    const draft = o.mode === 'draft';

    if (failure) {
      wrap.append(note('danger', 'TikTok не ответил', `${failure}. Настройки публикации появятся, когда связь восстановится.`));
      return;
    }
    if (!creator) return;

    const who = el('div', 'tt-options__who');
    who.append(el('span', 'field__label', 'Аккаунт TikTok'));
    who.append(el('span', 'tt-options__name', `${creator.nickname || '—'}${creator.username ? ` · @${creator.username}` : ''}`));
    wrap.append(who);

    const modes = el('div', 'chips chips--wrap');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Как отправить в TikTok');
    for (const [id, title, hint] of [
      ['direct', 'Сразу в ленту', 'Панель опубликует пост сама'],
      ['draft', 'В черновики TikTok', 'Ролик придёт в приложение — там добавите звук и опубликуете'],
    ]) {
      const chip = el('button', 'chip', title);
      chip.type = 'button';
      chip.title = hint;
      chip.disabled = locked;
      chip.setAttribute('aria-pressed', String((draft ? 'draft' : 'direct') === id));
      chip.addEventListener('click', () => set({ mode: id }));
      modes.append(chip);
    }
    wrap.append(modes);

    if (draft) {
      wrap.append(
        el(
          'span',
          'field__hint',
          'TikTok пришлёт уведомление во «Входящие». Кто увидит пост, звук и отметку рекламы выберите в приложении при публикации. Незавершённых черновиков — не больше пяти за сутки.'
        )
      );
      return;
    }

    // --- кто увидит ---
    const privacyField = el('label', 'field tt-options__privacy');
    privacyField.append(el('span', 'field__label', 'Кто увидит пост'));
    const select = el('select', 'select');
    select.disabled = locked;
    const placeholder = new Option('— выберите —', '');
    placeholder.disabled = true;
    select.append(placeholder);
    for (const level of creator.privacyOptions) {
      const blockedByAudit = !audited && level !== 'SELF_ONLY';
      const blockedByBrand = o.brandedContent && level === 'SELF_ONLY';
      const opt = new Option(`${PRIVACY_TITLES[level] || level}${blockedByAudit ? ' — после аудита TikTok' : ''}`, level);
      opt.disabled = blockedByAudit || blockedByBrand;
      select.append(opt);
    }
    select.value = creator.privacyOptions.includes(o.privacy) ? o.privacy : '';
    select.addEventListener('change', () => set({ privacy: select.value }));
    privacyField.append(select);
    if (!audited) {
      privacyField.append(el('span', 'field__hint', 'Пока приложение не прошло аудит TikTok, публиковать можно только с видимостью «Только я».'));
    }
    wrap.append(privacyField);

    // --- взаимодействия ---
    const allow = el('div', 'tt-options__allow');
    allow.append(el('span', 'field__label', 'Разрешить'));
    const checks = [['allowComment', 'Комментарии', creator.commentDisabled]];
    if (!photo) checks.push(['allowDuet', 'Дуэт', creator.duetDisabled], ['allowStitch', 'Стич', creator.stitchDisabled]);
    const row = el('div', 'tt-options__checks');
    for (const [key, title, disabledByCreator] of checks) row.append(checkbox(title, Boolean(o[key]) && !disabledByCreator, disabledByCreator || locked, (v) => set({ [key]: v }), disabledByCreator ? 'Выключено в настройках аккаунта TikTok' : ''));
    allow.append(row);
    wrap.append(allow);

    if (photo) {
      wrap.append(checkbox('Подобрать музыку автоматически', Boolean(o.autoMusic), locked, (v) => set({ autoMusic: v }), 'TikTok сам подложит музыку к фото-посту'));
    }

    // --- реклама ---
    const brand = el('div', 'tt-options__brand');
    brand.append(checkbox('Пост рекламирует бренд, товар или услугу', Boolean(o.commercial), locked, (v) => set({ commercial: v })));
    if (o.commercial) {
      const kinds = el('div', 'tt-options__checks');
      kinds.append(
        checkbox('Свой бренд', Boolean(o.yourBrand), locked, (v) => set({ yourBrand: v }), 'Продвигаете себя или свой бизнес'),
        checkbox('Платное партнёрство', Boolean(o.brandedContent), locked || o.privacy === 'SELF_ONLY', (v) => set({ brandedContent: v }), o.privacy === 'SELF_ONLY' ? 'Недоступно с видимостью «Только я»' : 'Продвигаете чужой бренд за вознаграждение')
      );
      brand.append(kinds);
      if (o.brandedContent) brand.append(el('span', 'field__hint', 'Your photo/video will be labeled as "Paid partnership"'));
      else if (o.yourBrand) brand.append(el('span', 'field__hint', 'Your photo/video will be labeled as "Promotional content"'));
      else brand.append(note('warn', 'Уточните рекламу', 'Отметьте, что продвигает пост: свой бренд или чужой.'));
    }
    wrap.append(brand);

    // --- длина ролика ---
    const video = media.find((m) => m.kind === 'video');
    if (video?.duration && creator.maxVideoSeconds && video.duration > creator.maxVideoSeconds + 0.5) {
      wrap.append(note('danger', 'Ролик длиннее разрешённого', `${Math.round(video.duration)} с, а этому аккаунту TikTok через API можно до ${creator.maxVideoSeconds} с.`));
    }

    // --- согласие ---
    const consent = el('p', 'tt-options__consent');
    consent.append('By posting, you agree to TikTok\'s ');
    if (o.commercial && o.brandedContent) {
      consent.append(link('Branded Content Policy', BRANDED_POLICY), ' and ');
    }
    consent.append(link('Music Usage Confirmation', MUSIC_POLICY));
    wrap.append(consent);
    wrap.append(el('span', 'field__hint', 'После отправки TikTok обрабатывает пост несколько минут — только потом он появится в аккаунте.'));
  }
}

function checkbox(title, checked, disabled, onChange, hint = '') {
  const label = el('label', 'tt-check');
  if (disabled) label.classList.add('tt-check--off');
  if (hint) label.title = hint;
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  label.append(input, el('span', null, title));
  return label;
}

function link(text, href) {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
