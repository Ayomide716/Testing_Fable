/**
 * Secure persistence of the room key.
 *
 * The AES-256 key lives in `expo-secure-store`, which is the iOS Keychain
 * (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — readable by background
 * work after the first unlock, never migrated to a new device or an iCloud
 * backup) and the Android Keystore-backed `EncryptedSharedPreferences`.
 *
 * Non-secret room metadata goes to AsyncStorage so it can be read cheaply on
 * every launch without touching the Keychain.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { CryptoError, decodeKey, fingerprint } from './crypto';

const KEY_ITEM = 'clipsync.roomKey';
const ROOM_ITEM = 'clipsync.room';

/** Non-secret half of a pairing: safe to keep in plain AsyncStorage. */
export type RoomRecord = {
  roomId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  deviceName: string;
  pairedAt: string;
  keyFingerprint: string;
};

export type Pairing = RoomRecord & { key: Uint8Array };

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  requireAuthentication: false, // the notification tap must work without a prompt
};

/** Persist a pairing. The key goes to the Keychain, metadata to AsyncStorage. */
export async function savePairing(record: RoomRecord, keyB64: string): Promise<Pairing> {
  const key = decodeKey(keyB64); // throws before we persist anything malformed
  const stamped: RoomRecord = { ...record, keyFingerprint: fingerprint(key) };

  await SecureStore.setItemAsync(KEY_ITEM, keyB64, SECURE_OPTIONS);
  await AsyncStorage.setItem(ROOM_ITEM, JSON.stringify(stamped));
  return { ...stamped, key };
}

/** Load the active pairing, or `null` when this device is not paired. */
export async function loadPairing(): Promise<Pairing | null> {
  const [keyB64, raw] = await Promise.all([
    SecureStore.getItemAsync(KEY_ITEM, SECURE_OPTIONS),
    AsyncStorage.getItem(ROOM_ITEM),
  ]);
  if (!keyB64 || !raw) return null;

  let record: RoomRecord;
  try {
    record = JSON.parse(raw) as RoomRecord;
  } catch {
    return null;
  }

  try {
    return { ...record, key: decodeKey(keyB64) };
  } catch (error) {
    if (error instanceof CryptoError) {
      // A corrupt keychain item is unrecoverable; force a clean re-pair.
      await clearPairing();
      return null;
    }
    throw error;
  }
}

/** Forget the room entirely. After this the device can decrypt nothing. */
export async function clearPairing(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_ITEM, SECURE_OPTIONS),
    AsyncStorage.removeItem(ROOM_ITEM),
  ]);
}

export async function isPaired(): Promise<boolean> {
  return (await SecureStore.getItemAsync(KEY_ITEM, SECURE_OPTIONS)) !== null;
}

/** Refresh-token storage for the Supabase session (also a secret). */
const SESSION_ITEM = 'clipsync.session';

export async function saveRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_ITEM, token, SECURE_OPTIONS);
}

export async function loadRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_ITEM, SECURE_OPTIONS);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_ITEM, SECURE_OPTIONS);
}
