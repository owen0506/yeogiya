import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createAlarmManager } from './alarm-manager';
import * as adapter from './alarm-platform';

const manager = createAlarmManager(adapter);

export function useAlarm() {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  useEffect(() => {
    void manager.initialize();
    const timer = setInterval(manager.tick, 1000);
    const subscription = AppState.addEventListener('change', () => manager.tick());
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);
  return { ...state, start: manager.start, cancel: manager.cancel };
}
