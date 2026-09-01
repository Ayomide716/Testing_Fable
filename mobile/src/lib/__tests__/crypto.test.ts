/**
 * The mirror of `desktop/tests/test_crypto.py`. Both suites decrypt the same
 * vectors in `tests/vectors.json`, which is what keeps the two implementations
 * from silently drifting apart.
 */

import vectors from '../../../../tests/vectors.json';
import {
  CryptoError,
  decodeKey,
  decrypt,
  encrypt,
  fingerprint,
  fromBase64,
  generateKey,
  toBase64,
  MAX_PLAINTEXT_BYTES,
} from '../crypto';

const ROOM = vectors.room_id;
const OTHER_ROOM = '00000000-0000-0000-0000-000000000000';

describe('cross-language vectors', () => {
  const key = decodeKey(vectors.key_b64);

  it.each(vectors.cases.map((c) => [c.name, c.plaintext, c.payload]))(
    'decrypts the Python payload for %s',
    (_name, plaintext, payload) => {
      expect(decrypt(key, payload as string, ROOM)).toBe(plaintext);
    },
  );

  it('derives the same key fingerprint as Python', () => {
    expect(fingerprint(key)).toBe(vectors.fingerprint);
  });
});

describe('round trip', () => {
  const key = generateKey();

  it.each(['', 'plain', 'café — naïve 🚀 клавиатура', 'a'.repeat(10_000)])(
    'preserves %#',
    (text) => {
      expect(decrypt(key, encrypt(key, text, ROOM), ROOM)).toBe(text);
    },
  );

  it('never reuses a nonce', () => {
    expect(encrypt(key, 'same', ROOM)).not.toBe(encrypt(key, 'same', ROOM));
  });

  it('rejects a payload from another room', () => {
    const payload = encrypt(key, 'secret', ROOM);
    expect(() => decrypt(key, payload, OTHER_ROOM)).toThrow(CryptoError);
  });

  it('rejects the wrong key', () => {
    const payload = encrypt(key, 'secret', ROOM);
    expect(() => decrypt(generateKey(), payload, ROOM)).toThrow(CryptoError);
  });

  it('detects a flipped bit in the auth tag', () => {
    const wire = fromBase64(encrypt(key, 'secret', ROOM));
    wire[wire.length - 1] ^= 0x01;
    expect(() => decrypt(key, toBase64(wire), ROOM)).toThrow(CryptoError);
  });

  it('rejects a truncated payload', () => {
    expect(() => decrypt(key, toBase64(new Uint8Array(8)), ROOM)).toThrow(CryptoError);
  });

  it('refuses oversized plaintext', () => {
    expect(() => encrypt(key, 'x'.repeat(MAX_PLAINTEXT_BYTES + 1), ROOM)).toThrow(
      CryptoError,
    );
  });
});

describe('base64 helpers', () => {
  it('round-trips every byte value at every alignment', () => {
    for (let length = 0; length < 8; length += 1) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 251) % 256);
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('rejects non-base64 input', () => {
    expect(() => fromBase64('not base64!!')).toThrow(CryptoError);
  });
});
