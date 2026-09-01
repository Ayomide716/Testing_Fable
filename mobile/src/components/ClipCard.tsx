/**
 * A clipboard event in the feed. Undecryptable rows are shown rather than
 * hidden: silently dropping them would mask a key mismatch.
 */

import React from 'react';
import { Pressable, Text, View } from 'react-native';

import type { ClipItem } from '../state/ClipSyncProvider';
import { GlassCard } from './GlassCard';
import { relativeTime } from '../lib/time';

export function ClipCard({
  item,
  onCopy,
  justCopied,
}: {
  item: ClipItem;
  onCopy: (item: ClipItem) => void;
  justCopied: boolean;
}) {
  const broken = item.text === null;

  return (
    <Pressable
      onPress={() => !broken && onCopy(item)}
      disabled={broken}
      accessibilityRole="button"
      accessibilityLabel={
        broken ? 'Undecryptable clipboard item' : `Copy text from ${item.senderDevice}`
      }
      className="active:opacity-80"
    >
      <GlassCard
        glow={justCopied ? 'cyan' : broken ? 'amber' : 'none'}
        className="p-4"
        intensity={18}
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-[11px] uppercase tracking-widest text-slate-400">
            {item.mine ? 'This device' : item.senderDevice}
          </Text>
          <Text className="text-[11px] text-slate-500">
            {relativeTime(item.createdAt)}
          </Text>
        </View>

        {broken ? (
          <Text className="mt-2 text-sm text-amber-200/90">
            Could not decrypt — this device holds a different room key.
          </Text>
        ) : (
          <Text numberOfLines={3} className="mt-2 text-[15px] leading-5 text-slate-100">
            {item.text}
          </Text>
        )}

        <View className="mt-3 flex-row items-center justify-between">
          <Text className="text-[11px] text-slate-500">
            {broken ? 'Re-pair to read it' : 'Tap to copy'}
          </Text>
          {justCopied && (
            <Text className="text-[11px] font-semibold tracking-wide text-cyan-300">
              COPIED
            </Text>
          )}
        </View>
      </GlassCard>
    </Pressable>
  );
}
