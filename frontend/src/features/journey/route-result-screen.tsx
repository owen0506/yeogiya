import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getArrivals, type Arrival } from '../../services/seoul-subway';
import { AlarmStatus } from '../notifications/alarm-status';
import { useAlarm } from '../notifications/use-alarm';
import { alarmDelaySeconds, type JourneyRoute } from './route-service';

type Props = { route: JourneyRoute; stopsBefore: number; onBack: () => void };

export function RouteResultScreen({ route, stopsBefore, onBack }: Props) {
  const first = route.steps[0].station;
  const last = route.steps[route.steps.length - 1].station;
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [liveMessage, setLiveMessage] = useState('실시간 정보를 확인하고 있습니다…');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const alarm = useAlarm();
  const delay = alarmDelaySeconds(route, stopsBefore);
  const disabled = alarm.busy || alarm.status === 'active' || route.stops === 0;

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setLoading(true);
    setArrivals([]);
    setLiveMessage('실시간 정보를 확인하고 있습니다…');
    getArrivals(first.name, first.line, controller.signal).then((items) => {
      if (disposed) return;
      setArrivals(items);
      setLiveMessage(items.length ? '출발역 도착 정보 · 방면을 확인하세요' : '최근 3분 이내의 도착 정보가 없습니다. 예상 시간 알림은 사용할 수 있어요.');
    }).catch((error: unknown) => {
      if (!disposed) setLiveMessage(error instanceof Error ? error.message : '실시간 정보를 가져오지 못했습니다.');
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [first.name, first.line, refresh]);

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.secondary}><Text style={styles.green}>← 역 다시 선택</Text></Pressable>
        <Text accessibilityRole="header" style={styles.title}>경로 결과</Text>
        <Text style={styles.label}>{first.name} → {last.name}</Text>
        <View style={styles.card}>
          <Text style={styles.title}>약 {Math.ceil(route.seconds / 60)}분</Text>
          <Text style={styles.label}>{route.stops}개 역 이동 · 환승 {route.transfers}회</Text>
          <Text style={styles.help}>데모 부분 노선망의 예상 경로입니다. 역간 2분·환승 5분으로 계산하며 실제 최단 경로와 운행 시간을 보장하지 않습니다.</Text>
          {route.steps.map((step, index) => (
            <View key={step.station.id} style={styles.step}>
              <Text style={styles.label}>{index === 0 ? '출발' : index === route.steps.length - 1 ? '도착' : step.transfer ? '환승' : '경유'} · {step.station.name}</Text>
              <Text style={styles.help}>{step.station.line} · {Math.ceil(step.secondsFromStart / 60)}분{step.transfer ? ' · 노선 변경' : ''}</Text>
            </View>
          ))}
        </View>
        <View style={styles.card}>
          <Text style={styles.label}>실시간 도착 정보</Text>
          <Text accessibilityLiveRegion="polite" style={styles.help}>{liveMessage}</Text>
          {arrivals.slice(0, 6).map((arrival, index) => (
            <View key={`${arrival.trainId}-${index}`} style={styles.step}>
              <Text style={styles.label}>{arrival.destination} · {arrival.direction}</Text>
              <Text style={styles.help}>{arrival.message}{arrival.seconds !== null ? ` · 약 ${Math.ceil(arrival.seconds / 60)}분` : ''}</Text>
              <Text style={styles.help}>정보 생성: {arrival.receivedAt}</Text>
            </View>
          ))}
          <Pressable accessibilityRole="button" disabled={loading} onPress={() => setRefresh((value) => value + 1)} style={styles.secondary}>
            <Text style={styles.green}>{loading ? '조회 중…' : '실시간 정보 새로고침'}</Text>
          </Pressable>
          <Text style={styles.help}>출처: 서울특별시 TOPIS. 도착 정보는 참고용이며 탑승 열차를 자동 추적하지 않습니다.</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.label}>도착 {stopsBefore}개 역 전 알림</Text>
          <Text style={styles.help}>탑승 후 시작해주세요. 시작 후 {delay <= 1 ? '즉시' : `약 ${Math.ceil(delay / 60)}분 뒤`} 예상 시간으로 알려드립니다. 지연·대기 시간은 반영되지 않습니다.</Text>
          {route.stops === 0 && <Text style={styles.help}>역간 이동이 없는 경로는 하차 알림을 시작할 수 없습니다.</Text>}
          {Platform.OS === 'web' && <Text style={styles.help}>웹에서는 화면 내 알림을 표시합니다. 브라우저 권한을 허용하면 데스크톱 알림도 시도합니다.</Text>}
          <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => void alarm.start(last.name, delay, false)} style={[styles.primary, disabled && styles.disabled]}>
            <Text style={styles.white}>{alarm.busy ? '처리 중…' : alarm.status === 'active' ? '기존 알림을 먼저 종료해주세요' : '탑승 완료 · 예상 시간 알림 시작'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={disabled} onPress={() => void alarm.start(last.name, 10, true)} style={[styles.secondary, disabled && styles.disabled]}>
            <Text style={styles.green}>10초 체험 알림</Text>
          </Pressable>
        </View>
        <AlarmStatus />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F4F7FA' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', padding: 24, gap: 20, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#172D40' },
  label: { fontSize: 16, fontWeight: '600', color: '#172D40', lineHeight: 24 },
  help: { fontSize: 13, lineHeight: 21, color: '#566B7C' },
  card: { padding: 22, backgroundColor: '#FFFFFF', borderRadius: 20, gap: 14 },
  step: { borderLeftWidth: 3, borderLeftColor: '#116B55', paddingLeft: 14, paddingVertical: 5, gap: 5 },
  primary: { padding: 16, minHeight: 48, borderRadius: 12, backgroundColor: '#116B55', alignItems: 'center' },
  secondary: { padding: 14, minHeight: 48, borderRadius: 12, backgroundColor: '#E8F4EF', alignItems: 'center' },
  green: { color: '#116B55', fontWeight: '600' },
  white: { color: '#FFFFFF', fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
