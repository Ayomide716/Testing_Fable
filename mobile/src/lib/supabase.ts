/**
 * Supabase client for the mobile app.
 *
 * The project URL and anon key arrive in the pairing QR rather than being
 * baked in, so one build can pair against any project. The client is created
 * once per room and cached; switching rooms tears the old one down so its
 * realtime socket does not linger.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient, Session } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

import type { RoomRecord } from './secureStore';

let cached: { url: string; client: SupabaseClient } | null = null;

export function getClient(url: string, anonKey: string): SupabaseClient {
  if (cached && cached.url === url) return cached.client;

  if (cached) {
    void cached.client.removeAllChannels();
  }
  const client = createClient(url, anonKey, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // No deep-link auth callbacks: identities here are anonymous.
      detectSessionInUrl: false,
    },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  cached = { url, client };
  return client;
}

export async function resetClient(): Promise<void> {
  if (!cached) return;
  await cached.client.removeAllChannels();
  await cached.client.auth.signOut();
  cached = null;
}

/**
 * Ensure there is a signed-in identity. Anonymous sign-in gives the device a
 * stable `auth.uid()` — the subject every RLS policy is written against —
 * without asking the user for an account.
 */
export async function ensureSession(client: SupabaseClient): Promise<Session> {
  const { data } = await client.auth.getSession();
  if (data.session) return data.session;

  const { data: created, error } = await client.auth.signInAnonymously();
  if (error || !created.session) {
    throw new Error(
      error?.message ??
        'anonymous sign-in failed; enable it under Authentication → Providers',
    );
  }
  return created.session;
}

/** Redeem the single-use pairing code from the QR. */
export async function joinRoom(
  client: SupabaseClient,
  roomId: string,
  joinCode: string,
  deviceName: string,
  platform: 'ios' | 'android' | 'web',
): Promise<void> {
  const { error } = await client.rpc('join_room', {
    p_room_id: roomId,
    p_join_code: joinCode,
    p_device_name: deviceName,
    p_platform: platform,
  });
  if (error) {
    throw new Error(
      error.message.includes('invalid or expired')
        ? 'That pairing code has expired. Generate a fresh QR on your computer.'
        : error.message,
    );
  }
}

export type ClipboardRow = {
  id: string;
  room_id: string;
  sender_id: string;
  sender_device: string;
  payload: string;
  content_kind: 'text' | 'url' | 'image';
  payload_bytes: number;
  created_at: string;
};

export type DeviceRow = {
  user_id: string;
  device_name: string;
  platform: 'desktop' | 'ios' | 'android' | 'web' | 'unknown';
  last_seen_at: string;
  joined_at: string;
};

export async function fetchRecentEvents(
  client: SupabaseClient,
  roomId: string,
  limit = 25,
): Promise<ClipboardRow[]> {
  const { data, error } = await client
    .from('clipboard_events')
    .select('id,room_id,sender_id,sender_device,payload,content_kind,payload_bytes,created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as ClipboardRow[];
}

export async function fetchEvent(
  client: SupabaseClient,
  eventId: string,
): Promise<ClipboardRow | null> {
  const { data, error } = await client
    .from('clipboard_events')
    .select('id,room_id,sender_id,sender_device,payload,content_kind,payload_bytes,created_at')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ClipboardRow) ?? null;
}

export async function fetchDevices(
  client: SupabaseClient,
  roomId: string,
): Promise<DeviceRow[]> {
  const { data, error } = await client
    .from('room_members')
    .select('user_id,device_name,platform,last_seen_at,joined_at')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as DeviceRow[];
}

export async function publishEvent(
  client: SupabaseClient,
  room: RoomRecord,
  payload: string,
  contentKind: 'text' | 'url' = 'text',
): Promise<void> {
  const { error } = await client.from('clipboard_events').insert({
    room_id: room.roomId,
    payload,
    sender_device: room.deviceName,
    content_kind: contentKind,
    payload_bytes: payload.length,
  });
  if (error) throw new Error(error.message);
}

/** Heartbeat so the dashboard can show this phone as online. */
export async function touchMembership(
  client: SupabaseClient,
  roomId: string,
): Promise<void> {
  await client.rpc('touch_membership', { p_room_id: roomId });
}
