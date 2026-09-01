/**
 * The app's single source of truth: pairing, session, realtime and clipboard.
 *
 * Sync flow on the phone
 *   1. A realtime INSERT on `clipboard_events` arrives (RLS already guarantees
 *      it belongs to this room).
 *   2. Foreground → decrypt and surface it in the feed immediately.
 *      Background → raise a local notification carrying the *ciphertext*.
 *   3. The user taps the notification. The app comes to the foreground, the
 *      payload is decrypted with the Keychain key, and `expo-clipboard` writes
 *      the plaintext. The write happens on an explicit user action, which is
 *      what both Android and iOS permit.
 */

import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt, CryptoError } from '../lib/crypto';
import {
  asClipNotificationData,
  configureNotifications,
  notifyIncomingClip,
} from '../lib/notifications';
import type { PairingPayload } from '../lib/pairingPayload';
import {
  clearPairing,
  loadPairing,
  savePairing,
  type Pairing,
  type RoomRecord,
} from '../lib/secureStore';
import {
  ensureSession,
  fetchDevices,
  fetchEvent,
  fetchRecentEvents,
  getClient,
  joinRoom,
  publishEvent,
  resetClient,
  touchMembership,
  type ClipboardRow,
  type DeviceRow,
} from '../lib/supabase';
import { useAppState } from '../hooks/useAppState';

const HEARTBEAT_MS = 30_000;
const FEED_LIMIT = 25;

export type ClipItem = {
  id: string;
  text: string | null; // null when the payload could not be decrypted
  error?: string;
  senderDevice: string;
  createdAt: string;
  mine: boolean;
};

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'offline' | 'error';

type ClipSyncValue = {
  ready: boolean;
  pairing: Pairing | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  devices: DeviceRow[];
  items: ClipItem[];
  notificationsGranted: boolean;
  pair: (payload: PairingPayload) => Promise<void>;
  unpair: () => Promise<void>;
  copyToClipboard: (item: ClipItem) => Promise<boolean>;
  sendCurrentClipboard: () => Promise<boolean>;
  refresh: () => Promise<void>;
};

const ClipSyncContext = createContext<ClipSyncValue | null>(null);

export function useClipSync(): ClipSyncValue {
  const value = useContext(ClipSyncContext);
  if (!value) throw new Error('useClipSync must be used inside <ClipSyncProvider>');
  return value;
}

export function ClipSyncProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [items, setItems] = useState<ClipItem[]>([]);
  const [notificationsGranted, setNotificationsGranted] = useState(false);

  const { appStateRef, isForeground } = useAppState();
  const clientRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const pairingRef = useRef<Pairing | null>(null);
  const handledRef = useRef<Set<string>>(new Set());

  pairingRef.current = pairing;

  // --- boot ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [restored, granted] = await Promise.all([
        loadPairing(),
        configureNotifications(),
      ]);
      if (cancelled) return;
      setPairing(restored);
      setNotificationsGranted(granted);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- decrypt helper -----------------------------------------------------

  const toItem = useCallback(
    (row: ClipboardRow, userId: string | undefined): ClipItem => {
      const active = pairingRef.current;
      const base = {
        id: row.id,
        senderDevice: row.sender_device,
        createdAt: row.created_at,
        mine: !!userId && row.sender_id === userId,
      };
      if (!active) return { ...base, text: null, error: 'Not paired.' };
      try {
        return { ...base, text: decrypt(active.key, row.payload, active.roomId) };
      } catch (error) {
        return {
          ...base,
          text: null,
          error: error instanceof CryptoError ? error.message : 'Could not decrypt.',
        };
      }
    },
    [],
  );

  const mergeItem = useCallback((item: ClipItem) => {
    setItems((current) => {
      if (current.some((existing) => existing.id === item.id)) return current;
      return [item, ...current].slice(0, FEED_LIMIT);
    });
  }, []);

  // --- realtime -----------------------------------------------------------

  useEffect(() => {
    if (!pairing) {
      setStatus('idle');
      setDevices([]);
      setItems([]);
      return;
    }

    let disposed = false;
    setStatus('connecting');
    setStatusDetail(null);

    const client = getClient(pairing.supabaseUrl, pairing.supabaseAnonKey);
    clientRef.current = client;

    (async () => {
      try {
        const session = await ensureSession(client);
        if (disposed) return;

        // supabase-js needs the current JWT before opening the socket, or the
        // server evaluates RLS for the anon role and sends nothing.
        client.realtime.setAuth(session.access_token);

        const [recent, roster] = await Promise.all([
          fetchRecentEvents(client, pairing.roomId, FEED_LIMIT),
          fetchDevices(client, pairing.roomId),
        ]);
        if (disposed) return;
        setItems(recent.map((row) => toItem(row, session.user.id)));
        setDevices(roster);

        const channel = client
          .channel(`room:${pairing.roomId}`, { config: { private: false } })
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'clipboard_events',
              filter: `room_id=eq.${pairing.roomId}`,
            },
            (message) => {
              const row = message.new as ClipboardRow;
              if (row.sender_id === session.user.id) return; // our own echo
              void handleIncoming(row, session.user.id);
            },
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'room_members',
              filter: `room_id=eq.${pairing.roomId}`,
            },
            () => {
              void fetchDevices(client, pairing.roomId).then(setDevices).catch(() => {});
            },
          )
          .subscribe((state, error) => {
            if (disposed) return;
            if (state === 'SUBSCRIBED') {
              setStatus('live');
              setStatusDetail(null);
            } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
              setStatus('offline');
              setStatusDetail(error?.message ?? 'Reconnecting…');
            } else if (state === 'CLOSED') {
              setStatus('offline');
            }
          });

        channelRef.current = channel;
      } catch (error) {
        if (disposed) return;
        setStatus('error');
        setStatusDetail(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      disposed = true;
      const channel = channelRef.current;
      channelRef.current = null;
      if (channel) void client.removeChannel(channel);
    };
    // `toItem` and `handleIncoming` read the live pairing through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing?.roomId, pairing?.supabaseUrl]);

  /** Foreground: show it. Background: notify with the ciphertext attached. */
  const handleIncoming = useCallback(
    async (row: ClipboardRow, userId: string) => {
      if (handledRef.current.has(row.id)) return;
      handledRef.current.add(row.id);

      const item = toItem(row, userId);
      mergeItem(item);

      if (appStateRef.current === 'active') return;
      try {
        await notifyIncomingClip({
          kind: 'clipboard-event',
          eventId: row.id,
          roomId: row.room_id,
          payload: row.payload,
          senderDevice: row.sender_device,
        });
      } catch {
        // A missing notification permission must not break the feed.
      }
    },
    [toItem, mergeItem, appStateRef],
  );

  // --- notification taps --------------------------------------------------

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = asClipNotificationData(
          response.notification.request.content.data,
        );
        if (!data) return;
        void applyNotification(data.eventId, data.payload, data.roomId, data.senderDevice);
      },
    );

    // The app may have been launched cold *by* the tap; that response is not
    // delivered to the listener above, so pick it up explicitly.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = asClipNotificationData(response.notification.request.content.data);
      if (!data) return;
      void applyNotification(data.eventId, data.payload, data.roomId, data.senderDevice);
    });

    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const applyNotification = useCallback(
    async (eventId: string, payload: string, roomId: string, senderDevice: string) => {
      // The provider may still be booting when a cold-start tap arrives.
      const active = pairingRef.current ?? (await loadPairing());
      if (!active || active.roomId !== roomId) return;

      let text: string;
      try {
        text = decrypt(active.key, payload, active.roomId);
      } catch {
        // Payload truncated by the OS notification size limit — refetch it.
        const client = getClient(active.supabaseUrl, active.supabaseAnonKey);
        await ensureSession(client);
        const row = await fetchEvent(client, eventId);
        if (!row) return;
        text = decrypt(active.key, row.payload, active.roomId);
      }

      await Clipboard.setStringAsync(text);
      mergeItem({
        id: eventId,
        text,
        senderDevice,
        createdAt: new Date().toISOString(),
        mine: false,
      });
    },
    [mergeItem],
  );

  // --- heartbeat ----------------------------------------------------------

  useEffect(() => {
    if (!pairing || !isForeground) return;
    const client = clientRef.current;
    if (!client) return;

    const beat = () => void touchMembership(client, pairing.roomId).catch(() => {});
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [pairing, isForeground]);

  // --- actions ------------------------------------------------------------

  const pair = useCallback(async (payload: PairingPayload) => {
    setStatus('connecting');
    const client = getClient(payload.supabaseUrl, payload.supabaseAnonKey);
    await ensureSession(client);

    const platform: 'ios' | 'android' | 'web' =
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    const deviceName = Device.deviceName ?? `${Device.modelName ?? 'Phone'}`;

    await joinRoom(client, payload.roomId, payload.joinCode, deviceName, platform);

    const record: RoomRecord = {
      roomId: payload.roomId,
      supabaseUrl: payload.supabaseUrl,
      supabaseAnonKey: payload.supabaseAnonKey,
      deviceName,
      pairedAt: new Date().toISOString(),
      keyFingerprint: '',
    };
    const saved = await savePairing(record, payload.keyB64);
    handledRef.current = new Set();
    setPairing(saved);
  }, []);

  const unpair = useCallback(async () => {
    const channel = channelRef.current;
    channelRef.current = null;
    if (channel && clientRef.current) await clientRef.current.removeChannel(channel);
    await clearPairing();
    await resetClient();
    clientRef.current = null;
    handledRef.current = new Set();
    setPairing(null);
    setItems([]);
    setDevices([]);
    setStatus('idle');
  }, []);

  const copyToClipboard = useCallback(async (item: ClipItem) => {
    if (item.text === null) return false;
    await Clipboard.setStringAsync(item.text);
    return true;
  }, []);

  const sendCurrentClipboard = useCallback(async () => {
    const active = pairingRef.current;
    const client = clientRef.current;
    if (!active || !client) return false;

    const text = await Clipboard.getStringAsync();
    if (!text) return false;

    const payload = encrypt(active.key, text, active.roomId);
    await publishEvent(
      client,
      active,
      payload,
      /^https?:\/\/\S+$/.test(text.trim()) ? 'url' : 'text',
    );
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const active = pairingRef.current;
    const client = clientRef.current;
    if (!active || !client) return;
    const session = await ensureSession(client);
    const [recent, roster] = await Promise.all([
      fetchRecentEvents(client, active.roomId, FEED_LIMIT),
      fetchDevices(client, active.roomId),
    ]);
    setItems(recent.map((row) => toItem(row, session.user.id)));
    setDevices(roster);
  }, [toItem]);

  const value = useMemo<ClipSyncValue>(
    () => ({
      ready,
      pairing,
      status,
      statusDetail,
      devices,
      items,
      notificationsGranted,
      pair,
      unpair,
      copyToClipboard,
      sendCurrentClipboard,
      refresh,
    }),
    [
      ready, pairing, status, statusDetail, devices, items, notificationsGranted,
      pair, unpair, copyToClipboard, sendCurrentClipboard, refresh,
    ],
  );

  return <ClipSyncContext.Provider value={value}>{children}</ClipSyncContext.Provider>;
}
