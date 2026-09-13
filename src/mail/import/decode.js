/**
 * Байты файла → текст.
 *
 * Базы школ живут в Excel, а Excel пишет CSV в кодировке системы: у русской и
 * украинской локали это windows-1251. Открой такой файл как UTF-8 — вместо
 * имён кракозябры, а адреса при этом целы, и ошибку замечают уже в письме
 * «Здравствуйте, Ð˜Ñ€Ð¸Ð½Ð°». Поэтому кодировка угадывается, показывается в
 * предпросмотре и переключается руками.
 */

export const ENCODINGS = {
  'utf-8': 'UTF-8',
  'windows-1251': 'Windows-1251 (кириллица Excel)',
  'utf-16le': 'UTF-16 («Юникод-текст» Excel)',
};

/**
 * @param {Uint8Array} bytes
 * @param {string} [forced] — кодировка, выбранная человеком в предпросмотре
 * @returns {{text: string, encoding: string}}
 */
export function decodeBytes(bytes, forced = '') {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (forced && ENCODINGS[forced]) {
    return { text: stripBom(new TextDecoder(forced).decode(buf)), encoding: forced };
  }

  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }

  // UTF-16LE без метки: у латиницы и цифр каждый второй байт нулевой.
  if (looksUtf16le(buf)) {
    return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    // Строгий UTF-8 не прошёл — значит однобайтовая кодировка. Для баз наших
    // школ это почти всегда windows-1251; ошибиться здесь не страшно — человек
    // увидит имена в предпросмотре и переключит.
    return { text: new TextDecoder('windows-1251').decode(buf), encoding: 'windows-1251' };
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function looksUtf16le(buf) {
  const sample = Math.min(buf.length, 2000);
  if (sample < 8) return false;
  let zeroOdd = 0;
  let zeroEven = 0;
  for (let i = 0; i < sample; i++) {
    if (buf[i] !== 0) continue;
    if (i % 2) zeroOdd++;
    else zeroEven++;
  }
  return zeroOdd > sample * 0.3 && zeroEven < sample * 0.05;
}
