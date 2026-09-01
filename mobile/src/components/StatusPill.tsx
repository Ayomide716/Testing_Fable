/**
 * Connection state, as a pulsing neon dot in a glass pill.
 *
 * The pulse only runs while the connection is live, so a stalled socket reads
 * as visibly still rather than quietly animating a lie.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View } from 'react-native';

import type { ConnectionStatus } from '../state/ClipSyncProvider';

const PRESENTATION: Record<
  ConnectionStatus,
  { label: string; dot: string; text: string; ring: string }
> = {
  live:       { label: 'Synced',      dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-400/30' },
  connecting: { label: 'Connecting',  dot: 'bg-amber-300',   text: 'text-amber-200',   ring: 'border-amber-300/30' },
  offline:    { label: 'Reconnecting',dot: 'bg-amber-300',   text: 'text-amber-200',   ring: 'border-amber-300/30' },
  error:      { label: 'Error',       dot: 'bg-rose-400',    text: 'text-rose-300',    ring: 'border-rose-400/30' },
  idle:       { label: 'Not paired',  dot: 'bg-slate-500',   text: 'text-slate-400',   ring: 'border-white/10' },
};

export function StatusPill({ status }: { status: ConnectionStatus }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const live = status === 'live';

  useEffect(() => {
    if (!live) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });
  const tone = PRESENTATION[status];

  return (
    <View className={`flex-row items-center gap-2 rounded-full border ${tone.ring} bg-white/5 px-3 py-1.5`}>
      <View className="h-2 w-2 items-center justify-center">
        {live && (
          <Animated.View
            className={`absolute h-2 w-2 rounded-full ${tone.dot}`}
            style={{ transform: [{ scale }], opacity }}
          />
        )}
        <View className={`h-2 w-2 rounded-full ${tone.dot}`} />
      </View>
      <Text className={`text-xs font-medium tracking-wide ${tone.text}`}>{tone.label}</Text>
    </View>
  );
}
