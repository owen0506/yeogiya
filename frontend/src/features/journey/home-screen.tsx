import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StationSearchField } from '../stations/station-search-field';
import type { Station, StationFieldValue } from '../stations/stations';
import stationLocationData from '../stations/station-locations.json';
import { findNearbyStations, formatNearbyDistance } from '../stations/nearby-stations';
import { CurrentLocationError, getCurrentLocation } from '../../services/current-location';
import { AlarmStatus } from '../notifications/alarm-status';
import { AlarmDialog } from '../notifications/alarm-dialog';
import { useAlarm } from '../notifications/use-alarm';
import { getOfficialRoute } from '../../services/official-route';
import { loadSegmentTimes } from '../../services/segment-times';
import { findRoute, type JourneyRoute } from './route-service';
import { defaultRouteCostProvider } from './route-costs';
import { RouteResultScreen, type LiveCandidate } from './route-result-screen';
import { createJourneyPlan, type JourneyPlan, type JourneyStop, type RideLeg, type SelectedRide } from '../transit/journey-plan';
import { findGunpoJourney, type GunpoNetwork, type GunpoArrivalSnapshot, type GunpoFixedBus } from '../transit/gunpo-routing';
import { estimateGunpoRideSeconds, getGunpoArrivals, getGunpoNetwork } from '../../services/gunpo-bus';
import { Action, palette, TrainIcon, ui } from './journey-ui';

const empty: StationFieldValue = { query: '', station: null };
type Tab = 'search' | 'route' | 'alarms';
type EndpointField = 'departure' | 'arrival';
type LocationIssue = Readonly<{ message: string; canOpenSettings: boolean }>;
const tabs: readonly { id: Tab; label: string }[] = [
  { id: 'search', label: '길찾기' },
  { id: 'route', label: '내 여정' },
  { id: 'alarms', label: '알림' },
];

function fieldCoordinate(field: StationFieldValue) {
  if (field.currentLocation) return { latitude: field.currentLocation.latitude, longitude: field.currentLocation.longitude };
  return stationLocationData.points.find(point => point.stationId === field.station?.id) ?? null;
}

function withDestinationWalk(plan: JourneyPlan, field: StationFieldValue): JourneyPlan {
  if (!field.currentLocation || !field.station || field.currentLocation.distanceMeters < 10) return plan;
  const seconds = Math.ceil(field.currentLocation.distanceMeters * 1.25 / 1.2);
  const previous = plan.legs.at(-1)?.to;
  const from: JourneyStop = previous ?? { id: field.station.id, name: field.station.name, platformId: null,
    providerStopId: null, serviceSequence: null, sequence: 0, plannedOffsetSeconds: 0 };
  const to: JourneyStop = { id: 'current-location:destination', name: '내 위치', platformId: null,
    providerStopId: null, serviceSequence: null, sequence: 1, plannedOffsetSeconds: seconds };
  const departureAt = plan.arrivalAt ?? null;
  const arrivalAt = departureAt ? new Date(Date.parse(departureAt) + seconds * 1000).toISOString() : null;
  return { ...plan, totalSeconds: plan.totalSeconds + seconds, arrivalAt, source: 'ESTIMATE',
    notes: [...(plan.notes ?? []), '목적지까지 도보 시간은 직선 거리에 여유를 더한 추정값이에요.'],
    legs: [...plan.legs, { id: `walk:destination:${field.station.id}`, kind: 'WALK', from, to,
      planned: { startOffsetSeconds: plan.totalSeconds, endOffsetSeconds: plan.totalSeconds + seconds,
        durationSeconds: seconds, departureAt, arrivalAt, source: 'ESTIMATE' } }] };
}

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= 900;
  const [tab, setTab] = useState<Tab>('search');
  const [departure, setDeparture] = useState<StationFieldValue>(empty);
  const [arrival, setArrival] = useState<StationFieldValue>(empty);
  const [locatingField, setLocatingField] = useState<EndpointField | null>(null);
  const [locationIssues, setLocationIssues] = useState<Partial<Record<EndpointField, LocationIssue>>>({});
  const locationRequest = useRef<{ field: EndpointField; id: number } | null>(null);
  const nextLocationRequest = useRef(0);
  const [activeField, setActiveField] = useState<'departure' | 'arrival' | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [searchViewportHeight, setSearchViewportHeight] = useState(0);
  const [stopsBefore] = useState(1);
  const [route, setRoute] = useState<JourneyRoute | null>(null);
  const [journeyPlan, setJourneyPlan] = useState<JourneyPlan | null>(null);
  const [includeGunpoBuses, setIncludeGunpoBuses] = useState(true);
  const [journeyKey, setJourneyKey] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const gunpoNetwork = useRef<GunpoNetwork | null>(null);
  const gunpoSearch = useRef<{ origin: { latitude: number; longitude: number; name: string; stationId?: string; connectionStationId?: string; isCurrentLocation: boolean }; destination: Station; network: GunpoNetwork; arrivals: readonly GunpoArrivalSnapshot[]; preference: 'fastest' | 'fewest-transfers' } | null>(null);
  const reconnectRequest = useRef<AbortController | null>(null);
  const [preference, setPreference] = useState<'fastest' | 'fewest-transfers'>('fastest');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const routeRequest = useRef<AbortController | null>(null);
  const costProvider = useRef(defaultRouteCostProvider);
  const pageRef = useRef<ScrollView>(null);
  const searchLayout = useRef({ cardTop: 0, fieldsTop: 0, departureTop: 0, arrivalTop: 0 });
  const focusFrame = useRef<number | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alarm = useAlarm();

  useEffect(() => () => {
    routeRequest.current?.abort();
    reconnectRequest.current?.abort();
    locationRequest.current = null;
  }, []);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => {
      setKeyboardVisible(false);
      setActiveField(null);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => () => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadSegmentTimes(controller.signal).then((provider) => {
      if (!controller.signal.aborted) costProvider.current = provider;
    });
    return () => controller.abort();
  }, []);

  const sameStation = departure.station != null && departure.station.id === arrival.station?.id;
  const canSearch = Boolean((departure.station || departure.currentLocation) && arrival.station
    && (!sameStation || departure.currentLocation) && locatingField === null);
  const hasJourney = !!(route || journeyPlan);
  const hideBottomNav = keyboardVisible || activeField !== null;
  const resultsMaxHeight = Math.max(96, Math.min(320, searchViewportHeight - 100));

  function finishEditing() {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    blurTimer.current = null;
    focusFrame.current = null;
    setActiveField(null);
    Keyboard.dismiss();
  }

  function focusField(field: 'departure' | 'arrival') {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = null;
    if (activeField === field) return;
    setActiveField(field);
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    // Wait for the extra scroll space and the previous field's results to update.
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = requestAnimationFrame(() => {
        const layout = searchLayout.current;
        const top = layout.cardTop + layout.fieldsTop + (field === 'departure' ? layout.departureTop : layout.arrivalTop);
        pageRef.current?.scrollTo({ y: Math.max(0, top - 12), animated: true });
        focusFrame.current = null;
      });
    });
  }

  function blurField(field: 'departure' | 'arrival') {
    if (Platform.OS !== 'web') return;
    // Let a candidate press complete before the browser removes its results.
    blurTimer.current = setTimeout(() => {
      setActiveField((current) => current === field ? null : current);
      blurTimer.current = null;
    }, 150);
  }

  function selectTab(next: Tab) {
    finishEditing();
    setTab(next);
    pageRef.current?.scrollTo({ y: 0, animated: true });
  }

  function cancelRoute() {
    routeRequest.current?.abort();
    routeRequest.current = null;
    setRouteLoading(false);
    reconnectRequest.current?.abort();
    reconnectRequest.current = null;
    setReconnecting(false);
    gunpoSearch.current = null;
  }

  function cancelLocation(field?: EndpointField) {
    if (field && locationRequest.current?.field !== field) return;
    locationRequest.current = null;
    setLocatingField(null);
  }

  function updateField(field: 'departure' | 'arrival', value: StationFieldValue) {
    cancelRoute();
    cancelLocation(field);
    setLocationIssues((previous) => ({ ...previous, [field]: undefined }));
    (field === 'departure' ? setDeparture : setArrival)(value);
    setRoute(null);
    setJourneyPlan(null);
    setRouteError(null);
  }

  function swapStations() {
    cancelRoute();
    cancelLocation();
    setLocationIssues({});
    setDeparture(arrival);
    setArrival(departure);
    setRoute(null);
    setJourneyPlan(null);
    setRouteError(null);
    finishEditing();
  }

  async function useCurrentLocation(field: EndpointField) {
    finishEditing();
    cancelRoute();
    const request = { field, id: ++nextLocationRequest.current };
    locationRequest.current = request;
    setLocatingField(field);
    setLocationIssues((previous) => ({ ...previous, [field]: undefined }));
    try {
      const position = await getCurrentLocation();
      if (locationRequest.current !== request) return;
      if (position.accuracyMeters !== null && position.accuracyMeters > 1000) {
        throw new Error('위치 오차가 커서 가까운 역을 고르기 어려워요. 정확한 위치를 켜거나 야외에서 다시 눌러주세요.');
      }
      const nearbyStations = findNearbyStations(position, stationLocationData.points);
      const nearest = nearbyStations[0];
      if (!nearest && field === 'arrival') throw new Error('현재 위치 3km 안에서 지원하는 지하철역을 찾지 못했어요. 역을 직접 검색해주세요.');
      updateField(field, {
        query: '내 위치', station: nearest?.station ?? null, nearbyStations,
        currentLocation: { ...position, distanceMeters: nearest?.distanceMeters ?? 0 },
      });
    } catch (error) {
      if (locationRequest.current !== request) return;
      setLocationIssues((previous) => ({ ...previous, [field]: {
        message: error instanceof Error ? error.message : '현재 위치를 확인하지 못했어요. 다시 눌러주세요.',
        canOpenSettings: error instanceof CurrentLocationError && error.canOpenSettings,
      } }));
    } finally {
      if (locationRequest.current === request) {
        locationRequest.current = null;
        setLocatingField(null);
      }
    }
  }

  async function openLocationSettings(field: EndpointField) {
    try { await Linking.openSettings(); }
    catch {
      setLocationIssues((previous) => ({ ...previous, [field]: {
        message: '설정 앱에서 여기야 또는 Expo Go의 위치 접근을 허용해주세요.', canOpenSettings: false,
      } }));
    }
  }

  function locationProps(field: EndpointField) {
    return {
      onUseCurrentLocation: () => void useCurrentLocation(field),
      locating: locatingField === field,
      locationBusy: locatingField !== null,
      locationError: locationIssues[field]?.message,
      onOpenSettings: locationIssues[field]?.canOpenSettings ? () => void openLocationSettings(field) : undefined,
    };
  }

  async function subwayAt(from: Station, to: Station, selectedPreference: 'fastest' | 'fewest-transfers', signal?: AbortSignal, departureAt?: string) {
    try { return await getOfficialRoute(from, to, selectedPreference, signal, departureAt); }
    catch {
      if (signal?.aborted) throw new Error('경로 검색이 취소됐어요.');
      return findRoute(from.id, to.id, selectedPreference, costProvider.current);
    }
  }

  async function searchRoute(from: Station | null = departure.station, to: Station | null = arrival.station, selectedPreference = preference) {
    if (!to || (!from && !departure.currentLocation) || (from?.id === to.id && !departure.currentLocation)) return;
    finishEditing();
    cancelRoute();
    const controller = new AbortController();
    routeRequest.current = controller;
    setRoute(null);
    setJourneyPlan(null);
    setRouteError(null);
    setRouteLoading(true);
    let result: JourneyRoute | null = null;
    let resultPlan: JourneyPlan | null = null;
    try {
      const coordinate = fieldCoordinate(departure);
      const pilotStation = from && ['station-금정', 'station-산본', 'station-군포', 'station-당정', 'station-수리산', 'station-대야미'].includes(from.id);
      if (coordinate && (departure.currentLocation || (includeGunpoBuses && pilotStation))) {
        const origin = { latitude: coordinate.latitude, longitude: coordinate.longitude,
          name: departure.currentLocation ? '내 위치' : from!.name, stationId: from?.id,
          connectionStationId: departure.currentLocation?.connectionStationSelected ? from?.id : undefined,
          isCurrentLocation: !!departure.currentLocation };
        let network: GunpoNetwork = { providerId: 'tago', cityCode: '31160', fetchedAt: new Date().toISOString(), routes: [] };
        let arrivals: readonly GunpoArrivalSnapshot[] = [];
        let notice: string | null = null;
        if (includeGunpoBuses) {
          try {
            network = gunpoNetwork.current ?? await getGunpoNetwork(controller.signal);
            gunpoNetwork.current = network;
            const live = await getGunpoArrivals(network, origin, controller.signal);
            arrivals = live.snapshots;
            if (live.failed) notice = '일부 버스 도착정보를 확인하지 못해 확인 가능한 경로만 비교했어요.';
          } catch {
            if (controller.signal.aborted) return;
            notice = '군포 버스 정보를 확인하지 못해 지하철 연결을 먼저 안내해요.';
          }
        }
        resultPlan = await findGunpoJourney({ origin, destination: to, network, arrivals,
          departureAt: new Date().toISOString(), preference: selectedPreference, signal: controller.signal,
          getSubwayRoute: subwayAt, rideSeconds: estimateGunpoRideSeconds, stationCoordinates: stationLocationData.points });
        if (resultPlan) {
          resultPlan = withDestinationWalk(resultPlan, arrival);
          gunpoSearch.current = { origin, destination: to, network, arrivals, preference: selectedPreference };
          if (notice) resultPlan = { ...resultPlan, notes: [...(resultPlan.notes ?? []), notice] };
        }
      }
      if (!resultPlan && !departure.currentLocation && from && from.id !== to.id) {
        result = await subwayAt(from, to, selectedPreference, controller.signal);
        if (!result?.official && result) setRouteError('공식 시간표를 확인하지 못해 임시 예상값으로 안내해요.');
        if (result && arrival.currentLocation) {
          resultPlan = withDestinationWalk({ ...createJourneyPlan(result),
            arrivalAt: result.official?.arrivalAt, departureAt: result.official?.departureAt }, arrival);
        }
      }
      if (!result && !resultPlan) setRouteError('이 위치에서 연결할 경로를 찾지 못했어요. 출발역을 직접 선택하거나 위치를 새로 확인해주세요.');
    } catch (error) {
      if (!controller.signal.aborted) setRouteError(error instanceof Error ? error.message : '경로를 확인하지 못했어요. 다시 검색해주세요.');
    }
    if (controller.signal.aborted || routeRequest.current !== controller) return;
    routeRequest.current = null;
    setRouteLoading(false);
    setRoute(result);
    setJourneyPlan(resultPlan);
    setJourneyKey(previous => previous + 1);
    if (result || resultPlan) selectTab('route');
    else selectTab('search');
  }

  async function reconnectAfterSelection(leg: RideLeg, candidate: LiveCandidate, status: SelectedRide['status']) {
    const context = gunpoSearch.current;
    if (!context || candidate.mode !== 'BUS' || !leg.routeId || leg.from.serviceSequence === null || leg.to.serviceSequence === null) return;
    const fetchedAt = candidate.evidence[0]?.fetchedAt;
    if (!fetchedAt || Date.now() - Date.parse(fetchedAt) > 90_000) throw new Error('버스 위치가 오래됐어요. 새로고침한 뒤 선택해주세요.');
    const common = { legId: leg.id, routeId: leg.routeId, boardSequence: leg.boardingSequence ?? leg.from.serviceSequence,
      alightSequence: leg.to.serviceSequence, vehicleNumber: candidate.vehicleNumber };
    let fixedBus: GunpoFixedBus;
    if (status === 'ONBOARD') {
      fixedBus = { ...common, status, currentSequence: candidate.currentStopSequence, observedAt: new Date().toISOString() };
    } else {
      if (candidate.etaSeconds === null) throw new Error('이 차량의 승차 시각을 추정할 수 없어요. 탑승한 뒤 선택해주세요.');
      fixedBus = { ...common, status, departureAt: new Date(Date.parse(fetchedAt) + candidate.etaSeconds * 1000).toISOString() };
    }
    reconnectRequest.current?.abort();
    const controller = new AbortController();
    reconnectRequest.current = controller;
    setReconnecting(true);
    try {
      const nextPlan = await findGunpoJourney({ ...context, departureAt: new Date().toISOString(),
        signal: controller.signal, fixedBus, getSubwayRoute: subwayAt,
        rideSeconds: estimateGunpoRideSeconds, stationCoordinates: stationLocationData.points });
      if (controller.signal.aborted || reconnectRequest.current !== controller) return;
      if (!nextPlan) throw new Error('선택한 버스로 이어지는 경로를 확인하지 못했어요. 위치를 새로고침하거나 다른 차량을 선택해주세요.');
      setJourneyPlan(withDestinationWalk({ ...nextPlan, notes: [...(nextPlan.notes ?? []),
        '선택한 버스 위치와 추정 이동시간으로 이후 지하철 연결을 다시 계산했어요.'] }, arrival));
    } catch (error) {
      if (controller.signal.aborted || reconnectRequest.current !== controller) return;
      throw error;
    } finally {
      if (reconnectRequest.current === controller) { reconnectRequest.current = null; setReconnecting(false); }
    }
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
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top}>
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
        onLayout={(event) => setSearchViewportHeight(event.nativeEvent.layout.height)}
        contentContainerStyle={[styles.content, wide ? styles.contentWide : styles.contentMobile, activeField !== null && { paddingBottom: searchViewportHeight }]}
        keyboardDismissMode="none"
        keyboardShouldPersistTaps="handled">
        {tab === 'search' && <>
          <View style={styles.intro}>
            <Text style={ui.eyebrow}>YOUR NEXT STOP, A LITTLE MORE COMFORTABLE</Text>
            <Text accessibilityRole="header" style={styles.title}>내릴 걱정은 내려놓고,{'\n'}편하게 가요.</Text>
            <Text style={ui.muted}>역을 검색하거나 내 위치에서 시작해보세요.</Text>
          </View>
          <View onLayout={(event) => { searchLayout.current.cardTop = event.nativeEvent.layout.y; }} style={[ui.card, styles.searchCard]}>
            <View style={ui.spread}>
              <View style={ui.row}><TrainIcon size={22} /><Text style={ui.heading}>어디로 갈까요?</Text></View>
              <Text style={styles.smallPill}>{includeGunpoBuses ? '군포 버스 · 지하철' : '지하철'}</Text>
            </View>
            <Pressable accessibilityRole="switch" accessibilityLabel="군포 버스 30·31번 포함" accessibilityState={{ checked: includeGunpoBuses }}
              onPress={() => { cancelRoute(); setIncludeGunpoBuses(value => !value); setRoute(null); setJourneyPlan(null); setRouteError(null); }} style={styles.busOption}>
              <View style={[styles.optionSwitch, includeGunpoBuses && { backgroundColor: palette.green }]}><View style={[styles.optionThumb, includeGunpoBuses && { alignSelf: 'flex-end' }]} /></View>
              <View style={{ flex: 1, gap: 3 }}><Text style={styles.optionTitle}>군포 버스도 함께 찾기</Text><Text style={ui.muted}>30·31번 시범 연결 · 금정·산본역 환승</Text></View>
            </Pressable>
            <View onLayout={(event) => { searchLayout.current.fieldsTop = event.nativeEvent.layout.y; }} style={styles.fields}>
              <View onLayout={(event) => { searchLayout.current.departureTop = event.nativeEvent.layout.y; }}>
                <StationSearchField label="출발역" value={departure} onChange={(value) => updateField('departure', value)} active={activeField === 'departure'} onFocus={() => focusField('departure')} onBlur={() => blurField('departure')} onSelect={finishEditing} resultsMaxHeight={resultsMaxHeight} {...locationProps('departure')} />
              </View>
              <View style={styles.swapRow}>
                <View style={styles.connector} />
                <Pressable accessibilityRole="button" accessibilityLabel="출발역과 도착역 바꾸기" onPress={swapStations} style={styles.swap}>
                  <Text style={styles.swapText}>↕ 출발·도착 바꾸기</Text>
                </Pressable>
              </View>
              <View onLayout={(event) => { searchLayout.current.arrivalTop = event.nativeEvent.layout.y; }}>
                <StationSearchField label="도착역" value={arrival} onChange={(value) => updateField('arrival', value)} active={activeField === 'arrival'} onFocus={() => focusField('arrival')} onBlur={() => blurField('arrival')} onSelect={finishEditing} resultsMaxHeight={resultsMaxHeight} {...locationProps('arrival')} />
              </View>
            </View>
            {(departure.currentLocation || arrival.currentLocation) && <View style={{ gap: 5 }}>
              <Text style={ui.muted}>{includeGunpoBuses ? '내 위치 주변 정류장과 역을 비교해요. 버스·도보 시간은 거리 기반 추정이며 실제 길과 다를 수 있어요.' : '내 위치에서 역까지 걷는 시간을 추정해 지하철에 연결해요.'}</Text>
              <Text style={styles.locationSource}>역 위치 정보: 서울특별시 · 서울시 역사마스터 정보</Text>
            </View>}
            {sameStation && !departure.currentLocation && <Text accessibilityRole="alert" style={styles.validation}>출발역과 내릴 역을 다르게 선택해주세요.</Text>}
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
            {hasJourney && <Text style={ui.muted}>{departure.currentLocation ? '내 위치' : departure.station?.name} → {arrival.currentLocation ? '내 위치' : arrival.station?.name}</Text>}
            {reconnecting && <Text accessibilityLiveRegion="polite" style={ui.muted}>선택한 버스에 맞춰 이후 지하철을 다시 확인하고 있어요…</Text>}
          </View>
          {!hasJourney && <View style={[ui.card, styles.emptyState]}>
            <TrainIcon size={38} />
            <Text style={ui.heading}>{routeLoading ? '경로를 다시 확인하고 있어요' : '아직 선택한 여정이 없어요'}</Text>
            <Text style={ui.muted}>출발역과 내릴 역을 고르면 여기에 경로가 표시돼요.</Text>
            {!routeLoading && <Action secondary onPress={() => selectTab('search')}>길찾기</Action>}
          </View>}
        </>}

        {hasJourney && <View style={tab === 'route' ? undefined : styles.hidden}>
          {!journeyPlan && (departure.currentLocation || arrival.currentLocation) && <View style={[ui.card, styles.locationConnection]}>
            <Text style={styles.connectionTitle}>내 위치 연결</Text>
            {departure.currentLocation && <Text style={ui.text}>내 위치 → {departure.station?.name} · 직선 약 {formatNearbyDistance(departure.currentLocation.distanceMeters)}</Text>}
            {arrival.currentLocation && <Text style={ui.text}>{arrival.station?.name} → 내 위치 · 직선 약 {formatNearbyDistance(arrival.currentLocation.distanceMeters)}</Text>}
            <Text style={ui.muted}>아래 시간은 지하철 구간 기준이에요. 역과 내 위치 사이의 도보 경로·시간은 포함되지 않아요.</Text>
            <Text style={styles.locationSource}>역 위치 정보: 서울특별시 · 서울시 역사마스터 정보</Text>
          </View>}
          <RouteResultScreen
            {...(journeyPlan ? { plan: journeyPlan } : { route: route! })}
            journeyKey={journeyKey}
            onRideSelected={reconnectAfterSelection}
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
            <Action secondary onPress={() => selectTab(hasJourney ? 'route' : 'search')}>{hasJourney ? '내 여정 보기' : '길찾기'}</Action>
          </View>}
        </>}
      </ScrollView>

      {!wide && !hideBottomNav && <View style={[styles.bottomNav, { paddingBottom: Math.max(insets.bottom, 10) }]}>{navigation}</View>}
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
  busOption: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  optionTitle: { fontSize: 13, fontWeight: '700', color: palette.ink },
  optionSwitch: { width: 38, height: 23, padding: 3, borderRadius: 13, backgroundColor: '#D6DED8' },
  optionThumb: { width: 17, height: 17, borderRadius: 9, backgroundColor: '#FFF', alignSelf: 'flex-start' },
  fields: { gap: 9 },
  swapRow: { flexDirection: 'row', height: 25, justifyContent: 'space-between', alignItems: 'center' },
  connector: { height: 20, borderLeftWidth: 2, borderColor: '#CDDAD0', borderStyle: 'dotted', marginLeft: 20 },
  swap: { minHeight: 36, paddingHorizontal: 5, justifyContent: 'center' },
  swapText: { color: '#6B7E72', fontSize: 12 },
  validation: { color: '#BE6841', fontSize: 12 },
  sectionHeading: { gap: 7, paddingHorizontal: 2 },
  sectionTitle: { fontSize: 28, fontWeight: '700', letterSpacing: -1, color: palette.ink },
  emptyState: { alignItems: 'center', paddingVertical: 38, gap: 14 },
  locationConnection: { gap: 7, marginBottom: 16 },
  locationSource: { fontSize: 10, lineHeight: 16, color: palette.muted },
  connectionTitle: { fontSize: 14, fontWeight: '700', color: palette.green },
  hidden: { display: 'none' },
});
