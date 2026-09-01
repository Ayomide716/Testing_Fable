/**
 * One paired device. Online is defined as a heartbeat inside the last 90s —
 * the agents beat every 30s, so two missed beats is a real absence, not a
 * blip on a train.
 */

import React from 'react';
import { Text, View } from 'react-native';

import type { DeviceRow } from '../lib/supabase';
import { GlassCard } from './GlassCard';
import { relativeTime } from '../lib/time';

const ONLINE_WINDOW_MS = 90_000;

const GLYPH: Record<DeviceRow['platform'], string> = {
  desktop: '▣',
  ios: '❖',
  android: '❖',
  web: '◈',
  unknown: '○',
};

export function DeviceTile({ device, isSelf }: { device: DeviceRow; isSelf: boolean }) {
  const lastSeen = new Date(device.last_seen_at).getTime();
  const online = Number.isFinite(lastSeen) && Date.now() - lastSeen < ONLINE_WINDOW_MS;

  return (
    <GlassCard glow={online ? 'cyan' : 'none'} className="w-44 p-4" intensity={20}>
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl text-cyan-300">{GLYPH[device.platform] ?? '○'}</Text>
        <View
          className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-slate-600'}`}
        />
      </View>

      <Text numberOfLines={1} className="mt-3 text-sm font-semibold text-white">
        {device.device_name}
      </Text>
      <Text className="mt-0.5 text-[11px] uppercase tracking-widest text-slate-500">
        {device.platform}
        {isSelf ? ' · this device' : ''}
      </Text>
      <Text className={`mt-2 text-xs ${online ? 'text-emerald-300' : 'text-slate-500'}`}>
        {online ? 'Online' : `Seen ${relativeTime(device.last_seen_at)}`}
      </Text>
    </GlassCard>
  );
}
