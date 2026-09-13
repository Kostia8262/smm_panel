/**
 * vCard (.vcf) — выгрузка Google Контактов и контактов телефона.
 *
 * Android пишет старый vCard 2.1, где кириллица лежит в quoted-printable:
 * `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=86=D1=80=D0=B8=D0=BD=D0=B0`.
 * Без разбора этой записи имя приходит набором «=D0=86», а адрес при этом цел —
 * ошибка всплыла бы только в письме.
 */

export function looksLikeVcard(text) {
  return /^\s*BEGIN:VCARD/im.test(text.slice(0, 4096));
}

function decodeQuotedPrintable(value, charset = 'utf-8') {
  const joined = value.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9a-f]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(ch));
    }
  }
  try {
    return new TextDecoder(charset.toLowerCase()).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
}

function unescapeValue(value) {
  return value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

/**
 * @param {string} text
 * @returns {{header: string[], rows: string[][]}} по строке на каждый адрес карточки
 */
export function parseVcard(text) {
  // Продолжение строки в vCard 3.0+ начинается с пробела или табуляции, в 2.1
  // quoted-printable переносится знаком «=» в конце строки.
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else if (lines.length && /ENCODING=QUOTED-PRINTABLE/i.test(lines[lines.length - 1]) && lines[lines.length - 1].endsWith('=')) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + raw;
    } else lines.push(raw);
  }

  const rows = [];
  let card = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD/i.test(line)) {
      card = { fn: '', n: '', emails: [], org: '' };
      continue;
    }
    if (/^END:VCARD/i.test(line)) {
      if (card) {
        const name = card.fn || card.n;
        for (const email of card.emails) rows.push([name, email, card.org]);
      }
      card = null;
      continue;
    }
    if (!card) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);
    const [prop, ...params] = head.split(';');
    const key = prop.replace(/^item\d+\./i, '').toUpperCase();
    if (params.some((p) => /ENCODING=QUOTED-PRINTABLE/i.test(p))) {
      const charset = params.find((p) => /^CHARSET=/i.test(p))?.split('=')[1] || 'utf-8';
      value = decodeQuotedPrintable(value, charset);
    }
    value = unescapeValue(value).trim();

    if (key === 'FN') card.fn = value;
    else if (key === 'N') {
      const [last = '', first = '', middle = ''] = value.split(';');
      card.n = [first, middle, last].filter(Boolean).join(' ').trim();
    } else if (key === 'EMAIL' && value) card.emails.push(value);
    else if (key === 'ORG') card.org = value.replace(/;/g, ' ').trim();
  }

  return { header: ['Имя', 'Email', 'Организация'], rows };
}
