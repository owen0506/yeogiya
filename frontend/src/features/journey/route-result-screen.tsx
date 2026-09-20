import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getArrivals, type Arrival } from '../../services/seoul-subway';
import { useAlarm } from '../notifications/use-alarm';
import { BrowserNotificationPermission } from '../notifications/browser-notification-permission';
import { lineColor } from '../stations/network';
import { alarmDelaySeconds, type JourneyRoute } from './route-service';
import { Action, LineBadge, palette, ui } from './journey-ui';

type Props = { route: JourneyRoute; stopsBefore: number; saved: boolean; onSave: () => void; preference: 'fastest' | 'fewest-transfers'; onPreference: (value: 'fastest' | 'fewest-transfers') => void };

export function RouteResultScreen({ route, stopsBefore, saved, onSave, preference, onPreference }: Props) {
  const first = route.steps[0].station, last = route.steps[route.steps.length - 1].station;
  const [expanded, setExpanded] = useState(false);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [liveMessage, setLiveMessage] = useState('출발역에 오는 열차를 확인할 수 있어요.');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const alarm = useAlarm();
  const delay = alarmDelaySeconds(route, stopsBefore);
  const disabled = alarm.busy || alarm.status === 'active' || route.stops === 0;
  const visibleSteps = route.steps.filter((step, index) => expanded || index === 0 || index === route.steps.length - 1 || step.transfer || route.steps[index + 1]?.transfer);
  const lines = route.steps.filter((step, index) => index === 0 || step.transfer).map((step) => step.station.line);
  const nextStop = route.steps.find((step, index) => index > 0 && !step.transfer)?.station.name;

  useEffect(() => {
    setArrivals([]);
    if (!refresh) { setLiveMessage('출발역에 오는 열차를 확인할 수 있어요.'); return; }
    let disposed = false;
    const controller = new AbortController();
    setLoading(true); setLiveMessage('도착 정보를 확인하고 있어요…');
    getArrivals(first.name, first.line, controller.signal).then((items) => {
      if (disposed) return;
      setArrivals(items);
      setLiveMessage(items.length ? '탑승 전 열차의 방면을 확인해주세요.' : '최근 도착 정보가 없어요. 잠시 후 다시 확인해주세요.');
    }).catch(() => {
      if (!disposed) setLiveMessage('지금은 도착 정보를 불러올 수 없어요. 예상 시간 알림은 사용할 수 있어요.');
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [first.name, first.line, refresh]);

  return <View style={{ gap: 18 }}>
    <View style={[ui.card, { gap: 18 }]}>
      <View style={ui.spread}><View style={styles.preferences}>{([['fastest', '빠른 경로'], ['fewest-transfers', '최소 환승']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: preference === value }} aria-checked={preference === value} onPress={() => onPreference(value)} style={[styles.preference, preference === value && { backgroundColor: '#FFF', boxShadow: '0 1px 4px #1C382515' }]}><Text style={{ fontSize: 11, color: preference === value ? palette.green : palette.muted, fontWeight: '600' }}>{label}</Text></Pressable>)}</View><Pressable accessibilityRole="button" accessibilityLabel={saved ? '경로 저장 해제' : '경로 저장'} accessibilityState={{ selected: saved }} aria-pressed={saved} onPress={onSave} style={styles.save}><Text style={{ fontSize: 25, color: saved ? '#C69D48' : '#9BA79E' }}>{saved ? '★' : '☆'}</Text></Pressable></View>
      <View style={ui.spread}><Text style={{ fontSize: 32, color: palette.ink, fontWeight: '800', letterSpacing: -1 }}>{Math.ceil(route.seconds / 60)}<Text style={{ fontSize: 17, fontWeight: '600' }}>분</Text><Text style={[ui.muted, { fontSize: 11 }]}>　예상</Text></Text><Text style={ui.muted}>{route.stops}개 역 · 환승 {route.transfers}회</Text></View>
      <View style={styles.routeBar}>{lines.map((line, index) => <View key={`${line}-${index}`} style={{ flex: 1, height: 7, borderRadius: 4, backgroundColor: lineColor(line) }} />)}</View>
      <View style={{ gap: 0 }}>{visibleSteps.map((step, index) => <View key={step.station.id} style={styles.step}><View style={styles.rail}><View style={[styles.railDot, { borderColor: lineColor(step.station.line) }]} />{index < visibleSteps.length - 1 && <View style={[styles.railLine, { backgroundColor: lineColor(step.station.line) }]} />}</View><View style={{ flex: 1, gap: 4, paddingBottom: 18 }}><View style={ui.spread}><Text style={[ui.text, { fontWeight: '600' }]}>{step.station.name}</Text><Text style={ui.muted}>{index === 0 ? '출발' : index === visibleSteps.length - 1 ? '하차' : step.transfer ? '환승' : '경유'}</Text></View><View style={ui.row}><LineBadge line={step.station.line} small /><Text style={[ui.muted, { fontSize: 10 }]}>{index === 0 ? `${nextStop ?? last.name} 방면` : `출발 후 약 ${Math.ceil(step.secondsFromStart / 60)}분`}</Text></View></View></View>)}</View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(!expanded)} style={styles.expand}><Text style={{ color: '#688373', fontSize: 12 }}>{expanded ? '경유역 접기　⌃' : `전체 ${route.stops}개 이동 구간 보기　⌄`}</Text></Pressable>
      <Text style={[ui.muted, { fontSize: 10 }]}>일반열차 기준 · 역간 2분, 환승 5분 예상{ '\n' }열차 대기·지연 시간은 포함하지 않아요.</Text>
    </View>
    <View style={[ui.card, { backgroundColor: '#F0F7F0', borderColor: '#DAE9D9' }]}>
      <Text style={[ui.heading, { fontSize: 16 }]}>내릴 준비는 {stopsBefore}개 역 전에</Text>
      <Text style={ui.muted}>탑승 후 시작하면 {delay <= 1 ? '바로' : `약 ${Math.ceil(delay / 60)}분 뒤`} 알려드려요.{route.transfers ? '\n환승 대기 시간에 따라 실제 도착과 차이가 날 수 있어요.' : ''}</Text>
      <Action disabled={disabled} onPress={() => void alarm.start(last.name, delay, false)}>{alarm.busy ? '알림을 준비하고 있어요…' : alarm.status === 'active' ? '하차 알림이 켜져 있어요' : '탑승했어요 · 알림 시작'}</Action>
      <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} onPress={() => void alarm.start(last.name, 10, true)} style={{ alignItems: 'center', minHeight: 36, justifyContent: 'center', opacity: disabled ? .4 : 1 }}><Text style={{ color: '#598068', fontSize: 12 }}>먼저 10초 체험해보기　↗</Text></Pressable>
      <BrowserNotificationPermission />
    </View>
    <View style={ui.card}><View style={ui.spread}><Text style={[ui.heading, { fontSize: 14 }]}>출발역 실시간 도착</Text><Text style={ui.muted}>서울시 TOPIS</Text></View><Text accessibilityLiveRegion="polite" style={ui.muted}>{liveMessage}</Text>{arrivals.slice(0, 4).map((item, index) => <View key={`${item.trainId}-${index}`} style={styles.arrival}><Text style={[ui.text, { fontSize: 12, fontWeight: '600' }]}>{item.destination} · {item.direction}</Text><Text style={ui.muted}>{item.message}{item.seconds !== null ? ` · 약 ${Math.ceil(item.seconds / 60)}분` : ''}</Text><Text style={[ui.muted, { fontSize: 10 }]}>{item.receivedAt} 기준</Text></View>)}<Action secondary disabled={loading} onPress={() => setRefresh((value) => value + 1)}>{loading ? '확인 중…' : refresh ? '도착 정보 새로고침' : '실시간 도착 확인'}</Action><Text style={[ui.muted, { fontSize: 10 }]}>도착 정보는 참고용이며 하차 알림 시간에 자동 반영되지 않아요.</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  preferences: { flexDirection: 'row', backgroundColor: '#F3F6F2', borderRadius: 9, padding: 4, gap: 2 },
  preference: { paddingHorizontal: 11, minHeight: 34, justifyContent: 'center', borderRadius: 7 },
  save: { minWidth: 36, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  routeBar: { flexDirection: 'row', gap: 5 },
  step: { flexDirection: 'row', gap: 12 },
  rail: { width: 14, alignItems: 'center', paddingTop: 5 },
  railDot: { width: 12, height: 12, borderWidth: 3, borderRadius: 6, backgroundColor: '#FFF' },
  railLine: { flex: 1, width: 2, marginVertical: 3, opacity: .25 },
  expand: { borderTopWidth: 1, borderTopColor: palette.border, alignItems: 'center', paddingTop: 13, minHeight: 38 },
  arrival: { borderLeftWidth: 2, borderLeftColor: '#C3D6C7', paddingLeft: 10, gap: 4 },
});
