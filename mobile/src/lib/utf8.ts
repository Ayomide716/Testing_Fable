/**
 * UTF-8 conversion that does not rely on TextEncoder / TextDecoder.
 *
 * Hermes provides neither, and React Native polyfills neither — the only
 * definitions anywhere in the dependency tree are inside Expo's own Jest
 * setup files. Node has them, so a test suite will happily pass while the
 * app crashes on launch. Everything here is hand-rolled for that reason.
 *
 * Decoding matches the WHATWG algorithm, and was checked against Node's
 * TextDecoder over every two-byte sequence, with one deliberate difference:
 * a leading byte-order mark is preserved rather than stripped. Python's
 * bytes.decode("utf-8") keeps it too, and the desktop agent is the other end
 * of this wire — a round trip has to return exactly what was encrypted.
 */

/** Encode a JS string to UTF-8 bytes. Lone surrogates become U+FFFD. */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd; // unpaired high surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd; // unpaired low surrogate
    }

    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }

  return Uint8Array.from(out);
}

/** Decode UTF-8 bytes to a string. Malformed sequences become U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i];
    let code: number;
    let size: number;

    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }

    // 0xc0 and 0xc1 can only ever introduce an overlong form, and 0xf5+ is
    // beyond U+10FFFF, so both are invalid start bytes outright.
    if (b0 < 0xc2 || b0 > 0xf4) {
      out += '\ufffd';
      i += 1;
      continue;
    }

    if (b0 < 0xe0) {
      code = b0 & 0x1f;
      size = 2;
    } else if (b0 < 0xf0) {
      code = b0 & 0x0f;
      size = 3;
    } else {
      code = b0 & 0x07;
      size = 4;
    }

    // The legal range of the *second* byte narrows for four lead bytes; this
    // is what rejects overlong forms and encoded surrogates at the right
    // position, so a bad byte is reprocessed rather than swallowed.
    let lower = 0x80;
    let upper = 0xbf;
    if (b0 === 0xe0) lower = 0xa0;
    else if (b0 === 0xed) upper = 0x9f;
    else if (b0 === 0xf0) lower = 0x90;
    else if (b0 === 0xf4) upper = 0x8f;

    let consumed = 1;
    let valid = true;
    for (let k = 1; k < size; k += 1) {
      const b = bytes[i + k];
      const min = k === 1 ? lower : 0x80;
      const max = k === 1 ? upper : 0xbf;
      if (b === undefined || b < min || b > max) {
        valid = false;
        break;
      }
      code = (code << 6) | (b & 0x3f);
      consumed += 1;
    }

    if (!valid) {
      // One replacement for the bad sequence, then resume at the byte that
      // broke it — it may itself start a valid character.
      out += '\ufffd';
      i += consumed;
      continue;
    }

    if (code > 0xffff) {
      const v = code - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }

    i += consumed;
  }

  return out;
}
