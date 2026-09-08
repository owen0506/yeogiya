import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Alarm } from './alarm-types';

const identifier = 'subway-alarm-active';
const channelId = 'subway-arrival';
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function requestAlarmPermission() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(channelId, {
      name: '하차 알림', importance: Notifications.AndroidImportance.HIGH, sound: 'default',
      vibrationPattern: [0, 500, 250, 500],
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted && permission.ios?.status !== Notifications.IosAuthorizationStatus.PROVISIONAL) {
    throw new Error('알림 권한이 필요합니다. 기기 설정에서 알림을 허용한 뒤 다시 시작해주세요.');
  }
}

export async function scheduleAlarm(alarm: Alarm) {
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: { title: alarm.demo ? '하차 알림 체험' : '하차를 준비해주세요', body: `${alarm.destination} 도착 전 예상 알림입니다. 실제 역을 확인해주세요.`, sound: 'default', data: { ...alarm } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: Math.max(1, Math.ceil((alarm.deadline - Date.now()) / 1000)), channelId },
  });
}

export async function cancelAlarm() {
  await Notifications.cancelScheduledNotificationAsync(identifier);
  await Notifications.dismissNotificationAsync(identifier);
}

export async function restoreAlarm(): Promise<Alarm | null> {
  const pending = await Notifications.getAllScheduledNotificationsAsync();
  const data = pending.find((item) => item.identifier === identifier)?.content.data;
  if (!data || typeof data.destination !== 'string' || typeof data.deadline !== 'number' || !Number.isFinite(data.deadline) || typeof data.demo !== 'boolean') return null;
  return { destination: data.destination, deadline: data.deadline, demo: data.demo };
}
