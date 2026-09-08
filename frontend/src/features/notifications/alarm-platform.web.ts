import type { Alarm } from './alarm-types';

let timer: ReturnType<typeof setTimeout> | undefined;
let notification: Notification | undefined;
const storageKey = 'subway-alarm-active';

export async function requestAlarmPermission() {
  // 브라우저 알림이 차단되어도 화면 내 체험 알림은 제공합니다.
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* 화면 내 알림으로 진행 */ }
  }
}

export async function scheduleAlarm(alarm: Alarm) {
  clearTimeout(timer);
  try { sessionStorage.setItem(storageKey, JSON.stringify(alarm)); } catch { /* 저장 불가 시 현재 탭에서만 동작 */ }
  timer = setTimeout(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { notification = new Notification(alarm.demo ? '하차 알림 체험' : '하차를 준비해주세요', { body: `${alarm.destination} 도착 전 예상 알림입니다. 실제 역을 확인해주세요.`, tag: storageKey }); } catch { /* 화면 내 알림으로 진행 */ }
    }
  }, Math.max(0, alarm.deadline - Date.now()));
}

export async function cancelAlarm() {
  clearTimeout(timer);
  notification?.close();
  try { sessionStorage.removeItem(storageKey); } catch { /* 저장소 접근 불가 */ }
}

export async function restoreAlarm(): Promise<Alarm | null> {
  try {
    const alarm = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (alarm && typeof alarm.destination === 'string' && typeof alarm.deadline === 'number' && Number.isFinite(alarm.deadline) && typeof alarm.demo === 'boolean') {
      if (alarm.deadline > Date.now()) await scheduleAlarm(alarm);
      return alarm;
    }
  } catch { /* SSR 또는 저장소 접근 불가 */ }
  return null;
}
