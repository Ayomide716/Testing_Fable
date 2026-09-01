/**
 * Phase 1, phone side: scan the desktop's QR and take custody of the room key.
 *
 * The scanner is deliberately single-shot — `locked` is set the instant a code
 * is read, because `onBarcodeScanned` fires on every camera frame and a room
 * join is not idempotent from the user's point of view.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Aurora } from '../components/Aurora';
import { GlassCard } from '../components/GlassCard';
import { decodeKey, fingerprint } from '../lib/crypto';
import {
  InvalidPairingError,
  parsePairingPayload,
  type PairingPayload,
} from '../lib/pairingPayload';
import { useClipSync } from '../state/ClipSyncProvider';

type Stage = 'scanning' | 'confirming' | 'joining';

export function PairScreen() {
  const { pair } = useClipSync();
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<Stage>('scanning');
  const [payload, setPayload] = useState<PairingPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);

  const onScan = useCallback(({ data }: { data: string }) => {
    if (locked.current) return;
    locked.current = true;

    try {
      const parsed = parsePairingPayload(data);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPayload(parsed);
      setError(null);
      setStage('confirming');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setError(
        err instanceof InvalidPairingError ? err.message : 'That code could not be read.',
      );
      // Let the user try again after a beat rather than re-firing every frame.
      setTimeout(() => {
        locked.current = false;
      }, 1200);
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!payload) return;
    setStage('joining');
    setError(null);
    try {
      await pair(payload);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed.');
      setStage('confirming');
    }
  }, [payload, pair]);

  const rescan = useCallback(() => {
    setPayload(null);
    setError(null);
    setStage('scanning');
    locked.current = false;
  }, []);

  return (
    <View className="flex-1 bg-[#05060B]">
      <Aurora />
      <SafeAreaView className="flex-1 px-6">
        <View className="mt-6">
          <Text className="text-3xl font-semibold tracking-tight text-white">
            Pair this phone
          </Text>
          <Text className="mt-2 text-[15px] leading-6 text-slate-400">
            Run{' '}
            <Text className="font-mono text-cyan-300">python -m clipsync pair</Text> on
            your computer and point the camera at the code.
          </Text>
        </View>

        {stage === 'scanning' ? (
          <ScannerPane
            granted={permission?.granted ?? false}
            canAsk={permission?.canAskAgain ?? true}
            onRequest={requestPermission}
            onScan={onScan}
            error={error}
          />
        ) : (
          <ConfirmPane
            payload={payload!}
            busy={stage === 'joining'}
            error={error}
            onConfirm={confirm}
            onRescan={rescan}
          />
        )}

        <GlassCard className="mb-6 mt-auto p-4">
          <Text className="text-xs leading-5 text-slate-400">
            The key in this code is generated on your computer and travels only
            through the camera. It is stored in the device keychain and is never
            uploaded — the server sees ciphertext and nothing else.
          </Text>
        </GlassCard>
      </SafeAreaView>
    </View>
  );
}

function ScannerPane({
  granted,
  canAsk,
  onRequest,
  onScan,
  error,
}: {
  granted: boolean;
  canAsk: boolean;
  onRequest: () => void;
  onScan: (result: { data: string }) => void;
  error: string | null;
}) {
  return (
    <View className="mt-8 items-center">
      <GlassCard glow="cyan" className="h-72 w-72 items-center justify-center p-1.5">
        {granted ? (
          <View className="h-full w-full overflow-hidden rounded-[20px]">
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScan}
            />
            <Corner className="left-3 top-3 border-l-2 border-t-2" />
            <Corner className="right-3 top-3 border-r-2 border-t-2" />
            <Corner className="bottom-3 left-3 border-b-2 border-l-2" />
            <Corner className="bottom-3 right-3 border-b-2 border-r-2" />
          </View>
        ) : (
          <View className="items-center px-8">
            <Text className="text-center text-base text-slate-300">
              {canAsk
                ? 'ClipSync needs the camera to read the pairing code.'
                : 'Camera access is off. Enable it in Settings to pair.'}
            </Text>
            {canAsk && (
              <Pressable
                onPress={onRequest}
                className="mt-5 rounded-full bg-cyan-400 px-6 py-3 active:opacity-80"
              >
                <Text className="font-semibold text-[#05060B]">Allow camera</Text>
              </Pressable>
            )}
          </View>
        )}
      </GlassCard>

      {error && (
        <Text className="mt-4 text-center text-sm text-rose-300">{error}</Text>
      )}
    </View>
  );
}

function Corner({ className }: { className: string }) {
  return (
    <View
      pointerEvents="none"
      className={`absolute h-7 w-7 rounded-md border-cyan-300/80 ${className}`}
    />
  );
}

function ConfirmPane({
  payload,
  busy,
  error,
  onConfirm,
  onRescan,
}: {
  payload: PairingPayload;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onRescan: () => void;
}) {
  // Shown so the user can compare it against the checksum printed by the CLI:
  // matching checksums prove both devices hold the same key.
  const checksum = fingerprint(decodeKey(payload.keyB64));

  return (
    <GlassCard glow="violet" className="mt-8 p-6">
      <Text className="text-[11px] uppercase tracking-widest text-violet-300">
        Confirm the key
      </Text>
      <Text className="mt-3 text-lg font-semibold text-white">{payload.deviceName}</Text>

      <View className="mt-5 rounded-2xl border border-white/10 bg-black/30 p-4">
        <Text className="text-[11px] uppercase tracking-widest text-slate-500">
          Key checksum
        </Text>
        <Text className="mt-1 font-mono text-2xl tracking-[0.2em] text-cyan-300">
          {checksum}
        </Text>
      </View>

      <Text className="mt-4 text-xs leading-5 text-slate-400">
        This must match the checksum printed on your computer. If it does not,
        do not continue — something else produced that code.
      </Text>

      {error && <Text className="mt-4 text-sm text-rose-300">{error}</Text>}

      <View className="mt-6 flex-row gap-3">
        <Pressable
          onPress={onRescan}
          disabled={busy}
          className="flex-1 items-center rounded-full border border-white/15 px-5 py-3.5 active:opacity-70"
        >
          <Text className="font-medium text-slate-300">Scan again</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={busy}
          className="flex-1 items-center rounded-full bg-cyan-400 px-5 py-3.5 active:opacity-80"
        >
          {busy ? (
            <ActivityIndicator color="#05060B" />
          ) : (
            <Text className="font-semibold text-[#05060B]">Pair device</Text>
          )}
        </Pressable>
      </View>
    </GlassCard>
  );
}
