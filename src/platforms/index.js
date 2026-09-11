/**
 * Реестр адаптеров. Все площадки говорят на одном языке:
 *   isConfigured(creds) · missingConfig(creds) · check(creds)
 *   publish({text, media, formatId, publicUrl, creds})
 *
 * Доступы приходят снаружи, из карточки проекта: у «Дошколярика» свои
 * Instagram и Facebook, у академии свои, и адаптер не должен знать, чьи
 * именно токены ему дали.
 */

import * as telegram from './telegram.js';
import * as threads from './threads.js';
import * as instagram from './instagram.js';
import * as facebook from './facebook.js';
import * as tiktok from './tiktok.js';
import { PLATFORMS } from './specs.js';

export const ADAPTERS = { telegram, threads, instagram, facebook, tiktok };

export function getAdapter(platformId) {
  const adapter = ADAPTERS[platformId];
  if (!adapter) throw new Error(`Нет адаптера для площадки «${platformId}»`);
  return adapter;
}

/**
 * Что настроено у проекта, а чего не хватает.
 * @param {(platform: string) => object} credentialsFor
 */
export function connectionStatus(credentialsFor) {
  return Object.values(PLATFORMS).map((spec) => {
    const adapter = ADAPTERS[spec.id];
    const creds = credentialsFor(spec.id) || {};
    const configured = adapter ? adapter.isConfigured(creds) : false;
    return {
      id: spec.id,
      title: spec.title,
      accent: spec.accent,
      configured,
      missing: configured ? [] : adapter?.missingConfig?.(creds) || [],
      notes: spec.notes,
    };
  });
}
