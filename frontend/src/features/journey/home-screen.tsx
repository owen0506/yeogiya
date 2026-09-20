import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StationSearchField } from '../stations/station-search-field';
import { stations, type Station, type StationFieldValue } from '../stations/stations';
import { lineColor, subwayLines } from '../stations/network';
import { findRoute, type JourneyRoute } from './route-service';
import { RouteResultScreen } from './route-result-screen';
import { SubwayMap } from './subway-map';
import { AlarmStatus } from '../notifications/alarm-status';
import { AlarmDialog } from '../notifications/alarm-dialog';
import { useAlarm } from '../notifications/use-alarm';
import { Action, LineBadge, palette, TrainIcon, ui } from './journey-ui';
import { loadJourneys, storeJourneys, type SavedJourney } from './journey-storage';

const empty: StationFieldValue = { query: '', station: null };
const stationValue = (station: Station): StationFieldValue => ({ query: station.name, station });
type Tab = 'journey' | 'saved' | 'alarms';

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const wide = width >= 1000;
  const [departure, setDeparture] = useState<StationFieldValue>(empty);
  const [arrival, setArrival] = useState<StationFieldValue>(empty);
  const [activeField, setActiveField] = useState<'departure' | 'arrival' | null>(null);
  const [stopsBefore, setStopsBefore] = useState(1);
  const [route, setRoute] = useState<JourneyRoute | null>(null);
  const [preference, setPreference] = useState<'fastest' | 'fewest-transfers'>('fastest');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('journey');
  const [line, setLine] = useState('2호선');
  const [stationQuery, setStationQuery] = useState('');
  const [mapStation, setMapStation] = useState<Station | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [saved, setSaved] = useState<SavedJourney[]>([]);
  const [recent, setRecent] = useState<SavedJourney[]>([]);
  const pageRef = useRef<ScrollView>(null);
  const alarm = useAlarm();
  useEffect(() => { setSaved(loadJourneys('saved')); setRecent(loadJourneys('recent')); }, []);

  const sameStation = departure.station != null && departure.station.name === arrival.station?.name;
  const canSearch = Boolean(departure.station && arrival.station && !sameStation);
  const filteredStations = stations.filter((station) => station.line === line && station.name.includes(stationQuery.trim().replace(/역$/, '')));
  const isSaved = saved.some((item) => item.fromId === departure.station?.id && item.toId === arrival.station?.id);

  function finishSelection() { setActiveField(null); Keyboard.dismiss(); }
  function updateField(field: 'departure' | 'arrival', value: StationFieldValue) {
    (field === 'departure' ? setDeparture : setArrival)(value);
    setRoute(null); setRouteError(null);
  }
  function selectMapStation(field: 'departure' | 'arrival') {
    if (!mapStation) return;
    updateField(field, stationValue(mapStation)); setMapStation(null); setTab('journey'); finishSelection();
    pageRef.current?.scrollTo({ y: 0, animated: true });
  }
  function searchRoute(from = departure.station, to = arrival.station, selectedPreference = preference) {
    if (!from || !to || from.name === to.name) return;
    finishSelection();
    const result = findRoute(from.id, to.id, selectedPreference);
    setRouteError(result ? null : '이 구간의 경로를 찾지 못했어요. 다른 역을 선택해주세요.');
    setRoute(result); setTab('journey');
    if (result) {
      const next = [{ fromId: from.id, toId: to.id }, ...recent.filter((item) => item.fromId !== from.id || item.toId !== to.id)].slice(0, 4);
      setRecent(next); storeJourneys('recent', next); setLine(from.line);
    }
  }
  function openJourney(item: SavedJourney) {
    const from = stations.find((station) => station.id === item.fromId), to = stations.find((station) => station.id === item.toId);
    if (!from || !to) return;
    setDeparture(stationValue(from)); setArrival(stationValue(to)); searchRoute(from, to);
    pageRef.current?.scrollTo({ y: 0, animated: true });
  }
  function toggleSave() {
    if (!departure.station || !arrival.station) return;
    const next = isSaved ? saved.filter((item) => item.fromId !== departure.station!.id || item.toId !== arrival.station!.id) : [{ fromId: departure.station.id, toId: arrival.station.id }, ...saved].slice(0, 8);
    setSaved(next); storeJourneys('saved', next);
  }

  const journeyRows = (items: SavedJourney[], removable = false) => items.map((item) => {
    const from = stations.find((station) => station.id === item.fromId)!, to = stations.find((station) => station.id === item.toId)!;
    return <View key={`${item.fromId}-${item.toId}`} style={[ui.row, styles.journeyRow]}><Pressable accessibilityRole="button" accessibilityLabel={`${from.name}에서 ${to.name} 경로 불러오기`} onPress={() => openJourney(item)} style={{ flex: 1, gap: 8, paddingVertical: 5 }}><View style={ui.row}><Text style={[ui.text, { fontWeight: '600' }]}>{from.name}</Text><Text style={ui.muted}>→</Text><Text style={[ui.text, { fontWeight: '600' }]}>{to.name}</Text></View><View style={ui.row}><LineBadge line={from.line} small /><Text style={ui.muted}>{from.line === to.line ? '같은 노선으로 편하게' : `${to.line} 도착`}</Text></View></Pressable>{removable ? <Pressable accessibilityRole="button" accessibilityLabel={`${from.name} ${to.name} 저장 삭제`} onPress={() => { const next = saved.filter((value) => value !== item); setSaved(next); storeJourneys('saved', next); }} style={styles.iconButton}><Text style={ui.muted}>×</Text></Pressable> : <Text style={ui.muted}>↗</Text>}</View>;
  });

  return <SafeAreaView style={styles.page}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, !wide && { paddingHorizontal: 20 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="여기야 홈" onPress={() => { setTab('journey'); setRoute(null); }} style={ui.row}><View style={styles.logo}><TrainIcon size={26} color="#FFF" /></View><Text style={styles.wordmark}>여기야<Text style={{ color: palette.green }}>.</Text></Text>{wide && <Text style={styles.tagline}>마음 편한 지하철 여정</Text>}</Pressable>
        {wide && <View style={styles.navigation}>{([['journey', '경로 찾기'], ['saved', '저장한 경로'], ['alarms', '내 알림']] as const).map(([id, title]) => <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} aria-selected={tab === id} onPress={() => setTab(id)} style={[styles.navItem, tab === id && styles.navSelected]}><Text style={[styles.navText, tab === id && { color: palette.green, fontWeight: '700' }]}>{title}{id === 'alarms' && alarm.status === 'active' ? ' •' : ''}</Text></Pressable>)}</View>}
        <Pressable accessibilityRole="button" accessibilityLabel="이용 안내" onPress={() => setShowHelp(true)} style={styles.helpButton}><Text style={{ color: palette.muted, fontSize: 13 }}>ⓘ {wide ? '이용 안내' : '도움말'}</Text></Pressable>
      </View>
      {!wide && <View style={styles.mobileNav}>{([['journey', '경로 찾기'], ['saved', '저장한 경로'], ['alarms', '내 알림']] as const).map(([id, title]) => <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} aria-selected={tab === id} onPress={() => setTab(id)} style={[styles.mobileNavItem, tab === id && { borderBottomColor: palette.green }]}><Text style={[styles.navText, tab === id && { color: palette.green, fontWeight: '700' }]}>{title}{id === 'alarms' && alarm.status === 'active' ? ' •' : ''}</Text></Pressable>)}</View>}
      <ScrollView ref={pageRef} contentContainerStyle={[styles.content, !wide && { padding: 18, gap: 22 }]} keyboardShouldPersistTaps="handled">
        <View style={[styles.intro, !wide && { alignItems: 'flex-start', gap: 12 }]}><View style={{ gap: 10 }}><Text style={ui.eyebrow}>YOUR NEXT STOP, A LITTLE MORE COMFORTABLE</Text><Text accessibilityRole="header" style={[styles.title, !wide && { fontSize: 28 }]}>내릴 걱정은 내려놓고,{!wide ? '\n' : ' '}편하게 가요.</Text><Text style={[ui.muted, { fontSize: 13 }]}>원하는 노선을 고르고, 내릴 역만 알려주세요.</Text></View><View style={styles.seoulTag}><View style={styles.onlineDot} /><Text style={{ color: '#56806A', fontSize: 11 }}>서울 지하철 · 하차 알림</Text></View></View>
        <View style={[styles.workspace, !wide && { flexDirection: 'column' }]}>
          <View style={[styles.sidebar, !wide && { width: '100%' }]}>
            {tab === 'journey' && <>
              <AlarmStatus />
              <View style={[ui.card, { padding: 22, gap: 16, boxShadow: '0 5px 25px #23452D05' }]}>
                <View style={ui.spread}><View style={ui.row}><TrainIcon size={22} /><Text style={ui.heading}>어디로 갈까요?</Text></View><Text style={styles.smallPill}>지하철</Text></View>
                <View style={{ gap: 9 }}><StationSearchField label="출발역" value={departure} onChange={(value) => updateField('departure', value)} active={activeField === 'departure'} onFocus={() => setActiveField('departure')} onSelect={finishSelection} /><View style={styles.swapRow}><View style={styles.connector} /><Pressable accessibilityRole="button" accessibilityLabel="출발역과 도착역 바꾸기" onPress={() => { setDeparture(arrival); setArrival(departure); setRoute(null); finishSelection(); }} style={styles.swap}><Text style={{ color: '#6B7E72', fontSize: 12 }}>↕ 출발·도착 바꾸기</Text></Pressable></View><StationSearchField label="도착역" value={arrival} onChange={(value) => updateField('arrival', value)} active={activeField === 'arrival'} onFocus={() => setActiveField('arrival')} onSelect={finishSelection} /></View>
                {sameStation && <Text accessibilityRole="alert" style={{ color: '#BE6841', fontSize: 12 }}>출발역과 내릴 역을 다르게 선택해주세요.</Text>}
                <View style={ui.divider} />
                <View style={ui.spread}><Text style={[ui.text, { fontWeight: '600', fontSize: 13 }]}>언제 알려드릴까요?</Text><Text style={ui.muted}>예상 도착 기준</Text></View>
                <View style={styles.options}>{[1, 2, 3].map((count) => <Pressable key={count} accessibilityRole="radio" accessibilityLabel={`${count}개 역 전 알림`} accessibilityState={{ checked: stopsBefore === count }} aria-checked={stopsBefore === count} onPress={() => setStopsBefore(count)} style={[styles.option, stopsBefore === count && styles.optionSelected]}><Text style={{ color: stopsBefore === count ? palette.green : palette.muted, fontSize: 13, fontWeight: stopsBefore === count ? '700' : '400' }}>{count}개 역 전</Text></Pressable>)}</View>
                {routeError && <Text accessibilityRole="alert" style={ui.muted}>{routeError}</Text>}
                <Action onPress={() => searchRoute()} disabled={!canSearch}>경로 찾기　→</Action>
              </View>
              {route ? <RouteResultScreen route={route} stopsBefore={stopsBefore} saved={isSaved} onSave={toggleSave} preference={preference} onPreference={(value) => { setPreference(value); searchRoute(departure.station, arrival.station, value); }} /> : <>
                <View style={styles.restCard}><View style={styles.restIcon}><TrainIcon size={30} /></View><View style={{ flex: 1, gap: 5 }}><Text style={{ fontSize: 14, color: '#3B6449', fontWeight: '700' }}>잠깐 눈 붙여도 괜찮아요</Text><Text style={{ fontSize: 12, lineHeight: 19, color: '#7B927E' }}>탑승 후 알림을 켜두면{ '\n' }내릴 준비가 필요할 때 알려드려요.</Text></View></View>
                <View style={{ gap: 13, paddingHorizontal: 3 }}><View style={ui.spread}><Text style={[ui.heading, { fontSize: 14 }]}>{recent.length ? '최근 찾은 경로' : '가볍게 시작해보세요'}</Text><Text style={ui.muted}>{recent.length ? `${recent.length}개` : '추천 여정'}</Text></View>{recent.length ? journeyRows(recent) : <Pressable accessibilityRole="button" accessibilityLabel="강남에서 잠실 추천 경로" onPress={() => openJourney({ fromId: 'mock-2-gangnam', toId: 'mock-2-jamsil' })} style={styles.suggestion}><View style={ui.row}><LineBadge line="2호선" /><Text style={[ui.text, { fontWeight: '600' }]}>강남  →  잠실</Text></View><Text style={ui.muted}>12분 예상　↗</Text></Pressable>}</View>
              </>}
            </>}
            {tab === 'saved' && <View style={ui.card}><Text style={ui.heading}>자주 가는 길, 한 번에</Text><Text style={ui.muted}>{Platform.OS === 'web' ? '이 브라우저에 저장한 경로예요.' : '앱을 사용하는 동안 저장한 경로예요.'}</Text>{saved.length ? journeyRows(saved, true) : <View style={styles.emptyState}><Text style={{ color: '#98AE9A', fontSize: 36 }}>☆</Text><Text style={ui.text}>아직 저장한 경로가 없어요</Text><Text style={[ui.muted, { textAlign: 'center' }]}>경로를 찾고 별표를 누르면{ '\n' }다음 여정이 더 간편해져요.</Text><Action secondary onPress={() => setTab('journey')}>경로 찾으러 가기</Action></View>}</View>}
            {tab === 'alarms' && <View style={{ gap: 16 }}><View style={ui.card}><Text style={ui.heading}>내 하차 알림</Text><Text style={ui.muted}>지하철에 탑승한 뒤 알림을 시작해주세요.</Text>{!alarm.alarm && <View style={styles.emptyState}><TrainIcon size={42} /><Text style={ui.text}>지금은 켜진 알림이 없어요</Text><Text style={ui.muted}>목적지를 고르면 여기야가 함께할게요.</Text><Action secondary onPress={() => setTab('journey')}>목적지 선택하기</Action></View>}</View><AlarmStatus /></View>}
          </View>
          <View style={styles.mapColumn}>
            <View style={ui.spread}><View style={{ gap: 5 }}><Text style={ui.heading}>노선에서 바로 선택</Text><Text style={ui.muted}>익숙한 노선으로, 더 간편하게</Text></View><View style={styles.mapLabel}><Text style={{ color: palette.green, fontSize: 11 }}>SEOUL METRO</Text></View></View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.lineTabs}>{subwayLines.map((item) => <Pressable key={item.name} accessibilityRole="tab" accessibilityLabel={`${item.name} 노선 보기`} accessibilityState={{ selected: line === item.name }} aria-selected={line === item.name} onPress={() => { setLine(item.name); setStationQuery(''); }} style={[styles.lineTab, line === item.name && { backgroundColor: item.color, borderColor: item.color }]}><View style={[styles.lineDot, { backgroundColor: line === item.name ? '#FFF' : item.color }]} /><Text style={{ color: line === item.name ? '#FFF' : '#718076', fontSize: 12, fontWeight: '600' }}>{item.name}</Text></Pressable>)}</ScrollView>
            <SubwayMap line={line} departure={departure.station} arrival={arrival.station} route={route} onSelect={setMapStation} />
            <View style={[ui.card, { padding: 18 }]}><View style={[ui.spread, { flexWrap: 'wrap' }]}><View style={ui.row}><LineBadge line={line} /><Text style={[ui.text, { fontWeight: '600' }]}>역 목록</Text><Text style={ui.muted}>{stations.filter((station) => station.line === line).length}개</Text></View><TextInput accessibilityLabel="선택한 노선에서 역 찾기" placeholder="노선 안에서 역 찾기" placeholderTextColor="#9BA79F" value={stationQuery} onChangeText={setStationQuery} style={styles.stationFilter} /></View><ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: 7, paddingBottom: 8 }}>{filteredStations.map((station) => <Pressable accessibilityRole="button" accessibilityLabel={`역 목록 ${station.name} ${line}`} key={station.id} onPress={() => setMapStation(station)} style={styles.stationChip}><Text style={{ fontSize: 12, color: '#586A5E' }}>{station.name}</Text></Pressable>)}{!filteredStations.length && <Text style={ui.muted}>이 노선에서는 찾지 못했어요.</Text>}</ScrollView></View>
            <View style={[styles.bottomTip, !wide && { marginBottom: 12 }]}><View style={styles.tipNumber}><Text style={{ color: palette.green, fontSize: 12 }}>✓</Text></View><Text style={[ui.muted, { flex: 1 }]}>탑승하고 알림 켜기. 내릴 때까지의 작은 여유는 여기야가 챙길게요.</Text><Pressable accessibilityRole="button" onPress={() => setShowHelp(true)} style={{ padding: 8 }}><Text style={{ fontSize: 11, color: palette.green }}>이용 방법 ↗</Text></Pressable></View>
          </View>
        </View>
        <View style={styles.footer}><Text style={{ fontSize: 12, fontWeight: '700', color: '#9DAA9F' }}>여기야.</Text><Text style={[ui.muted, { fontSize: 10, flex: 1, textAlign: 'right' }]}>서울 주요 구간 · 일반열차 예상 시간 기준 · 실시간 위치 추적 미지원</Text></View>
      </ScrollView>
    </KeyboardAvoidingView>
    <AlarmDialog />
    <Modal visible={!!mapStation} transparent animationType="fade" onRequestClose={() => setMapStation(null)}><View style={styles.overlay}><Pressable accessibilityRole="button" accessibilityLabel="역 선택 닫기" onPress={() => setMapStation(null)} style={StyleSheet.absoluteFill} /><View style={styles.modal}>
      {mapStation && <><View style={ui.spread}><LineBadge line={mapStation.line} /><Pressable accessibilityRole="button" accessibilityLabel="닫기" onPress={() => setMapStation(null)} style={styles.iconButton}><Text style={{ fontSize: 24, color: palette.muted }}>×</Text></Pressable></View><Text accessibilityRole="header" style={[styles.title, { fontSize: 27 }]}>{mapStation.name}</Text><Text style={ui.muted}>이번 여정의 어느 역인가요?</Text><View style={ui.row}><Action style={{ flex: 1 }} secondary onPress={() => selectMapStation('departure')}>여기서 출발</Action><Action style={{ flex: 1 }} onPress={() => selectMapStation('arrival')}>여기서 하차</Action></View></>}
    </View></View></Modal>
    <Modal visible={showHelp} transparent animationType="fade" onRequestClose={() => setShowHelp(false)}><View style={styles.overlay}><View style={styles.modal}><Text style={ui.heading}>여기야와 편하게 이동하기</Text><Text style={ui.text}>1. 출발역과 내릴 역을 선택해요.{ '\n\n' }2. 노선과 환승 구간을 확인해요.{ '\n\n' }3. 탑승한 뒤 하차 알림을 켜주세요.</Text><View style={ui.divider} /><Text style={ui.muted}>서울 주요 구간 1~9호선과 신분당선 일부를 지원합니다. 수도권 전체 노선과 급행·시간표는 포함하지 않습니다. 역간 2분, 환승 5분으로 예상하며 실제 운행 상황과 다를 수 있어요.</Text><Text style={ui.muted}>알림은 시간 기준입니다. 열차 지연이나 환승 대기 시간은 반영하지 않으니 현재 역도 함께 확인해주세요. {Platform.OS === 'web' ? '웹에서는 탭을 열어두세요. 절전 상태에서는 알림이 지연될 수 있어요.' : '기기 설정에서 알림과 소리를 허용해주세요.'}</Text><Action onPress={() => setShowHelp(false)}>알겠어요</Action></View></View></Modal>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FAFCFA' },
  header: { minHeight: 78, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: palette.border, paddingHorizontal: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { width: 38, height: 38, borderRadius: 12, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  wordmark: { fontSize: 25, fontWeight: '800', letterSpacing: -1.4, color: palette.ink },
  tagline: { fontSize: 11, color: '#9AA69D', marginLeft: 14 },
  navigation: { flexDirection: 'row', alignSelf: 'stretch', gap: 28 },
  navItem: { paddingHorizontal: 13, justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: 'transparent' },
  navSelected: { borderBottomColor: palette.green },
  navText: { color: '#859086', fontSize: 13 },
  helpButton: { borderWidth: 1, borderColor: palette.border, borderRadius: 9, minHeight: 38, paddingHorizontal: 13, justifyContent: 'center' },
  mobileNav: { flexDirection: 'row', backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: palette.border },
  mobileNavItem: { flex: 1, alignItems: 'center', padding: 15, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  content: { width: '100%', maxWidth: 1540, alignSelf: 'center', padding: 40, gap: 32 },
  intro: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' },
  title: { fontSize: 31, fontWeight: '700', letterSpacing: -1.3, color: palette.ink, lineHeight: 43 },
  seoulTag: { backgroundColor: '#F0F6EE', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', gap: 7, alignItems: 'center' },
  onlineDot: { width: 6, height: 6, borderRadius: 4, backgroundColor: '#5F976C' },
  workspace: { flexDirection: 'row', alignItems: 'flex-start', gap: 28 },
  sidebar: { width: 352, gap: 22 },
  mapColumn: { flex: 1, width: '100%', minWidth: 0, gap: 16 },
  smallPill: { color: palette.green, backgroundColor: palette.tint, fontSize: 10, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 5 },
  swapRow: { flexDirection: 'row', height: 25, justifyContent: 'space-between', alignItems: 'center' },
  connector: { height: 20, borderLeftWidth: 2, borderColor: '#CDDAD0', borderStyle: 'dotted', marginLeft: 20 },
  swap: { minHeight: 36, paddingHorizontal: 5, justifyContent: 'center' },
  options: { flexDirection: 'row', gap: 7 },
  option: { flex: 1, borderWidth: 1, borderColor: palette.border, minHeight: 43, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  optionSelected: { borderColor: '#B5D5BF', backgroundColor: palette.tint },
  restCard: { flexDirection: 'row', gap: 14, padding: 20, backgroundColor: '#EDF3E9', borderRadius: 16, alignItems: 'center' },
  restIcon: { width: 46, height: 54, borderRadius: 20, backgroundColor: '#DFEBDD', alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
  suggestion: { padding: 16, backgroundColor: '#FFF', borderWidth: 1, borderColor: palette.border, borderRadius: 12, gap: 10 },
  journeyRow: { padding: 10, borderBottomWidth: 1, borderBottomColor: palette.border },
  emptyState: { alignItems: 'center', paddingVertical: 32, gap: 16 },
  lineTabs: { gap: 7, paddingVertical: 3 },
  lineTab: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 9, borderWidth: 1, borderColor: palette.border, paddingHorizontal: 11, minHeight: 38, backgroundColor: '#FFF' },
  lineDot: { width: 6, height: 6, borderRadius: 3 },
  mapLabel: { borderWidth: 1, borderColor: '#DDE7DB', borderRadius: 5, padding: 7 },
  stationFilter: { backgroundColor: '#F5F8F5', borderRadius: 7, padding: 9, fontSize: 11, width: 170, color: palette.ink },
  stationChip: { paddingHorizontal: 12, minHeight: 38, justifyContent: 'center', borderWidth: 1, borderColor: '#E6ECE4', backgroundColor: '#F8FAF6', borderRadius: 7 },
  bottomTip: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 5 },
  tipNumber: { backgroundColor: palette.tint, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  footer: { borderTopWidth: 1, borderTopColor: palette.border, flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 19, paddingBottom: 5 },
  overlay: { flex: 1, backgroundColor: '#17372866', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#FFF', width: '100%', maxWidth: 420, borderRadius: 24, padding: 26, gap: 20 },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
});
