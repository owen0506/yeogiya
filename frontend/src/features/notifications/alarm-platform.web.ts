import type { Alarm } from './alarm-types';

let timer: ReturnType<typeof setTimeout> | undefined;
let notification: Notification | undefined;
const storageKey = 'subway-alarm-active';

export async function requestAlarmPermission() {
  // 화면 내 알림은 권한 없이 시작합니다. 브라우저 알림 권한은 별도 버튼에서
  // 요청하여 권한 창에 응답하지 않아도 예약이 무기한 멈추지 않게 합니다.
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
