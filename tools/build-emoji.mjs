#!/usr/bin/env node
/**
 * Сборка набора эмодзи для пикера в композере.
 *
 * Панель живёт под строгим CSP без внешних источников, поэтому набор лежит
 * у нас файлом, а не тянется с CDN. Источник — emojibase-data: в нём есть
 * русские и украинские названия с тегами, по ним и ищем. Сам пакет весит
 * 50 МБ, в зависимости его не тащим — файл собирается разово и коммитится.
 *
 *   npm pack emojibase-data@17.0.0 && tar xzf emojibase-data-17.0.0.tgz
 *   node tools/build-emoji.mjs ./package
 *
 * Что попадает в файл:
 *   — группы в порядке Юникода, без «компонентов» (голые модификаторы тона)
 *     и без одиночных региональных букв — вставлять их отдельно незачем;
 *   — для каждого знака: [знак, русское название, прочие слова для поиска
 *     (теги ru, названия и теги uk и en), версия Эмодзи, тона?]. По версии
 *     браузер прячет знаки, которых его система не умеет рисовать;
 *   — пять вариантов тона кожи, если они одинаковы для всей фигуры.
 *     Пары с разными тонами (25 сочетаний) не берём: выбор тона один на пикер.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] || resolve(here, '../node_modules/emojibase-data'));
const out = resolve(here, '../public/js/emoji-data.json');

const load = (p) => JSON.parse(readFileSync(resolve(src, p), 'utf8'));
const ru = load('ru/data.json');
const uk = new Map(load('uk/data.json').map((e) => [e.hexcode, e]));
const en = new Map(load('en/data.json').map((e) => [e.hexcode, e]));
const { version } = load('package.json');

// Свои короткие названия групп: у emojibase они местами машинные («тело людей»)
const TITLES = {
  'smileys-emotion': 'Смайлы',
  'people-body': 'Люди',
  'animals-nature': 'Природа',
  'food-drink': 'Еда',
  'travel-places': 'Места',
  activities: 'Досуг',
  objects: 'Предметы',
  symbols: 'Символы',
  flags: 'Флаги',
};
const KEYS = load('meta/groups.json').groups; // { "0": "smileys-emotion", … }

const words = (e) => [e?.label, ...(e?.tags || [])].filter(Boolean);

const groups = new Map();
for (const e of ru.sort((a, b) => a.order - b.order)) {
  const key = KEYS[e.group];
  if (!TITLES[key]) continue;
  // Название отдельно — оно идёт в подсказку; остальные слова только для поиска
  const rest = [...new Set([...words(e).slice(1), ...words(uk.get(e.hexcode)), ...words(en.get(e.hexcode))])]
    .join(' ')
    .toLowerCase();
  const tones = (e.skins || []).filter((s) => typeof s.tone === 'number').sort((a, b) => a.tone - b.tone);
  const item = [e.emoji, e.label, rest, e.version];
  if (tones.length === 5) item.push(tones.map((s) => s.emoji));
  if (!groups.has(key)) groups.set(key, { key, title: TITLES[key], items: [] });
  groups.get(key).items.push(item);
}

const data = { source: `emojibase-data ${version}`, groups: [...groups.values()] };
writeFileSync(out, JSON.stringify(data));
const count = data.groups.reduce((n, g) => n + g.items.length, 0);
console.log(`${count} эмодзи в ${data.groups.length} группах → ${out}`);
