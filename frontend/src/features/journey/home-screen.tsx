import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StationSearchField } from '../stations/station-search-field';
import type { Station, StationFieldValue } from '../stations/stations';
import { AlarmStatus } from '../notifications/alarm-status';
import { AlarmDialog } from '../notifications/alarm-dialog';
import { useAlarm } from '../notifications/use-alarm';
import { getOfficialRoute } from '../../services/official-route';
import { loadSegmentTimes } from '../../services/segment-times';
import { findRoute, type JourneyRoute } from './route-service';
import { defaultRouteCostProvider } from './route-costs';
import { RouteResultScreen } from './route-result-screen';
import { Action, palette, TrainIcon, ui } from './journey-ui';

const empty: StationFieldValue = { query: '', station: null };
type Tab = 'search' | 'route' | 'alarms';
const tabs: readonly { id: Tab; label: string }[] = [
  { id: 'search', label: '길찾기' },
  { id: 'route', label: '내 여정' },
  { id: 'alarms', label: '알림' },
];

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= 900;
  const [tab, setTab] = useState<Tab>('search');
  const [departure, setDeparture] = useState<StationFieldValue>(empty);
  const [arrival, setArrival] = useState<StationFieldValue>(empty);
  const [activeField, setActiveField] = useState<'departure' | 'arrival' | null>(null);
  const [stopsBefore] = useState(1);
  const [route, setRoute] = useState<JourneyRoute | null>(null);
  const [preference, setPreference] = useState<'fastest' | 'fewest-transfers'>('fastest');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const routeRequest = useRef<AbortController | null>(null);
  const costProvider = useRef(defaultRouteCostProvider);
  const pageRef = useRef<ScrollView>(null);
  const alarm = useAlarm();

  useEffect(() => () => routeRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void loadSegmentTimes(controller.signal).then((provider) => {
      if (!controller.signal.aborted) costProvider.current = provider;
    });
    return () => controller.abort();
  }, []);

  const sameStation = departure.station != null && departure.station.id === arrival.station?.id;
  const canSearch = Boolean(departure.station && arrival.station && !sameStation);

  function selectTab(next: Tab) {
    Keyboard.dismiss();
    setActiveField(null);
    setTab(next);
    pageRef.current?.scrollTo({ y: 0, animated: true });
  }

  function cancelRoute() {
    routeRequest.current?.abort();
    routeRequest.current = null;
    setRouteLoading(false);
  }

  function updateField(field: 'departure' | 'arrival', value: StationFieldValue) {
    cancelRoute();
    (field === 'departure' ? setDeparture : setArrival)(value);
    setRoute(null);
    setRouteError(null);
  }

  function swapStations() {
    cancelRoute();
    setDeparture(arrival);
    setArrival(departure);
    setRoute(null);
    setRouteError(null);
    setActiveField(null);
    Keyboard.dismiss();
  }

  async function searchRoute(from: Station | null = departure.station, to: Station | null = arrival.station, selectedPreference = preference) {
    if (!from || !to || from.id === to.id) return;
    setActiveField(null);
    Keyboard.dismiss();
    cancelRoute();
    const controller = new AbortController();
    routeRequest.current = controller;
    setRoute(null);
    setRouteError(null);
    setRouteLoading(true);
    let result: JourneyRoute | null;
    try {
      result = await getOfficialRoute(from, to, selectedPreference, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      result = findRoute(from.id, to.id, selectedPreference, costProvider.current);
      setRouteError(result
        ? '공식 시간표를 확인하지 못해 임시 예상값으로 안내해요.'
        : '이 구간의 경로를 찾지 못했어요. 다른 역을 선택해주세요.');
    }
    if (controller.signal.aborted || routeRequest.current !== controller) return;
    routeRequest.current = null;
    setRouteLoading(false);
    setRoute(result);
    if (result) selectTab('route');
    else selectTab('search');
  }

  const navigation = tabs.map(({ id, label }) => {
    const selected = tab === id;
    return <Pressable
      key={id}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={() => selectTab(id)}
      style={({ pressed }) => [styles.tabButton, !wide && styles.mobileTabButton, selected && styles.tabButtonActive, pressed && { opacity: .7 }]}>
      {!wide && <View style={[styles.tabMark, selected && styles.tabMarkActive]} />}
      <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>{label}{id === 'alarms' && alarm.status === 'active' ? '  •' : ''}</Text>
    </Pressable>;
  });

  return <SafeAreaView edges={['top']} style={styles.page}>
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, !wide && styles.headerMobile]}>
        <Pressable accessibilityRole="button" accessibilityLabel="여기야 홈" onPress={() => selectTab('search')} style={ui.row}>
          <View style={styles.logo}><TrainIcon size={26} color="#FFF" /></View>
          <Text style={styles.wordmark}>여기야<Text style={{ color: palette.green }}>.</Text></Text>
        </Pressable>
        {wide && <View style={styles.desktopNav}>{navigation}</View>}
      </View>

      <ScrollView
        ref={pageRef}
        style={styles.fill}
        contentContainerStyle={[styles.content, wide ? styles.contentWide : styles.contentMobile]}
        keyboardShouldPersistTaps="handled">
        {tab === 'search' && <>
          <View style={styles.intro}>
            <Text style={ui.eyebrow}>YOUR NEXT STOP, A LITTLE MORE COMFORTABLE</Text>
            <Text accessibilityRole="header" style={styles.title}>내릴 걱정은 내려놓고,{'\n'}편하게 가요.</Text>
            <Text style={ui.muted}>출발역과 내릴 역을 선택해주세요.</Text>
          </View>
          <View style={[ui.card, styles.searchCard]}>
            <View style={ui.spread}>
              <View style={ui.row}><TrainIcon size={22} /><Text style={ui.heading}>어디로 갈까요?</Text></View>
              <Text style={styles.smallPill}>지하철</Text>
            </View>
            <View style={styles.fields}>
              <StationSearchField label="출발역" value={departure} onChange={(value) => updateField('departure', value)} active={activeField === 'departure'} onFocus={() => setActiveField('departure')} onSelect={() => { setActiveField(null); Keyboard.dismiss(); }} />
              <View style={styles.swapRow}>
                <View style={styles.connector} />
                <Pressable accessibilityRole="button" accessibilityLabel="출발역과 도착역 바꾸기" onPress={swapStations} style={styles.swap}>
                  <Text style={styles.swapText}>↕ 출발·도착 바꾸기</Text>
                </Pressable>
              </View>
              <StationSearchField label="도착역" value={arrival} onChange={(value) => updateField('arrival', value)} active={activeField === 'arrival'} onFocus={() => setActiveField('arrival')} onSelect={() => { setActiveField(null); Keyboard.dismiss(); }} />
            </View>
            {sameStation && <Text accessibilityRole="alert" style={styles.validation}>출발역과 내릴 역을 다르게 선택해주세요.</Text>}
            {routeError && <Text accessibilityRole="alert" style={ui.muted}>{routeError}</Text>}
            <Action onPress={() => void searchRoute()} disabled={!canSearch || routeLoading}>
              {routeLoading ? '경로 확인 중…' : '경로 찾기　→'}
            </Action>
          </View>
        </>}

        {tab === 'route' && <>
          <View style={styles.sectionHeading}>
            <Text style={ui.eyebrow}>MY JOURNEY</Text>
            <Text accessibilityRole="header" style={styles.sectionTitle}>내 여정</Text>
            {route && <Text style={ui.muted}>{departure.station?.name} → {arrival.station?.name}</Text>}
          </View>
          {!route && <View style={[ui.card, styles.emptyState]}>
            <TrainIcon size={38} />
            <Text style={ui.heading}>{routeLoading ? '경로를 다시 확인하고 있어요' : '아직 선택한 여정이 없어요'}</Text>
            <Text style={ui.muted}>출발역과 내릴 역을 고르면 여기에 경로가 표시돼요.</Text>
            {!routeLoading && <Action secondary onPress={() => selectTab('search')}>길찾기</Action>}
          </View>}
        </>}

        {route && <View style={tab === 'route' ? undefined : styles.hidden}>
          <RouteResultScreen
            route={route}
            stopsBefore={stopsBefore}
            preference={preference}
            onPreference={(value) => { setPreference(value); void searchRoute(departure.station, arrival.station, value); }}
          />
        </View>}

        {tab === 'alarms' && <>
          <View style={styles.sectionHeading}>
            <Text style={ui.eyebrow}>MY ALARM</Text>
            <Text accessibilityRole="header" style={styles.sectionTitle}>내 알림</Text>
          </View>
          <AlarmStatus />
          {!alarm.alarm && !alarm.error && <View style={[ui.card, styles.emptyState]}>
            <TrainIcon size={38} />
            <Text style={ui.heading}>켜진 하차 알림이 없어요</Text>
            <Text style={ui.muted}>여정을 선택하고 탑승할 차량에서 알림을 설정해주세요.</Text>
            <Action secondary onPress={() => selectTab(route ? 'route' : 'search')}>{route ? '내 여정 보기' : '길찾기'}</Action>
          </View>}
        </>}
      </ScrollView>

      {!wide && <View style={[styles.bottomNav, { paddingBottom: Math.max(insets.bottom, 10) }]}>{navigation}</View>}
    </KeyboardAvoidingView>
    <AlarmDialog />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FAFCFA' },
  fill: { flex: 1 },
  header: { minHeight: 76, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: palette.border, paddingHorizontal: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerMobile: { minHeight: 67, paddingHorizontal: 20 },
  logo: { width: 38, height: 38, borderRadius: 12, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  wordmark: { fontSize: 25, fontWeight: '800', letterSpacing: -1.4, color: palette.ink },
  desktopNav: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  tabButton: { minHeight: 52, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12 },
  mobileTabButton: { flex: 1, paddingHorizontal: 6 },
  tabButtonActive: { backgroundColor: palette.tint },
  tabLabel: { color: palette.muted, fontSize: 13, fontWeight: '600' },
  tabLabelActive: { color: palette.green, fontWeight: '700' },
  tabMark: { width: 18, height: 3, borderRadius: 3, backgroundColor: 'transparent' },
  tabMarkActive: { backgroundColor: palette.green },
  bottomNav: { flexDirection: 'row', backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 7, paddingHorizontal: 12 },
  content: { width: '100%', alignSelf: 'center', gap: 24, paddingBottom: 36 },
  contentWide: { maxWidth: 720, paddingHorizontal: 32, paddingTop: 54 },
  contentMobile: { paddingHorizontal: 18, paddingTop: 24 },
  intro: { gap: 10, paddingHorizontal: 2, marginBottom: 4 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -1.3, color: palette.ink, lineHeight: 40 },
  searchCard: { padding: 22, gap: 16 },
  smallPill: { color: palette.green, backgroundColor: palette.tint, fontSize: 10, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 5 },
  fields: { gap: 9 },
  swapRow: { flexDirection: 'row', height: 25, justifyContent: 'space-between', alignItems: 'center' },
  connector: { height: 20, borderLeftWidth: 2, borderColor: '#CDDAD0', borderStyle: 'dotted', marginLeft: 20 },
  swap: { minHeight: 36, paddingHorizontal: 5, justifyContent: 'center' },
  swapText: { color: '#6B7E72', fontSize: 12 },
  validation: { color: '#BE6841', fontSize: 12 },
  sectionHeading: { gap: 7, paddingHorizontal: 2 },
  sectionTitle: { fontSize: 28, fontWeight: '700', letterSpacing: -1, color: palette.ink },
  emptyState: { alignItems: 'center', paddingVertical: 38, gap: 14 },
  hidden: { display: 'none' },
});
