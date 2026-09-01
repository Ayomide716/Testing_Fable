/**
 * Ambient backdrop: two slow neon blooms behind the glass.
 *
 * Kept to two large, low-opacity radial-ish gradients — enough to give the
 * frosted panes something to refract, cheap enough to leave running. The
 * animation is `useNativeDriver`, so it never touches the JS thread.
 */

import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

export function Aurora() {
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: 14000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 14000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [drift]);

  const up = drift.interpolate({ inputRange: [0, 1], outputRange: [0, -40] });
  const down = drift.interpolate({ inputRange: [0, 1], outputRange: [0, 32] });

  return (
    <View pointerEvents="none" className="absolute inset-0 bg-[#05060B]">
      <Animated.View
        style={{ transform: [{ translateY: up }] }}
        className="absolute -left-24 -top-24 h-96 w-96 rounded-full opacity-60"
      >
        <LinearGradient
          colors={['rgba(34,211,238,0.55)', 'rgba(34,211,238,0)']}
          style={{ flex: 1, borderRadius: 999 }}
        />
      </Animated.View>
      <Animated.View
        style={{ transform: [{ translateY: down }] }}
        className="absolute -right-28 top-52 h-[28rem] w-[28rem] rounded-full opacity-50"
      >
        <LinearGradient
          colors={['rgba(167,139,250,0.55)', 'rgba(167,139,250,0)']}
          style={{ flex: 1, borderRadius: 999 }}
        />
      </Animated.View>
      {/* Vignette so content at the bottom keeps its contrast. */}
      <LinearGradient
        colors={['rgba(5,6,11,0)', 'rgba(5,6,11,0.9)']}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 260 }}
      />
    </View>
  );
}
