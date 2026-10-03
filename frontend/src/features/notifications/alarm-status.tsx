import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { palette, ui } from '../journey/journey-ui';
import { useAlarm } from './use-alarm';

export function AlarmStatus() {
  const state = useAlarm();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state.status !== 'active') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.status]);
  if (!state.alarm && !state.error) return null;
  const remaining = Math.max(0, Math.ceil(((state.alarm?.deadline ?? now) - now) / 1000));
  return (
    <View style={{ padding: 22, gap: 14, backgroundColor: state.status === 'fired' ? '#FFF3D8' : '#E5F3E9', borderRadius: 18, borderWidth: 1, borderColor: state.status === 'fired' ? '#E7CF97' : '#C6E0CD' }}>
      {state.alarm && <>
        <Text accessibilityLiveRegion="assertive" style={{ color: '#172D40', fontWeight: '700', fontSize: 17 }}>
          {state.status === 'fired' ? '여기야! 내릴 준비를 해주세요' : '하차 알림이 켜져 있어요'}
        </Text>
        <View style={ui.spread}><Text style={{ color: palette.green, fontSize: 26, fontWeight: '800' }}>{state.alarm.destination}</Text>{state.status === 'active' && <Text accessibilityLabel={`알림까지 ${remaining}초`} style={{ color: palette.green, fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{Math.floor(remaining / 60).toString().padStart(2, '0')}:{(remaining % 60).toString().padStart(2, '0')}</Text>}</View>
        {state.alarm.context && <Text style={ui.muted}>{state.alarm.context.mode === 'SUBWAY' ? '선택한 열차' : '선택한 버스'} {state.alarm.context.vehicleId} · 이 구간 하차 알림</Text>}
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
