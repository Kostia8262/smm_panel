/**
 * Возвраты писем (docs/рассылка.md, фаза 6).
 *
 * Несуществующий, но правильно записанный адрес Google принимает без ошибки,
 * а через минуту в ящик рассылки приходит «Адрес не найден». Читать ящик
 * панель не может — у неё только право отправлять, и расширять его ради
 * возвратов не стоит. Поэтому владелец вставляет текст таких писем, панель
 * находит в нём адреса своих контактов и предлагает отметить «адреса нет».
 *
 * Без подтверждения ничего не меняется: в тексте возврата бывают и чужие
 * адреса (служебные, ящик самой рассылки), а отметка кладёт адрес в стоп-лист.
 */

import { db } from '../db.js';
import { MailError, bulk } from './store.js';
import { emailsIn } from './import/text.js';
import { normalize } from './import/address.js';

const SERVICE = /^(mailer-daemon|postmaster|no-?reply|noreply)@/i;
const MAX_TEXT = 500 * 1024;

/**
 * @returns {{found: object[], notInBase: string[], service: number}}
 */
export function previewBounces(projectId, text) {
  const raw = String(text || '');
  if (!raw.trim()) throw new MailError('Вставьте текст писем о недоставке');
  if (raw.length > MAX_TEXT) throw new MailError('Текст больше 500 КБ — вставьте возвраты частями');

  const senderEmails = new Set(db.prepare('SELECT email FROM mail_senders').all().map((r) => r.email.toLowerCase()));
  const emails = [...new Set(emailsIn(raw).map(normalize))];
  let service = 0;
  const candidates = [];
  for (const email of emails) {
    if (SERVICE.test(email) || senderEmails.has(email)) {
      service++;
      continue;
    }
    candidates.push(email);
  }

  const found = [];
  const notInBase = [];
  const byEmail = db.prepare('SELECT id, email, name, status FROM mail_contacts WHERE project_id = ? AND email = ?');
  const lastLetter = db.prepare(
    `SELECT s.sent_at, c.title FROM mail_sends s JOIN mail_campaigns c ON c.id = s.campaign_id
      WHERE s.contact_id = ? AND s.status IN ('sent', 'unknown') ORDER BY s.sent_at DESC LIMIT 1`
  );
  for (const email of candidates) {
    const contact = byEmail.get(Number(projectId), email);
    if (!contact) {
      notInBase.push(email);
      continue;
    }
    const letter = lastLetter.get(contact.id);
    found.push({
      contactId: contact.id,
      email: contact.email,
      name: contact.name,
      status: contact.status,
      lastLetter: letter ? { title: letter.title, sentAt: letter.sent_at } : null,
    });
  }
  // Сначала те, кому письма уходили: возврат почти наверняка про них.
  found.sort((a, b) => Number(Boolean(b.lastLetter)) - Number(Boolean(a.lastLetter)));
  return { found, notInBase: notInBase.slice(0, 50), service };
}

/** Отметить выбранных «адреса нет» — в стоп-лист школы, очередь рассылок их пропустит. */
export function applyBounces(projectId, ids) {
  return bulk({ projectId, ids, action: 'bounced', note: 'возврат письма: адрес не найден' });
}
