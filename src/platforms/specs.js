/**
 * Единый источник правды по площадкам: раскладки, лимиты, безопасные зоны.
 *
 * Отсюда берут данные три потребителя разом:
 *   1. превью в композере (рамки кадра и оверлей интерфейса),
 *   2. валидатор (блокеры и предупреждения перед постановкой в очередь),
 *   3. подписи ограничений в интерфейсе.
 *
 * Цифры сверены с документацией на 10.09.2026 и помечены `verify`, если
 * площадка их регулярно меняет. Перед включением адаптера в бой — перечитать
 * помеченные строки, а суточный лимит Instagram вообще не хардкодить:
 * он читается из GET /<IG_ID>/content_publishing_limit.
 *
 * Лимиты медиа живут на двух уровнях. У площадки — общие, у раскладки —
 * уточнения поверх них (`format.media`). Так устроены сами сети: Reels у
 * Facebook — до 90 секунд, а обычное видео в ленту этим пределом не
 * ограничено; сторис Instagram — до 60 секунд и 100 МБ, а Reels — до 15 минут
 * и 300 МБ. Пока лимит был один на площадку, проверка либо пропускала
 * заведомый отказ, либо запрещала то, что сеть примет. Сводит уровни
 * `mediaRulesFor`. Сверено с документацией Meta 13.09.2026.
 *
 * Поля медиа:
 *   image   — { types, maxBytes, maxBytesByUrl?, aspectMin?, aspectMax? },
 *             соотношение — ширина / высота;
 *   video   — { types, maxBytes, minSeconds?, maxSeconds?, codecs?, audio?,
 *             fpsMin?, fpsMax? }, кодеки — как их называет video-probe.js;
 *   groupMax — сколько файлов уходит одной публикацией (у сторис — кадров в
 *             серии, каждый кадр — отдельная сторис);
 *   kinds   — какие файлы раскладка принимает вовсе (Reels — только видео);
 *   groupImagesOnly — несколько файлов площадка публикует только фотоальбомом.
 *
 * Поля раскладки:
 *   series   — каждый файл уходит отдельной публикацией по порядку (сторис);
 *   noText   — текст площадка не показывает, и он не уходит вовсе;
 *   vertical — рассчитана на кадр 9:16, остальное выйдет с полями.
 *
 * Безопасные зоны заданы в процентах от кадра, а не в пикселях: интерфейс
 * площадок тянется по ширине экрана, проценты переживают смену размеров.
 */

const MB = 1024 * 1024;

export const PLATFORMS = {
  telegram: {
    id: 'telegram',
    title: 'Telegram',
    accent: '#2AABEE',
    order: 1,
    ready: true, // адаптер рабочий, проверок со стороны площадки не требует
    editable: true, // вышедший пост правится из панели: текст, кнопка, превью, закреп
    text: {
      limit: 4096, // одно сообщение; длиннее адаптер досылает следующими
      limitWithMedia: 1024, // подпись к медиа: длиннее — продолжение уйдёт отдельным сообщением
      splits: true, // лимит не отказ: длинный текст уходит несколькими сообщениями
      hashtagLimit: null,
    },
    media: {
      // Фото уходит файлом, не ссылкой, — предел 5 МБ «по ссылке» сюда не относится.
      // Сумма сторон и вытянутость — пределы sendPhoto (PHOTO_INVALID_DIMENSIONS).
      image: { types: ['jpeg', 'png', 'webp'], maxBytes: 10 * MB, sideSumMax: 10000, stretchMax: 20 },
      // 50 МБ — предел загрузки файла ботом. Больше Bot API не примет вовсе.
      video: { types: ['mp4'], maxBytes: 50 * MB, maxSeconds: null },
      groupMax: 10,
      required: false, // можно публиковать голый текст
    },
    formats: [
      { id: 'any', title: 'Любой кадр', w: 1080, h: 1080, role: 'feed', note: 'Telegram не режет кадр' },
    ],
    safeZones: {},
    notes: [
      'Подпись к фото и видео — до 1024 символов; длиннее — продолжение уйдёт следом отдельным сообщением.',
      'Текст режется по абзацам и словам, ссылки не разрываются.',
      'Бот должен быть админом канала с правом публикации.',
      'Сторис бот в канал не публикует — только посты.',
    ],
  },

  threads: {
    id: 'threads',
    title: 'Threads',
    accent: '#000000',
    order: 2,
    ready: true, // все форматы прошли боем 13.09.2026
    text: {
      limit: 500, // самый жёсткий лимит из пяти — под него режем текст в первую очередь
      limitWithMedia: 500,
      // Threads примет сколько угодно решёток, но темой сделает только первую.
      // Это про вид поста, а не про отказ — отсюда мягкий лимит.
      hashtagLimit: 1,
      hashtagLimitHard: false,
    },
    media: {
      image: { types: ['jpeg', 'png'], maxBytes: 8 * MB },
      video: {
        types: ['mp4', 'mov'],
        maxBytes: 1024 * MB,
        maxSeconds: 300,
        codecs: ['h264', 'hevc'],
        audio: ['aac', 'mp4a'],
        fpsMin: 23,
        fpsMax: 60,
      },
      groupMax: 20,
      required: false,
    },
    formats: [
      { id: 'square', title: 'Квадрат', w: 1080, h: 1080, role: 'feed' },
      { id: 'portrait', title: 'Портрет', w: 1080, h: 1350, role: 'feed' },
    ],
    safeZones: {},
    dailyLimit: 250, // verify
    notes: [
      'Соотношение сторон до 10:1 — режется всё, что уже.',
      'Токен живёт 60 дней и продлевается заранее, иначе постинг встанет молча.',
      'Сторис у Threads нет.',
    ],
  },

  instagram: {
    id: 'instagram',
    title: 'Instagram',
    accent: '#E1306C',
    order: 3,
    ready: true, // лента, карусель, сторис и Reels прошли боем 12.09.2026
    text: {
      limit: 2200,
      limitWithMedia: 2200,
      hashtagLimit: 30, // сверх тридцати Instagram публикацию отклоняет
      hashtagLimitHard: true,
    },
    media: {
      // Контейнер публикации принимает ТОЛЬКО JPEG. PNG отвергается, причём
      // сообщение об ошибке об этом прямо не говорит — отсюда жёсткий блокер.
      // Кадр ленты и карусели — от 4:5 до 1.91:1, иначе площадка отказывает:
      // вертикаль 9:16 уходит в сторис или Reels, а не в ленту.
      image: { types: ['jpeg'], maxBytes: 8 * MB, aspectMin: 0.8, aspectMax: 1.91 },
      // Одиночное видео в ленте Instagram публикует как Reels — отсюда пределы Reels.
      video: {
        types: ['mp4', 'mov'],
        maxBytes: 300 * MB,
        minSeconds: 3,
        maxSeconds: 900,
        codecs: ['h264', 'hevc'],
        audio: ['aac', 'mp4a'],
        fpsMin: 23,
        fpsMax: 60,
      },
      groupMax: 10, // через API карусель до 10, в приложении больше
      required: true, // без медиа публиковать нечего
    },
    formats: [
      {
        id: 'feed-portrait',
        title: 'Лента, портрет',
        w: 1080,
        h: 1350,
        role: 'feed',
        gridCrop: { ratio: 1, note: 'В сетке профиля обрежется до квадрата по центру' },
      },
      { id: 'feed-square', title: 'Лента, квадрат', w: 1080, h: 1080, role: 'feed' },
      {
        id: 'reels',
        title: 'Reels',
        w: 1080,
        h: 1920,
        role: 'reel',
        vertical: true,
        media: { kinds: ['video'], groupMax: 1, required: true },
      },
      {
        id: 'story',
        title: 'Stories',
        w: 1080,
        h: 1920,
        role: 'story',
        series: true,
        noText: true,
        vertical: true,
        media: {
          // У сторис соотношение любое — площадка сама добавит поля.
          image: { types: ['jpeg'], maxBytes: 8 * MB, aspectMin: null, aspectMax: null },
          video: { maxBytes: 100 * MB, minSeconds: 3, maxSeconds: 60 },
          groupMax: 10,
        },
      },
    ],
    safeZones: {
      reels: [
        { top: 80, left: 0, width: 100, height: 20, label: 'Подпись и звук' },
        { top: 30, left: 86, width: 14, height: 50, label: 'Кнопки' },
      ],
      story: [
        { top: 0, left: 0, width: 100, height: 14, label: 'Аватар и время' },
        { top: 86, left: 0, width: 100, height: 14, label: 'Поле ответа' },
      ],
    },
    notes: [
      'Сторис через API идут БЕЗ ссылки, стикеров и опросов — свайп остаётся ручным.',
      'Серия сторис уходит по кадру: каждый файл — отдельная сторис, по порядку.',
      'Не больше 100 публикаций через API за скользящие сутки (карусель — одна).',
      'Аккаунт должен быть Business или Creator и связан со страницей Facebook.',
    ],
  },

  facebook: {
    id: 'facebook',
    title: 'Facebook',
    accent: '#1877F2',
    order: 4,
    ready: true, // мульти-фото, видео и Reels прошли боем 12.09.2026
    text: {
      limit: 63206,
      limitWithMedia: 63206,
      hashtagLimit: null,
    },
    media: {
      image: { types: ['jpeg', 'png'], maxBytes: 10 * MB }, // verify
      // Обычное видео в ленту: предела в 90 секунд у него нет — он у Reels.
      video: {
        types: ['mp4', 'mov'],
        maxBytes: 1024 * MB,
        maxSeconds: null,
        codecs: ['h264', 'hevc', 'vp9', 'av1'],
      },
      groupMax: 10,
      // Несколько файлов адаптер собирает фотоальбомом: видео в нём не уйдёт.
      groupImagesOnly: true,
      required: false,
    },
    formats: [
      { id: 'feed-landscape', title: 'Лента, горизонт', w: 1200, h: 630, role: 'feed' },
      { id: 'feed-square', title: 'Лента, квадрат', w: 1200, h: 1200, role: 'feed' },
      {
        id: 'reels',
        title: 'Reels',
        w: 1080,
        h: 1920,
        role: 'reel',
        vertical: true,
        media: { kinds: ['video'], groupMax: 1, groupImagesOnly: false, required: true, video: { minSeconds: 3, maxSeconds: 90 } },
      },
      {
        id: 'story',
        title: 'Stories',
        w: 1080,
        h: 1920,
        role: 'story',
        series: true,
        noText: true,
        vertical: true,
        media: {
          video: { minSeconds: 3, maxSeconds: 60 },
          groupMax: 10,
          groupImagesOnly: false,
          required: true,
        },
      },
    ],
    safeZones: {
      reels: [
        { top: 82, left: 0, width: 100, height: 18, label: 'Подпись' },
        { top: 30, left: 86, width: 14, height: 52, label: 'Кнопки' },
      ],
      story: [
        { top: 0, left: 0, width: 100, height: 14, label: 'Страница и время' },
        { top: 86, left: 0, width: 100, height: 14, label: 'Поле ответа' },
      ],
    },
    notes: [
      'Публикация только на страницу — с личного профиля API постить не даёт.',
      'Несколько файлов уходят фотоальбомом — видео в нём не публикуется.',
      'Сторис страницы — без ссылок и стикеров; видео в сторис до 60 секунд.',
      'Токен страницы живёт 60 дней; бессрочный берётся у system user в Business Manager.',
    ],
  },

  tiktok: {
    id: 'tiktok',
    title: 'TikTok',
    accent: '#FE2C55',
    order: 5,
    ready: false,
    text: {
      limit: 2200, // verify: в кабинете встречается и 4000
      limitWithMedia: 2200,
      hashtagLimit: null,
    },
    media: {
      image: { types: ['jpeg', 'webp'], maxBytes: 20 * MB }, // фото-посты
      video: { types: ['mp4', 'mov', 'webm'], maxBytes: 4096 * MB, maxSeconds: 600 },
      groupMax: 35,
      required: true,
    },
    formats: [
      { id: 'video', title: 'Видео', w: 1080, h: 1920, role: 'reel', vertical: true },
      { id: 'photo', title: 'Фото-пост', w: 1080, h: 1920, role: 'feed' },
    ],
    safeZones: {
      reel: [
        { top: 0, left: 0, width: 100, height: 8, label: 'Поиск' },
        { top: 78, left: 0, width: 100, height: 22, label: 'Автор и описание' },
        { top: 25, left: 87, width: 13, height: 53, label: 'Кнопки' },
      ],
    },
    notes: [
      'До аудита публикует ТОЛЬКО приватно (SELF_ONLY) и не более чем для 5 пользователей в сутки.',
      'Загрузка по ссылке требует верификации домена в кабинете, иначе только прямая заливка файлом.',
      'Перед публикацией интерфейс обязан показать имя и аватар автора и подтверждение музыки — этого требует аудит.',
    ],
  },
};

export const PLATFORM_LIST = Object.values(PLATFORMS).sort((a, b) => a.order - b.order);

/** Раскладка площадки по id; неизвестная — первая, как и при сохранении поста. */
export function formatOf(platformId, formatId) {
  const p = PLATFORMS[platformId];
  if (!p) return null;
  return p.formats.find((f) => f.id === formatId) || p.formats[0];
}

/**
 * Лимиты медиа конкретной раскладки: общие площадки, поверх — уточнения
 * раскладки. Вложенные `image` и `video` сливаются по полям, а не заменяются
 * целиком: сторис Instagram меняет длительность видео, а типы файлов и кодеки
 * берёт у площадки.
 */
export function mediaRulesFor(platformId, formatId) {
  const p = PLATFORMS[platformId];
  if (!p) return null;
  const own = formatOf(platformId, formatId)?.media || {};
  return {
    ...p.media,
    ...own,
    image: { ...p.media.image, ...(own.image || {}) },
    video: { ...p.media.video, ...(own.video || {}) },
  };
}

/** Все уникальные раскладки — по ним готовятся нарезки мастер-медиа. */
export function allFormats() {
  const seen = new Map();
  for (const p of PLATFORM_LIST) {
    for (const f of p.formats) {
      const key = `${f.w}x${f.h}`;
      if (!seen.has(key)) seen.set(key, { ...f, key, platforms: [] });
      seen.get(key).platforms.push(p.id);
    }
  }
  return [...seen.values()];
}

/** Безопасные зоны конкретной раскладки: сперва по её id, потом по роли. */
export function safeZonesFor(platformId, formatId) {
  const p = PLATFORMS[platformId];
  if (!p) return [];
  const format = p.formats.find((f) => f.id === formatId);
  if (!format) return [];
  return p.safeZones[formatId] || p.safeZones[format.role] || [];
}

if (process.argv.includes('--selftest')) {
  const problems = [];
  for (const p of PLATFORM_LIST) {
    if (!p.formats.length) problems.push(`${p.id}: нет ни одной раскладки`);
    if (!p.text.limit) problems.push(`${p.id}: не задан лимит текста`);
    for (const f of p.formats) {
      if (!f.w || !f.h) problems.push(`${p.id}/${f.id}: нет размеров кадра`);
      const rules = mediaRulesFor(p.id, f.id);
      if (!rules.groupMax) problems.push(`${p.id}/${f.id}: не задано, сколько файлов за раз`);
      if (!rules.image.types?.length || !rules.video.types?.length) {
        problems.push(`${p.id}/${f.id}: не заданы типы файлов`);
      }
      for (const z of safeZonesFor(p.id, f.id)) {
        if (z.top + z.height > 100 || z.left + z.width > 100) {
          problems.push(`${p.id}/${f.id}: зона «${z.label}» вылезает за кадр`);
        }
      }
    }
  }
  if (problems.length) {
    console.error('Справочник площадок неполон:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log(
    `Справочник в порядке: ${PLATFORM_LIST.length} площадок, ${allFormats().length} уникальных раскладок`
  );
}
