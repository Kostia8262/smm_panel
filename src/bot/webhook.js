/**
 * Вебхук Meta: `/webhooks/meta` (docs/бот.md, §2 и §5a).
 *
 *   GET  — проверка адреса при подключении: `hub.verify_token` сверяется с
 *          Verify Token из настроек бота (любого проекта), в ответ — `hub.challenge`.
 *   POST — события. Подпись `X-Hub-Signature-256` = HMAC-SHA256 от СЫРОГО тела
 *          секретом приложения; сравнение за постоянное время. Без подписи
 *          или с чужой — 401 и ничего не записано.
 *
 * Маршрут ставится ДО общего `express.json()`: разобранное и снова собранное
 * тело уже не совпадёт с подписанным байт в байт. И до входа в панель: Meta
 * не знает наших сессий.
 *
 * Ответ быстрый: разбор — только запись в SQLite, отправку делает воркер
 * через `replyDelaySec` секунд. Ничего личного в журнал не пишется.
 */

import express from 'express';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { db, log } from '../db.js';
import { ingest, appSecrets } from './dialogs.js';

function same(a, b) {
  const x = createHash('sha256').update(String(a ?? '')).digest();
  const y = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(x, y);
}

/** Подпись тела одним из секретов приложения. */
export function signatureValid(raw, header, secrets = appSecrets()) {
  const h = String(header || '');
  if (!h.startsWith('sha256=') || !Buffer.isBuffer(raw)) return false;
  const got = Buffer.from(h.slice(7), 'hex');
  if (got.length !== 32) return false;
  let ok = false;
  for (const secret of secrets) {
    const want = createHmac('sha256', secret).update(raw).digest();
    // Перебираем все секреты без раннего выхода — время не зависит от того, какой подошёл.
    if (timingSafeEqual(want, got)) ok = true;
  }
  return ok;
}

export function verifyTokenValid(token) {
  if (!token) return false;
  const rows = db.prepare('SELECT verify_token FROM bot_settings WHERE verify_token IS NOT NULL').all();
  let ok = false;
  for (const r of rows) if (same(r.verify_token, token)) ok = true;
  return ok;
}

export function mountMetaWebhook(app) {
  app.get('/webhooks/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && verifyTokenValid(token) && challenge) {
      log('info', 'бот: Meta подтвердила адрес вебхука');
      return res.status(200).type('text/plain').send(String(challenge));
    }
    res.sendStatus(403);
  });

  const raw = express.raw({ type: '*/*', limit: '1mb' });
  // Слишком большое тело — 413, а не общий 500 (проверка 17.11).
  const readRaw = (req, res, next) =>
    raw(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.too.large') return res.sendStatus(413);
      return res.sendStatus(400);
    });

  app.post('/webhooks/meta', readRaw, (req, res) => {
    const secrets = appSecrets();
    if (!secrets.length) {
      log('warn', 'бот: вебхук без секрета приложения — событие отклонено (впишите секрет в карточку Facebook)');
      return res.sendStatus(503);
    }
    if (!signatureValid(req.body, req.get('x-hub-signature-256'), secrets)) {
      log('warn', 'бот: вебхук с неверной подписью отклонён');
      return res.sendStatus(401);
    }
    let body;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    try {
      ingest(body);
    } catch (err) {
      // 200 всё равно: повтор доставки упрётся в ту же ошибку, а дубли по mid
      // отсекаются. Ошибку видно в журнале.
      log('error', `бот: событие вебхука не разобралось: ${err.message}`);
    }
    res.sendStatus(200);
  });
}
