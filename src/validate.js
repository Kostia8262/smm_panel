/**
 * Проверка поста перед постановкой в очередь.
 *
 * Двухуровневая намеренно:
 *   blocker — площадка физически не примет (PNG в Instagram, 700 символов
 *             в Threads). В очередь такой пост не пускаем.
 *   warning — примет, но выйдет плохо (текст заедет под кнопки TikTok,
 *             подпись разорвётся на два сообщения в Telegram). Решает человек.
 *
 * Всё считается из справочника площадок, своих цифр здесь нет. Лимиты берутся
 * у раскладки, а не у площадки: сторис и Reels у одной сети живут по разным
 * правилам (см. `mediaRulesFor`).
 *
 * Проверяется каждая цель поста отдельно — площадка плюс раскладка, со своими
 * кадрами. У поста может быть и лента Instagram, и сторис Instagram, и
 * замечание к одной не должно выглядеть замечанием к другой.
 */

import { PLATFORMS, formatOf, mediaRulesFor } from './platforms/specs.js';
import { withSignature } from './signature.js';
import { withShortLinks } from './shortlink.js';
import { optionIssues } from './target-options.js';
import { splitText, CAPTION_LIMIT, TEXT_LIMIT } from './platforms/telegram.js';
import { parseAudio, audioAllowed, audioLabel } from './audio.js';

const mimeToType = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/** Как кодеки называть человеку. */
const CODEC_TITLES = {
  h264: 'H.264',
  hevc: 'HEVC',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
  mpeg4: 'MPEG-4 Part 2',
  aac: 'AAC',
  mp4a: 'AAC',
  mp3: 'MP3',
  pcm: 'PCM',
  opus: 'Opus',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  alac: 'ALAC',
};

/** Вертикаль 9:16 — это 0.5625; до 0.62 на глаз неотличимо. */
const VERTICAL_MAX = 0.62;

export function fileType(mime) {
  return mimeToType[String(mime).toLowerCase()] || null;
}

function humanBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.round(n / 1024)} КБ`;
}

function humanSeconds(sec) {
  const s = Math.round(sec);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} мин ${rest} с` : `${m} мин`;
}

function codecTitle(codec) {
  return CODEC_TITLES[codec] || String(codec).toUpperCase();
}

function countHashtags(text) {
  return (String(text).match(/(^|\s)#[^\s#]+/g) || []).length;
}

/**
 * Какие кадры выбраны у цели.
 *
 * `null` — все кадры поста, так было всегда и так остаётся по умолчанию.
 * Список — только эти, **в порядке кадров поста**, а не в порядке выбора:
 * порядок серии задаётся одним местом, иначе сторис разъедутся.
 */
export function targetMediaIds(target) {
  const raw = target?.media_ids;
  if (raw === null || raw === undefined || raw === '') return null;
  if (Array.isArray(raw)) return raw.map(Number);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number) : null;
  } catch {
    return null;
  }
}

export function mediaFor(post, target) {
  const all = post?.media || [];
  const ids = targetMediaIds(target);
  // Ролик, собранный панелью из фото (`derived`), — кадр только той цели, что
  // выбрала его явно: иначе он ушёл бы в Telegram рядом с теми же фото.
  if (!ids) return all.filter((m) => !m.derived);
  const wanted = new Set(ids);
  return all.filter((m) => wanted.has(Number(m.id)));
}

/** Подпись цели для человека: «Instagram · Stories». */
export function targetLabel(target) {
  const spec = PLATFORMS[target.platform];
  if (!spec) return target.platform;
  const format = formatOf(target.platform, target.format_id);
  return spec.formats.length > 1 && format ? `${spec.title} · ${format.title}` : spec.title;
}

/**
 * @param {{body: string, media: Array, targets: Array, signature?: string}} post
 * @param {{shortLink?: {baseUrl: string, ownDomains: string[]}}} [ctx] — без
 *   `shortLink` длина считается по написанному тексту, без подмены ссылок
 * @returns {{blockers: Array, warnings: Array, byTarget: Object, ok: boolean}}
 */
export function validatePost(post, ctx = {}) {
  const blockers = [];
  const warnings = [];
  const byTarget = {};
  const targets = post.targets || [];

  if (!targets.length) {
    blockers.push({ platform: null, message: 'Не выбрана ни одна площадка' });
  }

  for (const target of targets) {
    const spec = PLATFORMS[target.platform];
    const key = `${target.platform}:${target.format_id}`;
    const issues = { blockers: [], warnings: [] };
    byTarget[key] = issues;

    if (!spec) {
      issues.blockers.push(`Неизвестная площадка «${target.platform}»`);
      blockers.push({ platform: target.platform, target: key, label: target.platform, message: issues.blockers[0] });
      continue;
    }

    const format = formatOf(spec.id, target.format_id);
    const rules = mediaRulesFor(spec.id, format.id);
    const media = mediaFor(post, target);
    const hasMedia = media.length > 0;

    checkText(post, target, spec, format, hasMedia, issues, ctx);
    checkMediaSet(post, target, spec, format, rules, media, issues);
    for (const m of media) checkFile(m, spec, format, rules, issues);
    checkSound(post, target, spec, format, media, issues);
    const opt = optionIssues(spec.id, target.options, { mediaCount: media.length });
    issues.blockers.push(...opt.blockers);
    issues.warnings.push(...opt.warnings);

    // --- готовность канала ---
    if (!spec.ready) {
      issues.warnings.push('Адаптер ещё не подключён — пост встанет в очередь и будет ждать');
    }
    if (spec.id === 'tiktok') {
      issues.warnings.push('До аудита TikTok опубликует приватно (SELF_ONLY)');
    }
    if (format.role === 'story') {
      issues.warnings.push('В сторис через API не будет ни ссылки, ни стикеров, ни опроса');
    }

    const label = targetLabel(target);
    for (const b of issues.blockers) blockers.push({ platform: spec.id, target: key, label, message: b });
    for (const w of issues.warnings) warnings.push({ platform: spec.id, target: key, label, message: w });
  }

  return { blockers, warnings, byTarget, ok: blockers.length === 0 };
}

/**
 * Звук цели и ролик из фото.
 *
 * Звук из библиотеки Instagram прикрепляется только к Reels; выбранный к посту,
 * который выйдет фото или каруселью, он потерялся бы молча. Ролик из фото
 * собран из конкретных фото с конкретным кадрированием — поменяли их после
 * сборки, и в сеть ушли бы вчерашние кадры.
 */
function checkSound(post, target, spec, format, media, issues) {
  const audio = spec.id === 'instagram' ? parseAudio(target.audio) : null;

  const reel = media.find((m) => m.derived);
  if (reel) {
    if (!derivedIsFresh(post, reel)) {
      issues.blockers.push('Фото поменялись после сборки ролика — соберите Reels из фото заново');
    }
    if (!audio?.id) issues.warnings.push('Ролик из фото без звука — выберите трек, иначе Reels выйдет немым');
  }

  if (!audio?.id) return;
  if (!audioAllowed(format, media)) {
    // У раскладки Reels без ролика отказ уже есть — второй, про звук, был бы шумом.
    if (format.role !== 'reel') {
      issues.blockers.push('Звук из библиотеки Instagram прикрепляется только к Reels — одному ролику. Уберите звук или выберите Reels');
    }
    return;
  }
  if (audio.missing) {
    issues.blockers.push(`Звук ${audioLabel(audio)} пропал из библиотеки Instagram — выберите другой`);
  }
  if (audio.audioVolume === 0) {
    issues.warnings.push('Громкость трека 0 — звука из библиотеки слышно не будет');
  }
}

function parseDerived(m) {
  if (!m?.derived) return null;
  try {
    const d = typeof m.derived === 'string' ? JSON.parse(m.derived) : m.derived;
    return Array.isArray(d?.sources) ? d : null;
  } catch {
    return null;
  }
}

/** Ролик собран из тех фото и с тем кадрированием, что у поста сейчас. */
export function derivedIsFresh(post, m) {
  const d = parseDerived(m);
  if (!d) return true;
  const photos = new Map((post.media || []).filter((x) => x.kind === 'image' && !x.derived).map((x) => [Number(x.id), x]));
  return d.sources.every((s) => {
    const photo = photos.get(Number(s.id));
    return (
      photo &&
      Math.abs((photo.focus_x ?? 0.5) - (s.focus_x ?? 0.5)) < 0.002 &&
      Math.abs((photo.focus_y ?? 0.5) - (s.focus_y ?? 0.5)) < 0.002
    );
  });
}

function checkText(post, target, spec, format, hasMedia, issues, ctx) {
  // Сторис текста не показывает, и он не уходит вовсе — считать его лимиты
  // значит блокировать сторис за длинный текст ленты того же поста.
  if (format.noText) return;

  // Подпись — часть поста, а не довесок при отправке: если её не считать,
  // пост пройдёт проверку в композере и отвалится у площадки.
  const written = withSignature(target.text_override ?? post.body ?? '', post.signature).trim();
  // Считаем текст таким, каким он уйдёт: наши ссылки при отправке становятся
  // короткими, и короткая обычно длиннее исходной.
  const text = ctx.shortLink ? withShortLinks(written, ctx.shortLink) : written;
  const viaLinks = text.length > written.length ? ' с учётом коротких ссылок' : '';
  const limit = hasMedia ? spec.text.limitWithMedia : spec.text.limit;

  if (!text && !hasMedia) {
    issues.blockers.push('Пусто: ни текста, ни медиа');
  }

  // Telegram длинный пост не отвергает: адаптер досылает продолжение
  // сообщениями, разрезая по абзацам и словам. Блокировать тут нечего.
  if (spec.text.splits) {
    const parts = splitText(text, hasMedia ? CAPTION_LIMIT : TEXT_LIMIT).length;
    if (parts > 1) {
      issues.warnings.push(
        `Текст${viaLinks} — ${text.length} символов: Telegram получит его ${parts} сообщениями` +
          (hasMedia ? ` (подпись к медиа — до ${CAPTION_LIMIT})` : '')
      );
    }
  } else if (text.length > limit) {
    issues.blockers.push(`Текст${viaLinks} длиннее лимита на ${text.length - limit} символов (можно ${limit})`);
  } else if (text.length > limit * 0.9) {
    issues.warnings.push(`Текст${viaLinks} почти упёрся в лимит: ${text.length} из ${limit}`);
  }

  const tags = countHashtags(text);
  if (spec.text.hashtagLimit && tags > spec.text.hashtagLimit) {
    const message = `Хэштегов ${tags} при пределе ${spec.text.hashtagLimit}`;
    if (spec.text.hashtagLimitHard) issues.blockers.push(`${message} — публикацию отклонят`);
    else issues.warnings.push(`${message} — лишние останутся обычным текстом`);
  }
}

function checkMediaSet(post, target, spec, format, rules, media, issues) {
  const explicit = targetMediaIds(target) !== null;

  if (rules.required && !media.length) {
    if (explicit && (post.media || []).length) {
      issues.blockers.push('Не выбран ни один кадр — отметьте, какие файлы уходят сюда');
    } else if (format.role === 'story') {
      issues.blockers.push('Сторис без кадра не бывает — загрузите картинку или видео');
    } else if (rules.kinds?.length === 1 && rules.kinds[0] === 'video') {
      issues.blockers.push(`${format.title} без ролика не бывает — загрузите видео`);
    } else {
      issues.blockers.push('Площадка не публикует посты без медиа');
    }
  } else if (!media.length && explicit && (post.media || []).length) {
    // Кадры у поста есть, а у цели выбор пуст — чаще всего сняли её кадр.
    issues.warnings.push('Кадры не выбраны — уйдёт только текст');
  }

  if (rules.kinds && media.some((m) => !rules.kinds.includes(m.kind))) {
    const allowed = rules.kinds.includes('video') && rules.kinds.length === 1 ? 'только видео' : rules.kinds.join(', ');
    issues.blockers.push(`${format.title} — ${allowed}: картинку сюда не опубликовать`);
  }

  if (media.length > rules.groupMax) {
    if (rules.groupMax === 1) {
      issues.blockers.push(`${format.title} — ровно один файл, а выбрано ${media.length}`);
    } else if (format.series) {
      issues.blockers.push(`Кадров в серии ${media.length}, за раз уходит не больше ${rules.groupMax}`);
    } else {
      issues.blockers.push(`Файлов ${media.length}, через API проходит не более ${rules.groupMax}`);
    }
  }

  // Facebook собирает несколько файлов фотоальбомом, и видео в нём адаптер
  // пропускал молча: пост выходил без ролика, а в панели значился целиком.
  if (rules.groupImagesOnly && media.length > 1 && media.some((m) => m.kind === 'video')) {
    issues.blockers.push(
      'Несколько файлов уходят фотоальбомом — видео в нём не опубликуется. Оставьте ролик один или отправьте его Reels'
    );
  }
}

function checkFile(m, spec, format, rules, issues) {
  // Файл, который раскладка не принимает вовсе, уже назван в отказе «только
  // видео» — разбирать его размеры и соотношение значит засыпать человека
  // замечаниями о том, что и так не уйдёт.
  if (rules.kinds && !rules.kinds.includes(m.kind)) return;
  const type = fileType(m.mime);
  const video = m.kind === 'video';
  const r = video ? rules.video : rules.image;
  const name = m.original_name || `файл #${m.id}`;

  if (!type) {
    issues.warnings.push(`${name}: неизвестный тип ${m.mime}, проверить вручную`);
    return;
  }
  if (!r.types.includes(type)) {
    issues.blockers.push(
      `${name}: формат ${type.toUpperCase()} не принимается, нужен ${r.types.map((t) => t.toUpperCase()).join(' или ')}`
    );
  }
  if (r.maxBytes && m.bytes > r.maxBytes) {
    issues.blockers.push(`${name}: ${humanBytes(m.bytes)} — больше предела ${humanBytes(r.maxBytes)}`);
  } else if (r.maxBytesByUrl && m.bytes > r.maxBytesByUrl) {
    issues.warnings.push(
      `${name}: ${humanBytes(m.bytes)} — по ссылке площадка берёт до ${humanBytes(r.maxBytesByUrl)}, зальём файлом`
    );
  }

  const ratio = m.width && m.height ? m.width / m.height : null;

  if (video) {
    if (m.duration) {
      if (r.maxSeconds && m.duration > r.maxSeconds + 0.05) {
        issues.blockers.push(`${name}: ${humanSeconds(m.duration)} — длиннее предела ${humanSeconds(r.maxSeconds)}`);
      }
      if (r.minSeconds && m.duration < r.minSeconds - 0.05) {
        issues.blockers.push(`${name}: ${humanSeconds(m.duration)} — короче ${humanSeconds(r.minSeconds)}, площадка не примет`);
      }
    } else if (r.maxSeconds || r.minSeconds) {
      const range = r.minSeconds ? `${r.minSeconds}–${r.maxSeconds} с` : `до ${humanSeconds(r.maxSeconds)}`;
      issues.warnings.push(`${name}: длительность не прочитана — проверьте сами, что ролик ${range}`);
    }
    if (m.video_codec && r.codecs && !r.codecs.includes(m.video_codec)) {
      issues.blockers.push(
        `${name}: видео в ${codecTitle(m.video_codec)} — площадка принимает ${r.codecs.map(codecTitle).join(' или ')}. Пересохраните ролик в MP4 (H.264)`
      );
    }
    if (m.audio_codec && r.audio && !r.audio.includes(m.audio_codec)) {
      issues.warnings.push(`${name}: звук в ${codecTitle(m.audio_codec)} — площадка ждёт AAC, ролик может не пройти обработку`);
    }
    if (m.fps && ((r.fpsMin && m.fps < r.fpsMin - 0.5) || (r.fpsMax && m.fps > r.fpsMax + 0.5))) {
      issues.warnings.push(`${name}: ${Math.round(m.fps)} кадров в секунду — площадка ждёт ${r.fpsMin}–${r.fpsMax}`);
    }
  }

  if (ratio) {
    // Лента Instagram отказывает кадру вне 4:5…1.91:1, а не обрезает его.
    if (!video && r.aspectMin && ratio < r.aspectMin - 0.01) {
      issues.blockers.push(
        `${name}: кадр ${m.width}×${m.height} слишком вытянут вверх для ленты (можно от 4:5). Вертикаль 9:16 — в сторис или Reels`
      );
    }
    if (!video && r.aspectMax && ratio > r.aspectMax + 0.01) {
      issues.blockers.push(`${name}: кадр ${m.width}×${m.height} слишком широкий для ленты (можно до 1.91:1)`);
    }
    // Telegram отвергает фото с суммой сторон больше 10000 или вытянутое
    // сильнее 1:20 — PHOTO_INVALID_DIMENSIONS, а не сжатие.
    if (!video && r.sideSumMax && m.width + m.height > r.sideSumMax) {
      issues.blockers.push(`${name}: кадр ${m.width}×${m.height} — сумма сторон больше ${r.sideSumMax}, площадка не примет фото`);
    }
    if (!video && r.stretchMax && Math.max(ratio, 1 / ratio) > r.stretchMax) {
      issues.blockers.push(`${name}: кадр ${m.width}×${m.height} вытянут сильнее 1:${r.stretchMax} — площадка не примет фото`);
    }
    if (format.vertical && ratio > VERTICAL_MAX) {
      const what = ratio > 1 ? 'горизонтальный' : 'не вертикальный 9:16';
      issues.warnings.push(`${name}: кадр ${m.width}×${m.height} ${what} — в ${format.title} выйдет с полями`);
    }
  }
}
