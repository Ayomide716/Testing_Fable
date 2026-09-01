/**
 * The paired dashboard: connected devices along the top, the live clipboard
 * feed below, and a single primary action — push what is on this phone's
 * clipboard to everything else.
 */

import * as Haptics from 'expo-haptics';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Aurora } from '../components/Aurora';
import { ClipCard } from '../components/ClipCard';
import { DeviceTile } from '../components/DeviceTile';
import { GlassCard } from '../components/GlassCard';
import { StatusPill } from '../components/StatusPill';
import { useClipSync, type ClipItem } from '../state/ClipSyncProvider';

export function DashboardScreen() {
  const {
    pairing,
    status,
    statusDetail,
    devices,
    items,
    notificationsGranted,
    copyToClipboard,
    sendCurrentClipboard,
    refresh,
    unpair,
  } = useClipSync();

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onCopy = useCallback(
    async (item: ClipItem) => {
      if (!(await copyToClipboard(item))) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCopiedId(item.id);
      setTimeout(() => setCopiedId((id) => (id === item.id ? null : id)), 1600);
    },
    [copyToClipboard],
  );

  const onSend = useCallback(async () => {
    setSending(true);
    try {
      const sent = await sendCurrentClipboard();
      void Haptics.notificationAsync(
        sent
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      if (!sent) {
        Alert.alert('Nothing to send', 'This phone’s clipboard is empty.');
      }
    } catch (error) {
      Alert.alert('Could not send', error instanceof Error ? error.message : 'Unknown error.');
    } finally {
      setSending(false);
    }
  }, [sendCurrentClipboard]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const confirmUnpair = useCallback(() => {
    Alert.alert(
      'Unpair this phone?',
      'The room key will be deleted from this device. Existing items become unreadable here.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpair', style: 'destructive', onPress: () => void unpair() },
      ],
    );
  }, [unpair]);

  return (
    <View className="flex-1 bg-[#05060B]">
      <Aurora />
      <SafeAreaView className="flex-1">
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerClassName="px-6 pb-40"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#22D3EE"
            />
          }
          ListHeaderComponent={
            <View>
              <View className="mt-4 flex-row items-start justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-[11px] uppercase tracking-[0.3em] text-cyan-300">
                    ClipSync
                  </Text>
                  <Text className="mt-1 text-3xl font-semibold tracking-tight text-white">
                    Your clipboard, everywhere
                  </Text>
                </View>
                <StatusPill status={status} />
              </View>

              {statusDetail && (
                <Text className="mt-2 text-xs text-amber-200/80">{statusDetail}</Text>
              )}

              {!notificationsGranted && (
                <GlassCard glow="amber" className="mt-5 p-4">
                  <Text className="text-sm font-medium text-amber-200">
                    Notifications are off
                  </Text>
                  <Text className="mt-1 text-xs leading-5 text-slate-400">
                    Without them, text copied on your computer waits in the app
                    instead of alerting you. Enable ClipSync notifications in
                    system settings.
                  </Text>
                </GlassCard>
              )}

              <Text className="mb-3 mt-8 text-[11px] uppercase tracking-widest text-slate-500">
                Devices · {devices.length}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-3 pr-6"
                className="-mx-6 px-6"
              >
                {devices.map((device) => (
                  <DeviceTile
                    key={device.user_id}
                    device={device}
                    isSelf={device.device_name === pairing?.deviceName}
                  />
                ))}
              </ScrollView>

              <View className="mb-3 mt-8 flex-row items-baseline justify-between">
                <Text className="text-[11px] uppercase tracking-widest text-slate-500">
                  Recent
                </Text>
                <Pressable onPress={confirmUnpair} hitSlop={8}>
                  <Text className="text-[11px] tracking-wide text-slate-500 active:text-rose-300">
                    Unpair
                  </Text>
                </Pressable>
              </View>
            </View>
          }
          renderItem={({ item }) => (
            <View className="mb-3">
              <ClipCard item={item} onCopy={onCopy} justCopied={copiedId === item.id} />
            </View>
          )}
          ListEmptyComponent={
            <GlassCard className="items-center p-8">
              <Text className="text-center text-base text-slate-300">
                Nothing synced yet
              </Text>
              <Text className="mt-2 text-center text-xs leading-5 text-slate-500">
                Copy something on your computer. It arrives here as ciphertext and
                is decrypted on this device.
              </Text>
            </GlassCard>
          }
        />

        {/* Primary action, floating over the feed. */}
        <View className="absolute bottom-8 left-6 right-6">
          <Pressable
            onPress={onSend}
            disabled={sending || status !== 'live'}
            className={`items-center rounded-full py-4 active:opacity-80 ${
              status === 'live' ? 'bg-cyan-400' : 'bg-slate-700'
            }`}
            style={
              status === 'live'
                ? {
                    shadowColor: '#22D3EE',
                    shadowOpacity: 0.5,
                    shadowRadius: 22,
                    shadowOffset: { width: 0, height: 6 },
                    elevation: 10,
                  }
                : undefined
            }
          >
            {sending ? (
              <ActivityIndicator color="#05060B" />
            ) : (
              <Text
                className={`text-base font-semibold ${
                  status === 'live' ? 'text-[#05060B]' : 'text-slate-400'
                }`}
              >
                Send my clipboard
              </Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}
