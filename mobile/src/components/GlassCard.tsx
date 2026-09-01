/**
 * The design system's base surface: a frosted pane over the dark backdrop.
 *
 * Real glassmorphism needs an actual backdrop blur, which RN cannot do with
 * styles alone — `expo-blur` renders the platform blur view (UIVisualEffectView
 * on iOS, a RenderEffect-backed view on Android). The gradient and the 1px
 * top highlight are what sell it as a physical pane rather than a grey box.
 */

import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { View, ViewProps } from 'react-native';

export type GlassCardProps = ViewProps & {
  /** Neon edge treatment. `none` keeps the pane quiet. */
  glow?: 'none' | 'cyan' | 'violet' | 'amber';
  intensity?: number;
  className?: string;
  children?: React.ReactNode;
};

const GLOW_RING: Record<NonNullable<GlassCardProps['glow']>, string> = {
  none: 'border-white/10',
  cyan: 'border-cyan-400/40',
  violet: 'border-violet-400/40',
  amber: 'border-amber-300/40',
};

const GLOW_SHADOW: Record<NonNullable<GlassCardProps['glow']>, string> = {
  none: 'transparent',
  cyan: '#22D3EE',
  violet: '#A78BFA',
  amber: '#FCD34D',
};

export function GlassCard({
  glow = 'none',
  intensity = 24,
  className = '',
  children,
  style,
  ...rest
}: GlassCardProps) {
  return (
    <View
      className={`overflow-hidden rounded-3xl border ${GLOW_RING[glow]} ${className}`}
      style={[
        glow !== 'none' && {
          shadowColor: GLOW_SHADOW[glow],
          shadowOpacity: 0.35,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 0 },
          elevation: 8,
        },
        style,
      ]}
      {...rest}
    >
      <BlurView intensity={intensity} tint="dark" className="absolute inset-0" />
      {/* Sheen: brighter at the top edge, as light would fall on real glass. */}
      <LinearGradient
        colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.02)', 'rgba(0,0,0,0.18)']}
        locations={[0, 0.45, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View className="absolute left-6 right-6 top-0 h-px bg-white/25" />
      {children}
    </View>
  );
}
