/**
 * Parsing and validation for the QR produced by `python -m clipsync pair`.
 *
 * A QR is untrusted input from a camera: every field is checked before any of
 * it is used to build a network client or written to the Keychain.
 */

import { decodeKey } from './crypto';

export const PAIRING_VERSION = 1;

export type PairingPayload = {
  version: number;
  roomId: string;
  keyB64: string;
  joinCode: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  deviceName: string;
};

export class InvalidPairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPairingError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePairingPayload(raw: string): PairingPayload {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new InvalidPairingError('That does not look like a ClipSync code.');
  }

  const version = Number(data.v);
  if (version !== PAIRING_VERSION) {
    throw new InvalidPairingError(
      `This code is version ${data.v ?? '?'}; the app speaks version ${PAIRING_VERSION}. Update both sides.`,
    );
  }

  const roomId = str(data.room, 'room');
  if (!UUID_RE.test(roomId)) {
    throw new InvalidPairingError('The room id in this code is malformed.');
  }

  const keyB64 = str(data.key, 'key');
  try {
    decodeKey(keyB64); // enforces exactly 32 bytes
  } catch {
    throw new InvalidPairingError('The encryption key in this code is malformed.');
  }

  const joinCode = str(data.code, 'code');
  if (joinCode.length < 16) {
    throw new InvalidPairingError('The pairing code in this QR is too short.');
  }

  const supabaseUrl = str(data.url, 'url');
  // https only: the anon key and the join code travel over this connection.
  if (!/^https:\/\/[^\s/]+/.test(supabaseUrl)) {
    throw new InvalidPairingError('The server address in this code is not a https URL.');
  }

  return {
    version,
    roomId,
    keyB64,
    joinCode,
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    supabaseAnonKey: str(data.anon, 'anon'),
    deviceName: typeof data.name === 'string' && data.name ? data.name : 'Desktop',
  };
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidPairingError(`This code is missing its "${field}" field.`);
  }
  return value;
}
