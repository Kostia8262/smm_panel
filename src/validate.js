/**
 * Проверка поста перед постановкой в очередь.
 *
 * Двухуровневая намеренно:
 *   blocker — площадка физически не примет (PNG в Instagram, 700 символов
 *             в Threads). В очередь такой пост не пускаем.
 *   warning — примет, но выйдет плохо (текст заедет под кнопки TikTok,
 *             подпись разорвётся на два сообщения в Telegram). Решает человек.
 *
 * Всё считается из справочника площадок, своих цифр здесь нет.
 */

import { PLATFORMS } from './platforms/specs.js';
import { withSignature } from './signature.js';

const mimeToType = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export function fileType(mime) {
  return mimeToType[String(mime).toLowerCase()] || null;
}

function humanBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.round(n / 1024)} КБ`;
}

function countHashtags(text) {
  return (String(text).match(/(^|\s)#[^\s#]+/g) || []).length;
}

/**
 * @param {{body: string, media: Array, targets: Array}} post
 * @returns {{blockers: Array, warnings: Array, byPlatform: Object}}
 */
export function validatePost(post) {
  const blockers = [];
  const warnings = [];
  const byPlatform = {};
  const media = post.media || [];
  const targets = post.targets || [];

  if (!targets.length) {
    blockers.push({ platform: null, message: 'Не выбрана ни одна площадка' });
  }

  for (const target of targets) {
    const spec = PLATFORMS[target.platform];
    const issues = { blockers: [], warnings: [] };
    byPlatform[target.platform] = issues;

    if (!spec) {
      issues.blockers.push(`Неизвестная площадка «${target.platform}»`);
      continue;
    }

    // Подпись — часть поста, а не довесок при отправке: если её не считать,
    // пост пройдёт проверку в композере и отвалится у площадки.
    const text = withSignature(target.text_override ?? post.body ?? '', post.signature).trim();
    const hasMedia = media.length > 0;
    const limit = hasMedia ? spec.text.limitWithMedia : spec.text.limit;

    // --- текст ---
    if (!text && !hasMedia) {
      issues.blockers.push('Пусто: ни текста, ни медиа');
    }
    if (text.length > limit) {
      const over = text.length - limit;
      if (spec.id === 'telegram' && hasMedia && text.length <= spec.text.limit) {
        issues.warnings.push(
          `Подпись длиннее ${limit} символов на ${over} — Telegram разорвёт пост на два сообщения`
        );
      } else {
        issues.blockers.push(`Текст длиннее лимита на ${over} символов (можно ${limit})`);
      }
    } else if (text.length > limit * 0.9) {
      issues.warnings.push(`Текст почти упёрся в лимит: ${text.length} из ${limit}`);
    }

    const tags = countHashtags(text);
    if (spec.text.hashtagLimit && tags > spec.text.hashtagLimit) {
      const message = `Хэштегов ${tags} при пределе ${spec.text.hashtagLimit}`;
      if (spec.text.hashtagLimitHard) issues.blockers.push(`${message} — публикацию отклонят`);
      else issues.warnings.push(`${message} — лишние останутся обычным текстом`);
    }

    // --- медиа ---
    if (spec.media.required && !hasMedia) {
      issues.blockers.push('Площадка не публикует посты без медиа');
    }
    if (hasMedia && media.length > spec.media.groupMax) {
      issues.blockers.push(
        `Файлов ${media.length}, через API проходит не более ${spec.media.groupMax}`
      );
    }

    for (const m of media) {
      const type = fileType(m.mime);
      const rules = m.kind === 'video' ? spec.media.video : spec.media.image;
      const name = m.original_name || `файл #${m.id}`;

      if (!type) {
        issues.warnings.push(`${name}: неизвестный тип ${m.mime}, проверить вручную`);
        continue;
      }
      if (!rules.types.includes(type)) {
        issues.blockers.push(
          `${name}: формат ${type.toUpperCase()} не принимается, нужен ${rules.types
            .map((t) => t.toUpperCase())
            .join(' или ')}`
        );
      }
      if (rules.maxBytes && m.bytes > rules.maxBytes) {
        issues.blockers.push(
          `${name}: ${humanBytes(m.bytes)} — больше предела ${humanBytes(rules.maxBytes)}`
        );
      } else if (rules.maxBytesByUrl && m.bytes > rules.maxBytesByUrl) {
        issues.warnings.push(
          `${name}: ${humanBytes(m.bytes)} — по ссылке площадка берёт до ${humanBytes(
            rules.maxBytesByUrl
          )}, зальём файлом`
        );
      }
      if (m.kind === 'video' && rules.maxSeconds && m.duration && m.duration > rules.maxSeconds) {
        issues.blockers.push(
          `${name}: ${Math.round(m.duration)} с — длиннее предела ${rules.maxSeconds} с`
        );
      }
    }

    // --- готовность канала ---
    if (!spec.ready) {
      issues.warnings.push('Адаптер ещё не подключён — пост встанет в очередь и будет ждать');
    }
    if (spec.id === 'tiktok') {
      issues.warnings.push('До аудита TikTok опубликует приватно (SELF_ONLY)');
    }
    if (spec.id === 'instagram' && targets.some((t) => t.format_id === 'story')) {
      issues.warnings.push('В сторис через API не будет ни ссылки, ни стикеров, ни опроса');
    }

    for (const b of issues.blockers) blockers.push({ platform: spec.id, message: b });
    for (const w of issues.warnings) warnings.push({ platform: spec.id, message: w });
  }

  return { blockers, warnings, byPlatform, ok: blockers.length === 0 };
}
