import { Modal, Text, View } from 'react-native';
import { Action, palette, TrainIcon, ui } from '../journey/journey-ui';
import { useAlarm } from './use-alarm';

export function AlarmDialog() {
  const state = useAlarm();
  return <Modal visible={state.status === 'fired'} transparent animationType="fade" onRequestClose={() => void state.cancel()}>
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#19372ADA' }}>
      <View accessibilityViewIsModal style={{ width: '100%', maxWidth: 400, padding: 30, borderRadius: 28, backgroundColor: '#F7FBF5', alignItems: 'center', gap: 20 }}>
        <View style={{ width: 74, height: 74, borderRadius: 37, backgroundColor: '#E1F0DC', alignItems: 'center', justifyContent: 'center' }}><TrainIcon size={40} /></View>
        <Text style={ui.eyebrow}>{state.alarm?.demo ? '10초 체험 알림' : '하차 준비 알림'}</Text>
        <Text accessibilityRole="header" accessibilityLiveRegion="assertive" style={{ color: palette.green, fontSize: 38, fontWeight: '800', letterSpacing: -2 }}>여기야!</Text>
        <Text style={{ color: palette.ink, fontSize: 23, fontWeight: '700' }}>{state.alarm?.destination}</Text>
        <Text style={[ui.text, { textAlign: 'center' }]}>{state.alarm?.demo ? '이렇게 내릴 준비를 알려드려요.' : '내릴 준비를 시작해주세요.'}</Text>
        <Text style={[ui.muted, { textAlign: 'center' }]}>예상 시간으로 보낸 알림이에요.{ '\n' }실제 차량의 현재 위치도 함께 확인해주세요.</Text>
        {!!state.error && <Text accessibilityRole="alert" style={{ color: '#A12C2C' }}>{state.error}</Text>}
        <Action style={{ alignSelf: 'stretch' }} disabled={state.busy} onPress={() => void state.cancel()}>{state.busy ? '종료 중…' : '확인했어요 · 알림 종료'}</Action>
      </View>
    </View>
  </Modal>;
}
