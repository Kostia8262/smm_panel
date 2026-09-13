/**
 * Миниатюра кадра — делается в браузере при загрузке.
 *
 * Зачем: оригинал снимается с сервера после публикации, а история в календаре
 * должна остаться с картинкой. Делать миниатюру на сервере нечем и нельзя —
 * sharp требует нативной сборки, а единственное ядро VPS делят шестнадцать
 * сайтов. Браузер же файл уже держит, и canvas справляется за миллисекунды.
 *
 * Попутно календарь перестаёт тянуть многомегабайтные оригиналы ради карточки
 * в сто пикселей.
 *
 * Всё здесь — «по возможности»: не получилась миниатюра (видео в кодеке,
 * которого браузер не знает, битый файл) — файл грузится без неё, а панель
 * показывает прежнюю заглушку. Загрузку это не роняет никогда.
 */

/** Длинная сторона. Карточка календаря ~130 px, превью кадра ~320 px, плюс запас на плотные экраны. */
const SIDE = 480;
const QUALITY = 0.8;
const VIDEO_TIMEOUT_MS = 8000;

/**
 * @param {File} file
 * @returns {Promise<Blob|null>}
 */
export async function makeThumb(file) {
  try {
    if (file.type.startsWith('image/')) return await imageThumb(file);
    if (file.type.startsWith('video/')) return await videoThumb(file);
  } catch {
    // Не вышло — грузим без миниатюры, см. комментарий вверху.
  }
  return null;
}

async function imageThumb(file) {
  // createImageBitmap сам поворачивает кадр по EXIF: снимок с телефона иначе
  // лёг бы в миниатюру на боку, хотя в оригинале стоит ровно.
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      return await toJpeg(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close?.();
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    return await toJpeg(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Кадр из видео. Берём не самый первый — он часто чёрный (затемнение в
 * начале ролика), — а на трети длины, но не дальше первой секунды.
 */
async function videoThumb(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await withTimeout(once(video, 'loadeddata'), VIDEO_TIMEOUT_MS);
    const at = Math.min(1, (video.duration || 0) / 3);
    if (at > 0) {
      video.currentTime = at;
      await withTimeout(once(video, 'seeked'), VIDEO_TIMEOUT_MS);
    }
    if (!video.videoWidth || !video.videoHeight) return null;
    return await toJpeg(video, video.videoWidth, video.videoHeight);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function toJpeg(source, width, height) {
  const scale = Math.min(1, SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // Прозрачный PNG без подложки стал бы в JPEG чёрным.
  ctx.fillStyle = '#1a1512';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', QUALITY));
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, resolve, { once: true });
    target.addEventListener('error', reject, { once: true });
  });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
