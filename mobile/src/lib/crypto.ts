/**
 * AES-256-GCM sealing for clipboard payloads — the TypeScript twin of
 * `desktop/clipsync/crypto.py`. Both sides speak the same wire format:
 *
 *     base64( nonce[12] || ciphertext || tag[16] )
 *
 * The room id is the additional authenticated data, binding a ciphertext to
 * one room: a payload moved between rooms fails its tag check.
 *
 * Implementation notes
 *  - `@noble/ciphers` is an audited, dependency-free JS implementation. React
 *    Native has no WebCrypto `subtle`, and `expo-crypto` exposes hashing and
 *    randomness only, so a pure-JS AEAD is the correct primitive here.
 *  - Randomness comes from `expo-crypto`'s `getRandomBytes`, which is backed by
 *    the platform CSPRNG (SecRandomCopyBytes / java.security.SecureRandom).
 *    `Math.random` is never used for anything cryptographic.
 */

import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { getRandomBytes } from 'expo-crypto';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const MAX_PLAINTEXT_BYTES = 128 * 1024;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Generate a fresh AES-256 key from the platform CSPRNG. */
export function generateKey(): Uint8Array {
  return getRandomBytes(KEY_BYTES);
}

export function encodeKey(key: Uint8Array): string {
  assertKey(key);
  return toBase64(key);
}

export function decodeKey(encoded: string): Uint8Array {
  const key = fromBase64(encoded);
  assertKey(key);
  return key;
}

/** Seal `plaintext` for `roomId`, returning the base64 wire payload. */
export function encrypt(key: Uint8Array, plaintext: string, roomId: string): string {
  assertKey(key);
  const data = textEncoder.encode(plaintext);
  if (data.length > MAX_PLAINTEXT_BYTES) {
    throw new CryptoError(
      `payload of ${data.length} bytes exceeds the ${MAX_PLAINTEXT_BYTES} byte limit`,
    );
  }

  const nonce = getRandomBytes(NONCE_BYTES);
  const sealed = gcm(key, nonce, aad(roomId)).encrypt(data);

  const wire = new Uint8Array(nonce.length + sealed.length);
  wire.set(nonce, 0);
  wire.set(sealed, nonce.length);
  return toBase64(wire);
}

/** Open a payload produced by `encrypt` or by the Python agent. */
export function decrypt(key: Uint8Array, payload: string, roomId: string): string {
  assertKey(key);

  let wire: Uint8Array;
  try {
    wire = fromBase64(payload);
  } catch {
    throw new CryptoError('payload is not valid base64');
  }
  if (wire.length < NONCE_BYTES + TAG_BYTES) {
    throw new CryptoError('payload is too short to contain a nonce and tag');
  }

  const nonce = wire.subarray(0, NONCE_BYTES);
  const sealed = wire.subarray(NONCE_BYTES);

  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, nonce, aad(roomId)).decrypt(sealed);
  } catch {
    throw new CryptoError(
      'authentication failed: wrong room key, wrong room, or tampered payload',
    );
  }
  return textDecoder.decode(plaintext);
}

/**
 * Short, non-reversible key identifier shown during pairing so the user can
 * confirm both screens hold the same key. Mirrors `crypto.fingerprint` in
 * Python byte for byte.
 */
export function fingerprint(key: Uint8Array): string {
  assertKey(key);
  const label = textEncoder.encode('clipsync-key-fingerprint-v1');
  const input = new Uint8Array(label.length + key.length);
  input.set(label, 0);
  input.set(key, label.length);

  const digest = sha256(input).subarray(0, 5);
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  // Same big-endian integer reduction the Python side performs.
  let value = 0n;
  for (const byte of digest) {
    value = (value << 8n) | BigInt(byte);
  }
  const base = BigInt(alphabet.length);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out = alphabet[Number(value % base)] + out;
    value /= base;
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// --- base64 -----------------------------------------------------------------
// Hermes ships `global.btoa`/`atob` only in newer versions, so encode by hand
// to keep behaviour identical on every RN runtime.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 0x3f];
  }
  return out;
}

export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/[\r\n\s]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new CryptoError('payload is not valid base64');
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((clean.length / 4) * 3 - padding);

  let offset = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const chunk =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((B64.indexOf(clean[i + 2]) & 0x3f) << 6) |
      (B64.indexOf(clean[i + 3]) & 0x3f);
    if (offset < bytes.length) bytes[offset++] = (chunk >> 16) & 0xff;
    if (offset < bytes.length) bytes[offset++] = (chunk >> 8) & 0xff;
    if (offset < bytes.length) bytes[offset++] = chunk & 0xff;
  }
  return bytes;
}

function aad(roomId: string): Uint8Array {
  if (!roomId) {
    throw new CryptoError('roomId is required as additional authenticated data');
  }
  return textEncoder.encode(roomId);
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new CryptoError(`AES-256 key must be exactly ${KEY_BYTES} bytes`);
  }
}
