import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import './global.css';
import { Aurora } from './src/components/Aurora';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { PairScreen } from './src/screens/PairScreen';
import { ClipSyncProvider, useClipSync } from './src/state/ClipSyncProvider';

function Root() {
  const { ready, pairing } = useClipSync();

  // Hold the splash-like state until the Keychain lookup resolves; flashing
  // the pairing screen at an already-paired user would be a lie.
  if (!ready) {
    return (
      <View className="flex-1 items-center justify-center bg-[#05060B]">
        <Aurora />
        <ActivityIndicator color="#22D3EE" />
      </View>
    );
  }
  return pairing ? <DashboardScreen /> : <PairScreen />;
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ClipSyncProvider>
          <StatusBar style="light" />
          <Root />
        </ClipSyncProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
