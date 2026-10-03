import type { Alarm, AlarmContext, AlarmState } from './alarm-types';

type Adapter = {
  requestAlarmPermission: () => Promise<void>;
  scheduleAlarm: (alarm: Alarm) => Promise<void>;
  cancelAlarm: () => Promise<void>;
  restoreAlarm: () => Promise<Alarm | null>;
};

export function createAlarmManager(adapter: Adapter, now = Date.now) {
  let state: AlarmState = { status: 'idle', alarm: null, busy: false, error: null };
  let initialized: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AlarmState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const initialize = () => initialized ??= (async () => {
    update({ busy: true });
    try {
      const alarm = await adapter.restoreAlarm();
      if (alarm) update({ alarm, status: alarm.deadline <= now() ? 'fired' : 'active' });
    } catch { update({ error: '기존 알림을 확인하지 못했습니다. 다시 시작하면 기존 예약을 교체합니다.' }); }
    finally { update({ busy: false }); }
  })();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize,
    tick: () => {
      if (state.status === 'active' && state.alarm && state.alarm.deadline <= now()) update({ status: 'fired' });
    },
    start: async (destination: string, seconds: number, demo: boolean, context?: AlarmContext) => {
      await initialize();
      if (state.busy || state.status === 'active') return;
      if (!destination.trim() || !Number.isFinite(seconds) || seconds < 1 || seconds > 86400) {
        update({ error: '알림 시간 또는 도착역이 올바르지 않습니다.' });
        return;
      }
      update({ busy: true, error: null });
      try {
        await adapter.requestAlarmPermission();
        await adapter.cancelAlarm();
        update({ status: 'idle', alarm: null });
        const alarm: Alarm = { destination, deadline: now() + seconds * 1000, demo, ...(context ? { context } : {}) };
        await adapter.scheduleAlarm(alarm);
        update({ status: 'active', alarm });
      } catch (error) { update({ error: error instanceof Error ? error.message : '알림을 예약하지 못했습니다.' }); }
      finally { update({ busy: false }); }
    },
    cancel: async () => {
      await initialize();
      if (state.busy) return;
      update({ busy: true, error: null });
      try {
        await adapter.cancelAlarm();
        update({ status: 'idle', alarm: null });
      } catch { update({ error: '알림 취소에 실패했습니다. 다시 시도해주세요.' }); }
      finally { update({ busy: false }); }
    },
  };
}
