/**
 * Оценка «зашёл ли пост».
 *
 * Формула подсмотрена в расширении ThreadsAI и она хороша тем, что честно
 * учитывает две вещи сразу: вес разных реакций и возраст поста. Двадцать
 * лайков за час и двадцать за неделю — разные события, а голый счётчик
 * лайков их не различает.
 *
 * Веса: комментарий дороже лайка втрое, репост и цитата — вчетверо. Логика
 * простая: лайк стоит одного движения пальцем, комментарий — усилия, репост
 * отдаёт пост своей аудитории.
 *
 * Пороги разложены по возрасту: для свежего поста пять лайков — уже сигнал,
 * для суточного те же пять означают, что он не пошёл.
 */

/** Вес каждого типа реакции. Меняется только вместе с порогами ниже. */
const WEIGHTS = { likes: 1, comments: 3, reposts: 4, quotes: 4 };

/** Меньше 20 минут делить нельзя: пост, вышедший минуту назад, дал бы бесконечность. */
const MIN_HOURS = 0.35;

/**
 * @param {{likes?: number, comments?: number, reposts?: number, quotes?: number}} stats
 * @param {number} ageHours возраст поста в часах
 */
export function momentum(stats = {}, ageHours = 24) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const score =
    num(stats.likes) * WEIGHTS.likes +
    num(stats.comments) * WEIGHTS.comments +
    num(stats.reposts) * WEIGHTS.reposts +
    num(stats.quotes) * WEIGHTS.quotes;

  const hours = Math.max(MIN_HOURS, Number.isFinite(ageHours) ? ageHours : 24);
  return { score, perHour: score / hours, hours };
}

/**
 * Что это за пост: взлетел, обычный или не пошёл.
 *
 * Возвращает не только метку, но и причину — иначе в панели будет висеть
 * ярлык без объяснения, и доверия к нему не будет.
 */
export function classify(stats = {}, ageHours = 24) {
  const { score, perHour, hours } = momentum(stats, ageHours);
  const likes = Number(stats.likes) || 0;
  const comments = Number(stats.comments) || 0;

  // Взлетел: либо сразу подхватили, либо набрал много за сутки.
  const earlyBurst = hours <= 1.5 && (likes >= 5 || comments >= 2 || score >= 8 || perHour >= 6);
  const strongDay = hours <= 6 && (score >= 22 || perHour >= 5 || comments >= 6);
  const bigOverall = likes >= 100 || comments >= 15 || score >= 140;

  if (earlyBurst || strongDay || bigOverall) {
    return {
      label: 'hot',
      title: 'Зашёл',
      reason:
        hours <= 1.5
          ? `быстрый отклик: ${score} баллов за ${hours.toFixed(1)} ч`
          : `сильная реакция: ${score} баллов, ${perHour.toFixed(1)} в час`,
      score,
      perHour,
    };
  }

  // Не пошёл: время было, реакции нет.
  const deadSilence = hours >= 1 && likes === 0 && comments === 0 && !Number(stats.reposts);
  const weakEarly = hours >= 3 && score < 3;
  const weakDay = hours >= 12 && score < 8;

  if (deadSilence || weakEarly || weakDay) {
    return {
      label: 'cold',
      title: 'Не пошёл',
      reason: `слабая реакция: ${score} баллов за ${hours.toFixed(1)} ч`,
      score,
      perHour,
    };
  }

  return {
    label: 'normal',
    title: 'Обычный',
    reason: `${score} баллов, ${perHour.toFixed(1)} в час`,
    score,
    perHour,
  };
}

/**
 * Часы с момента публикации. Время в базе местное и без зоны — та же
 * договорённость, что и во всей панели.
 */
export function ageHoursOf(publishedAt, now = new Date()) {
  if (!publishedAt) return 24;
  const at = new Date(String(publishedAt).replace(' ', 'T'));
  if (Number.isNaN(at.getTime())) return 24;
  return (now - at) / 3600000;
}
