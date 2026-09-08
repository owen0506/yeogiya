import { Platform, Pressable, Text, View } from 'react-native';
import { useAlarm } from './use-alarm';

export function AlarmStatus() {
  const state = useAlarm();
  if (!state.alarm && !state.error) return null;
  return (
    <View style={{ padding: 18, gap: 12, backgroundColor: '#E8F4EF', borderRadius: 16 }}>
      {state.alarm && <>
        <Text accessibilityLiveRegion="assertive" style={{ color: '#172D40', fontWeight: '700', fontSize: 17 }}>
          {state.status === 'fired' ? '하차를 준비해주세요!' : '알림 예약 중'} · {state.alarm.destination}
        </Text>
        <Text style={{ color: '#566B7C', lineHeight: 22 }}>
          {state.alarm.demo ? '10초 체험' : '예상 이동 시간 기준'} · 알림 예정 {new Date(state.alarm.deadline).toLocaleTimeString('ko-KR')}
          {state.status === 'fired' ? '\n예상 알림 시각이 되었습니다. 실제 역을 확인해주세요.' : ''}
        </Text>
        {Platform.OS === 'web' && <Text style={{ color: '#566B7C' }}>웹 알림은 탭이 열려 있을 때 체험할 수 있습니다. 절전 상태에서는 지연될 수 있어요.</Text>}
        <Pressable accessibilityRole="button" disabled={state.busy} onPress={() => void state.cancel()} style={{ padding: 14, backgroundColor: '#FFFFFF', borderRadius: 10 }}>
          <Text style={{ color: '#116B55', textAlign: 'center' }}>{state.busy ? '처리 중…' : state.status === 'fired' ? '알림 확인 · 종료' : '알림 취소'}</Text>
        </Pressable>
      </>}
      {state.error && <Text accessibilityRole="alert" style={{ color: '#A12C2C' }}>{state.error}</Text>}
    </View>
  );
}
