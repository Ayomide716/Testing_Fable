import { useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

/** Current app state plus a ref, so callbacks can read it without re-binding. */
export function useAppState() {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  const ref = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      ref.current = next;
      setState(next);
    });
    return () => subscription.remove();
  }, []);

  return { appState: state, appStateRef: ref, isForeground: state === 'active' };
}
