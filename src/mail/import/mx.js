/**
 * Принимает ли домен почту.
 *
 * Проверка идёт по уникальным доменам, а не по адресам: у базы на 10 000 строк
 * их обычно одна-две тысячи, и половина — gmail.com и ukr.net, которые мы не
 * спрашиваем вовсе. Ответы кэшируются на сутки: повторная загрузка той же базы
 * после смены кодировки не должна ждать DNS заново.
 *
 * Сбой DNS — не приговор адресу. «Не знаем» и «почты нет» — разные ответы, и
 * наказывать базу за медленный резолвер нельзя.
 */

import { Resolver } from 'node:dns/promises';
import { MX_CHECK, POPULAR_DOMAINS } from '../specs.js';

const cache = new Map(); // domain → { state, at }

/** @typedef {'ok'|'none'|'unknown'} DomainState */

function makeResolver() {
  return new Resolver({ timeout: MX_CHECK.timeoutMs, tries: 2 });
}

/**
 * @param {string} domain
 * @param {{resolveMx: Function, resolve4: Function, resolve6: Function}} resolver
 * @returns {Promise<DomainState>}
 */
export async function checkDomain(domain, resolver = makeResolver()) {
  try {
    const records = await resolver.resolveMx(domain);
    // «Нулевой MX» (RFC 7505): домен прямо заявляет, что почту не принимает.
    if (records.length === 1 && (records[0].exchange === '' || records[0].exchange === '.')) return 'none';
    if (records.length) return 'ok';
  } catch (err) {
    if (err.code === 'ENOTFOUND') return 'none'; // домена нет вовсе
    if (err.code !== 'ENODATA') return 'unknown';
  }
  // MX нет, но почту по стандарту принимает и сам адрес домена.
  for (const method of ['resolve4', 'resolve6']) {
    try {
      if ((await resolver[method](domain)).length) return 'ok';
    } catch (err) {
      if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') return 'unknown';
    }
  }
  return 'none';
}

/**
 * @param {string[]} domains
 * @param {{resolver?: object, onProgress?: (done: number, total: number) => void, now?: number}} opts
 * @returns {Promise<Map<string, DomainState>>}
 */
export async function checkDomains(domains, { resolver = null, onProgress = () => {}, now = Date.now() } = {}) {
  const result = new Map();
  const todo = [];
  for (const domain of new Set(domains)) {
    if (POPULAR_DOMAINS.includes(domain)) {
      result.set(domain, 'ok');
      continue;
    }
    const hit = cache.get(domain);
    if (hit && now - hit.at < MX_CHECK.cacheHours * 3600000) result.set(domain, hit.state);
    else todo.push(domain);
  }

  const total = todo.length;
  let done = 0;
  const shared = resolver || makeResolver();
  let next = 0;
  const workers = Array.from({ length: Math.min(MX_CHECK.concurrency, total) }, async () => {
    while (next < todo.length) {
      const domain = todo[next++];
      const state = await checkDomain(domain, shared);
      result.set(domain, state);
      // «Не знаем» не кэшируем: следующая попытка может ответить.
      if (state !== 'unknown') cache.set(domain, { state, at: now });
      onProgress(++done, total);
    }
  });
  await Promise.all(workers);
  return result;
}

/** Для тестов: кэш живёт в процессе и иначе протекает между проверками. */
export function clearDomainCache() {
  cache.clear();
}
