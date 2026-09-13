/**
 * Окно отправки и прогноз окончания рассылки (docs/рассылка.md, §8.4).
 *
 * Время окна — по часовому поясу школы (Киев), а не сервера: сервер может
 * стоять в UTC, а письмо в 06:00 по Киеву пришло бы родителям до будильника.
 * Считаем без библиотек: смещение пояса берём у `Intl` на нужный момент.
 */

import { SENDING } from '../specs.js';

const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    );
  }
  return formatters.get(timeZone);
}

/** Местные дата и время в поясе и смещение пояса в миллисекундах. */
export function localClock(now, timeZone = SENDING.window.timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    minutes: +parts.hour * 60 + +parts.minute,
    offset: asUtc - Math.floor(now / 1000) * 1000,
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/** Момент «сегодня + dayShift, hh:mm по поясу». Смещение пересчитывается на сам момент — переход на летнее время не сдвигает окно. */
function atLocal(clock, dayShift, minutes, timeZone) {
  const guess = Date.UTC(clock.year, clock.month - 1, clock.day + dayShift, 0, minutes) - clock.offset;
  const offset = localClock(guess, timeZone).offset;
  return Date.UTC(clock.year, clock.month - 1, clock.day + dayShift, 0, minutes) - offset;
}

/**
 * @param {{window_from?: string, window_to?: string}} sender
 * @returns {{open: boolean, opensAt: number|null, closesAt: number|null}}
 */
export function windowState(sender, now = Date.now(), timeZone = SENDING.window.timeZone) {
  const from = toMinutes(sender.window_from || SENDING.window.from);
  const to = toMinutes(sender.window_to || SENDING.window.to);
  const clock = localClock(now, timeZone);
  if (clock.minutes >= from && clock.minutes < to) {
    return { open: true, opensAt: null, closesAt: atLocal(clock, 0, to, timeZone) };
  }
  const opensAt = atLocal(clock, clock.minutes < from ? 0 : 1, from, timeZone);
  return { open: false, opensAt, closesAt: atLocal(clock, clock.minutes < from ? 0 : 1, to, timeZone) };
}

/** Случайная пауза до следующего письма ящика, мс. */
export function nextGap(random = Math.random) {
  const [min, max] = SENDING.gapSeconds;
  return Math.round((min + (max - min) * random()) * 1000);
}

/**
 * Когда примерно уйдёт последнее письмо. Грубо и честно: средняя пауза, потолок
 * на сутки, окно; скользящие сутки считаем календарными окнами.
 *
 * @param {{sender: object, remaining: number, ahead?: number, capLeft: number, cap: number, now?: number}} opts
 * @returns {{finishAt: number, days: number}|null}
 */
export function forecast({ sender, remaining, ahead = 0, capLeft, cap, now = Date.now() }) {
  let queue = remaining + ahead;
  if (queue <= 0 || cap <= 0) return null;
  const perLetter = ((SENDING.gapSeconds[0] + SENDING.gapSeconds[1]) / 2 + 1) * 1000;
  let t = now;
  let left = Math.max(0, capLeft);
  let days = 0;
  for (let guard = 0; guard < 400; guard++) {
    const state = windowState(sender, t);
    if (!state.open) {
      // Новое окно — новый день: письма вчерашнего окна к утру выходят из суток.
      t = state.opensAt;
      left = cap;
      days++;
      continue;
    }
    if (left <= 0) {
      t = state.closesAt;
      continue;
    }
    const fits = Math.max(0, Math.floor((state.closesAt - t) / perLetter));
    const n = Math.min(queue, left, fits);
    if (queue <= n) return { finishAt: t + queue * perLetter, days };
    queue -= n;
    left -= n;
    t = n === fits ? state.closesAt : t + n * perLetter;
  }
  return null;
}
