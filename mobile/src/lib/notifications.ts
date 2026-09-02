/**
 * Local notifications for inbound clipboard events.
 *
 * Why local and not push: the plaintext must never leave the device pair, so
 * the server has nothing to put in a push body. The app receives ciphertext
 * over the realtime socket and raises the notification itself — the body is a
 * fixed string, never the copied text, so nothing sensitive lands on a lock
 * screen or in the notification shade.
 *
 * Platform reality this is designed around:
 *  - Android 10+ blocks clipboard *reads* from background apps and, from
 *    Android 12, shows a toast on writes. Writing on an explicit user tap is
 *    both permitted and unsurprising, which is exactly the flow below.
 *  - iOS grants no background clipboard access at all; `UIPasteboard` writes
 *    are only reliable while the app is foreground. Again: the tap does it.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const CLIPBOARD_CHANNEL = 'clipboard-sync';
export const CLIPBOARD_CATEGORY = 'clipsync.incoming';

export type ClipNotificationData = {
  kind: 'clipboard-event';
  eventId: string;
  roomId: string;
  /** Ciphertext, carried so the tap handler can decrypt with no round trip. */
  payload: string;
  senderDevice: string;
};

/**
 * Foreground presentation. A banner still appears while the app is open so the
 * user sees that a copy landed, but it never renders the copied text.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Ask for permission and register the Android channel. Safe to call twice. */
export async function configureNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CLIPBOARD_CHANNEL, {
      name: 'Clipboard sync',
      description: 'Alerts when another device copies something.',
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      vibrationPattern: [0, 120],
      lightColor: '#22D3EE',
      showBadge: false,
    });
  }

  await Notifications.setNotificationCategoryAsync(CLIPBOARD_CATEGORY, [
    { identifier: 'copy', buttonTitle: 'Copy', options: { opensAppToForeground: true } },
  ]);

  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;

  const asked = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: false, allowBadge: false },
  });
  return asked.granted;
}

/** Raise the "tap to copy" notification for one inbound ciphertext row. */
export async function notifyIncomingClip(
  data: ClipNotificationData,
): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    content: {
      title: `Clipboard from ${data.senderDevice}`,
      body: 'New copied text received. Tap to copy.',
      data,
      categoryIdentifier: CLIPBOARD_CATEGORY,
      // `false`, not `null`: expo types this as string | boolean, and a
      // clipboard arriving should be quiet anyway.
      sound: false,
      ...(Platform.OS === 'android' ? { channelId: CLIPBOARD_CHANNEL } : {}),
    },
    trigger: null, // deliver immediately
  });
}

export async function dismissAllClipNotifications(): Promise<void> {
  await Notifications.dismissAllNotificationsAsync();
}

/** Narrowing helper for the untyped `data` bag on a notification. */
export function asClipNotificationData(
  value: unknown,
): ClipNotificationData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<ClipNotificationData>;
  if (
    data.kind !== 'clipboard-event' ||
    typeof data.eventId !== 'string' ||
    typeof data.roomId !== 'string' ||
    typeof data.payload !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'clipboard-event',
    eventId: data.eventId,
    roomId: data.roomId,
    payload: data.payload,
    senderDevice: data.senderDevice ?? 'another device',
  };
}
