/**
 * Реестр адаптеров. Все площадки говорят на одном языке:
 *   isConfigured() · missingConfig() · check() · publish({text, media, formatId, publicUrl})
 *
 * Такой единый вид нужен воркеру: он не знает про особенности площадок,
 * а просто вызывает publish и складывает результат.
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

/** Что настроено, а чего не хватает — это же показывает интерфейс. */
export function connectionStatus() {
  return Object.values(PLATFORMS).map((spec) => {
    const adapter = ADAPTERS[spec.id];
    const configured = adapter ? adapter.isConfigured() : false;
    return {
      id: spec.id,
      title: spec.title,
      accent: spec.accent,
      configured,
      missing: configured ? [] : adapter?.missingConfig?.() || [],
      notes: spec.notes,
    };
  });
}
