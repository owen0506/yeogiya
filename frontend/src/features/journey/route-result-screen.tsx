import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BrowserNotificationPermission } from '../notifications/browser-notification-permission';
import { useAlarm } from '../notifications/use-alarm';
import { getBusCorridorStops, getBusVehicleCandidates, type BusVehicleCandidate } from '../../services/bus-vehicles';
import { getSubwayCorridor, getSubwayVehicleCandidates, type SubwayVehicleCandidate } from '../../services/subway-vehicle-candidates';
import { createJourneyPlan, selectRideVehicle, type JourneyLeg, type JourneyPlan, type RideLeg, type SelectedRide } from '../transit/journey-plan';
import { transitColor } from '../transit/transit-colors';
import type { JourneyRoute } from './route-service';
import { Action, palette, ui } from './journey-ui';
import { VehicleTrack } from './vehicle-track';
import { BusTrack } from './bus-track';
import { canBeOnboardSubwayVehicle, canPlanSubwayVehicle, getObservedSubwayState } from '../transit/subway-ride-state';

type Preference = 'fastest' | 'fewest-transfers';
type Props = {
  stopsBefore?: number;
  preference?: Preference;
  onPreference?: (value: Preference) => void;
  journeyKey?: number | string;
  onRideSelected?: (leg: RideLeg, candidate: LiveCandidate, status: SelectedRide['status']) => void | Promise<void>;
} & (
  { route: JourneyRoute; plan?: JourneyPlan }
  | { route?: never; plan: JourneyPlan }
);
export type LiveCandidate = SubwayVehicleCandidate | BusVehicleCandidate;
type RideSelection = Readonly<{ candidate: LiveCandidate; ride: SelectedRide }>;
type CorridorStop = Readonly<{ stationId: string | null; name: string; relativeStopIndex: number; onLeg: boolean }>;

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '시간 확인 중';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function legName(leg: JourneyLeg): string {
  if (leg.kind === 'RIDE') return leg.mode === 'BUS' ? `${leg.line} 버스` : leg.line;
  if (leg.kind === 'WALK') return '도보';
  if (leg.kind === 'TRANSFER') return '환승';
  return '대기';
}

function legColor(leg: JourneyLeg): string {
  if (leg.kind === 'RIDE') return transitColor(leg.mode, leg.line, leg.routeType ?? undefined);
  if (leg.kind === 'WALK') return '#87958D';
  if (leg.kind === 'TRANSFER') return '#D6DED8';
  return '#E8ECE9';
}

function candidateName(candidate: LiveCandidate): string {
  return candidate.mode === 'BUS' ? `${candidate.vehicleNumber} 버스` : `${candidate.trainId} 열차`;
}

function candidatePlace(candidate: LiveCandidate, leg: RideLeg): string {
  if (candidate.mode === 'BUS') {
    const stop = getBusCorridorStops(leg).find(item =>
      item.serviceSequence === candidate.currentStopSequence && item.providerStopId === candidate.currentStopId);
    const beforeBoard = (leg.boardingSequence ?? leg.from.serviceSequence ?? candidate.currentStopSequence) - candidate.currentStopSequence;
    return `${stop?.name ?? leg.from.name} 기준 위치${beforeBoard > 0
      ? ` · 승차 ${beforeBoard}정류장 전` : beforeBoard === 0 ? ' · 승차 정류장 부근' : ''}`;
  }
  if (candidate.currentStationName) {
    const state = getObservedSubwayState(candidate);
    const corridor = getSubwayCorridor(leg);
    const name = corridor.find(stop => stop.relativeStopIndex === state.index)?.name ?? candidate.currentStationName;
    if (state.segment) {
      const from = corridor.find(stop => stop.relativeStopIndex === state.segment![0])?.name;
      const to = corridor.find(stop => stop.relativeStopIndex === state.segment![1])?.name;
      if (from && to) return `${from} → ${to} ${state.phase === 'ARRIVING' ? '진입 중' : '운행 중'}`;
      return state.phase === 'DEPARTING' ? `${name} 출발 · 다음 역으로 운행 중` : `${name} 도착 전`;
    }
    return state.phase === 'STOPPED' ? `${name} 도착` : `${name} 기준 · 운행 상태 확인 중`;
  }
  if (candidate.etaSeconds !== null) return `${leg.from.name} 약 ${Math.ceil(candidate.etaSeconds / 60)}분 후 도착`;
  return candidate.message ?? '현재 역 확인 중';
}

function canPlan(candidate: LiveCandidate): boolean {
  return candidate.selectable && (candidate.mode === 'BUS' ? candidate.canBoardHere : canPlanSubwayVehicle(candidate));
}

function canBeOnboard(candidate: LiveCandidate, leg: RideLeg): boolean {
  return candidate.selectable && (candidate.mode === 'BUS'
    ? candidate.canBeOnboard
    : canBeOnboardSubwayVehicle(candidate, leg.stops.length));
}

function directionLabel(candidate: SubwayVehicleCandidate, leg: RideLeg) {
  const raw = candidate.direction ?? candidate.positionDirection;
  const direction = raw === '0' ? leg.line === '2호선' ? '내선' : '상행'
    : raw === '1' ? leg.line === '2호선' ? '외선' : '하행' : raw;
  return `${leg.to.name} 방면${direction ? ` · ${direction}` : ''}`;
}

function alarmTiming(leg: RideLeg, candidate: LiveCandidate, status: SelectedRide['status'], leadStops: number) {
  const targetIndex = Math.max(0, leg.stops.length - 1 - leadStops);
  const target = leg.stops[targetIndex];
  const targetOffset = target?.plannedOffsetSeconds;
  if (!target || targetOffset === null) return { target, seconds: null, reason: '이 구간의 알림 시각을 계산할 수 없어요.' };
  if (status === 'PLANNED') {
    if (candidate.etaSeconds === null) {
      return { target, seconds: null, reason: '도착 예정 시각이 없어 탑승 전 알림을 계산할 수 없어요. 탑승 중 위치가 확인되면 다시 설정해주세요.' };
    }
    const fromOffset = candidate.mode === 'BUS' && leg.boardingSequence !== undefined
      ? getBusCorridorStops(leg).find(stop => stop.serviceSequence === leg.boardingSequence)?.plannedOffsetSeconds ?? null
      : leg.from.plannedOffsetSeconds;
    if (fromOffset === null) return { target, seconds: null, reason: '승차역의 예상 시간을 확인할 수 없어요.' };
    const elapsed = candidate.mode === 'BUS' ? Math.max(0,
      (Date.now() - Date.parse(candidate.evidence[0]?.fetchedAt ?? '')) / 1000) : 0;
    const wait = Math.max(0, candidate.etaSeconds - (Number.isFinite(elapsed) ? elapsed : 0));
    return { target, seconds: Math.max(1, Math.ceil(wait + targetOffset - fromOffset)), reason: null };
  }
  const subwayState = candidate.mode === 'SUBWAY' ? getObservedSubwayState(candidate) : null;
  const currentIndex = candidate.mode === 'BUS'
    ? leg.stops.findIndex((stop) => stop.serviceSequence === candidate.currentStopSequence)
    : subwayState?.segment?.[0] ?? subwayState?.index ?? null;
  if (currentIndex === null || currentIndex < 0 || currentIndex >= leg.stops.length) {
    return { target, seconds: null, reason: '선택한 차량의 현재 역을 확인해야 알림 시각을 계산할 수 있어요.' };
  }
  if (currentIndex > targetIndex || (subwayState?.segment && currentIndex === targetIndex)) {
    return { target, seconds: null, reason: '선택한 알림 기준 지점을 이미 지났어요. 더 가까운 알림을 선택해주세요.' };
  }
  const currentOffset = leg.stops[currentIndex].plannedOffsetSeconds;
  if (currentOffset === null) return { target, seconds: null, reason: '현재 위치부터의 예상 시간을 확인할 수 없어요.' };
  const segmentArrival = subwayState?.segmentArrival;
  if (subwayState?.segment && segmentArrival?.seconds != null && segmentArrival.relativeStopIndex === subwayState.segment[1]) {
    const nextOffset = leg.stops[segmentArrival.relativeStopIndex]?.plannedOffsetSeconds;
    if (nextOffset != null) {
      const remaining = Math.max(0, segmentArrival.seconds - Math.max(0, Date.now() - Date.parse(segmentArrival.fetchedAt)) / 1000);
      return { target, seconds: Math.max(1, Math.ceil(remaining + targetOffset - nextOffset)), reason: null };
    }
  }
  return { target, seconds: Math.max(1, Math.ceil(targetOffset - currentOffset)), reason: null };
}

function resolvePlan(route: JourneyRoute | undefined, plan: JourneyPlan | undefined): JourneyPlan {
  if (plan) return plan;
  if (route) return createJourneyPlan(route);
  throw new Error('경로 결과에는 JourneyRoute 또는 JourneyPlan이 필요합니다.');
}

export function RouteResultScreen({ route, plan: suppliedPlan, stopsBefore = 1, preference, onPreference, journeyKey, onRideSelected }: Props) {
  const plan = useMemo(() => resolvePlan(route, suppliedPlan), [route, suppliedPlan]);
  const [expandedLegId, setExpandedLegId] = useState<string | null>(null);
  const [selectedRides, setSelectedRides] = useState<Record<string, RideSelection>>({});
  const [leadStops, setLeadStops] = useState<Record<string, number>>({});
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const resetKey = journeyKey ?? plan;
  const previousKey = useRef<unknown>(null);

  useEffect(() => {
    if (previousKey.current !== resetKey) {
      previousKey.current = resetKey;
      setExpandedLegId(null);
      setSelectedRides({});
      setLeadStops({});
      setSelectionError(null);
      return;
    }
    const rides = plan.legs.filter((leg): leg is RideLeg => leg.kind === 'RIDE');
    setExpandedLegId(previous => rides.some(leg => leg.id === previous) ? previous : null);
    setSelectedRides(previous => {
      const valid = Object.entries(previous).filter(([id, selection]) => {
        const leg = rides.find(item => item.id === id);
        if (!leg || leg.mode !== selection.candidate.mode) return false;
        const candidate = selection.candidate;
        if (candidate.mode !== 'BUS') return true;
        return leg.routeId === candidate.routeId && leg.cityCode === candidate.cityCode
          && (leg.to.serviceSequence ?? 0) > candidate.currentStopSequence
          && getBusCorridorStops(leg).some(stop =>
            stop.serviceSequence === candidate.currentStopSequence && stop.providerStopId === candidate.currentStopId);
      });
      return valid.length === Object.keys(previous).length ? previous : Object.fromEntries(valid);
    });
    setLeadStops(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => rides.some(leg => leg.id === id))));
  }, [plan, resetKey]);

  const refreshSelection = useCallback((leg: RideLeg, candidates: readonly LiveCandidate[]) => {
    setSelectedRides(previous => {
      const selected = previous[leg.id];
      if (!selected) return previous;
      const candidate = candidates.find(item => item.id === selected.candidate.id);
      if (candidate) return { ...previous, [leg.id]: { ...selected, candidate } };
      if (leg.mode !== 'BUS') return previous;
      const remaining = { ...previous };
      delete remaining[leg.id];
      return remaining;
    });
  }, []);

  async function chooseVehicle(leg: RideLeg, candidate: LiveCandidate, status: SelectedRide['status']) {
    const ride = selectRideVehicle(leg, candidate, status);
    setSelectedRides((previous) => ({ ...previous, [leg.id]: { candidate, ride } }));
    setSelectionError(null);
    try { await onRideSelected?.(leg, candidate, status); } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '선택한 차량의 이후 경로를 계산하지 못했어요.');
    }
  }

  const rideCount = plan.legs.filter((leg) => leg.kind === 'RIDE').length;
  const transferCount = plan.transferCount ?? plan.legs.filter((leg) => leg.kind === 'TRANSFER').length;
  const sourceLabel = plan.includesAccessAndWaiting
    ? '도보·승차 대기 포함 · 실제 운행에 따라 달라지는 예상 경로'
    : plan.source === 'OFFICIAL_TIMETABLE'
    ? '공식 시간표 기준 · 첫 탑승 전 대기 제외'
    : plan.source === 'TIMETABLE'
      ? '시간표 기준 · 실시간 지연 미반영'
      : '임시 예상 경로 · 첫 탑승 대기와 실제 운행 미반영';
  const departureAt = plan.departureAt ?? (suppliedPlan ? null : route?.official?.departureAt);
  const arrivalAt = plan.arrivalAt ?? (suppliedPlan ? null : route?.official?.arrivalAt);

  return <View style={styles.result}>
    <View style={[ui.card, styles.summary]}>
      {preference && onPreference && <View style={styles.preferences}>
        {([['fastest', '빠른 경로'], ['fewest-transfers', '최소 환승']] as const).map(([value, label]) =>
          <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: preference === value }} onPress={() => onPreference(value)} style={[styles.preference, preference === value && styles.preferenceActive]}>
            <Text style={[styles.preferenceText, preference === value && styles.preferenceTextActive]}>{label}</Text>
          </Pressable>)}
      </View>}
      <View style={ui.spread}>
        <Text style={styles.totalTime}>{Math.ceil(plan.totalSeconds / 60)}<Text style={styles.minute}>분</Text></Text>
        <Text style={ui.muted}>승차 {rideCount}구간 · 환승 {transferCount}회</Text>
      </View>
      <Text style={ui.muted}>{sourceLabel}</Text>
      {plan.notes?.map((note, index) => <Text key={index} style={styles.verifyText}>{note}</Text>)}
      {selectionError && <Text accessibilityRole="alert" style={styles.notice}>{selectionError}</Text>}
      {departureAt && arrivalAt && <Text style={styles.schedule}>{clock(departureAt)} 출발 → {clock(arrivalAt)} 도착 예정</Text>}
      <Text style={[ui.text, styles.barHint]}>색상 막대에서 구간을 눌러 탈 차량을 선택하세요.</Text>
      <View style={styles.routeBar} accessibilityLabel="전체 여정의 시간 비율">
        {plan.legs.map((leg) => {
          const color = legColor(leg);
          const selected = expandedLegId === leg.id;
          const proportionalStyle = { flexGrow: Math.max(1, leg.planned.durationSeconds ?? 1), flexBasis: 0, minWidth: 0 } as const;
          return leg.kind === 'RIDE'
            ? <Pressable key={leg.id} accessibilityRole="button" accessibilityLabel={`${legName(leg)} ${leg.from.name}에서 ${leg.to.name}까지 ${duration(leg.planned.durationSeconds)} 차량 선택`} accessibilityState={{ expanded: selected }} onPress={() => setExpandedLegId(selected ? null : leg.id)} style={[styles.barHit, proportionalStyle]}>
                <View style={[styles.barSegment, { backgroundColor: color }, selected && styles.barSegmentActive]} />
              </Pressable>
            : <View key={leg.id} accessibilityLabel={`${legName(leg)} ${duration(leg.planned.durationSeconds)}`} style={[styles.barHit, proportionalStyle]}>
                <View style={[styles.barSegment, { backgroundColor: color }]} />
              </View>;
        })}
      </View>
      <Text style={styles.barCaption}>막대 너비는 승차·대기·환승·도보 시간을 포함한 전체 여정의 비율이에요.</Text>
    </View>

    <View style={styles.legList}>
      {plan.legs.map((leg) => {
        const color = legColor(leg);
        const isRide = leg.kind === 'RIDE';
        const selected = isRide ? selectedRides[leg.id] : null;
        return <View key={leg.id} style={[ui.card, styles.legCard, expandedLegId === leg.id && { borderColor: color }]}>
          {isRide
            ? <Pressable accessibilityRole="button" accessibilityLabel={`${legName(leg)} ${leg.from.name}에서 ${leg.to.name}까지 차량 ${expandedLegId === leg.id ? '선택 닫기' : '선택 열기'}`} accessibilityState={{ expanded: expandedLegId === leg.id }} onPress={() => setExpandedLegId(expandedLegId === leg.id ? null : leg.id)} style={styles.legHeader}>
                <View style={[styles.modeMark, { backgroundColor: color }]} />
                <View style={styles.legTitleBlock}>
                  <Text style={styles.legTitle}>{legName(leg)}</Text>
                  <Text style={ui.muted}>{leg.from.name} → {leg.to.name}</Text>
                  {selected && <Text style={styles.chosenLabel}>✓ {candidateName(selected.candidate)} · {selected.ride.status === 'ONBOARD' ? '탑승 중' : '탈 예정'}</Text>}
                </View>
                <View style={styles.legRight}><Text style={styles.legDuration}>{duration(leg.planned.durationSeconds)}</Text><Text style={styles.chevron}>{expandedLegId === leg.id ? '⌃' : '⌄'}</Text></View>
              </Pressable>
            : <View style={styles.legHeader}>
                <View style={[styles.modeMark, { backgroundColor: color }]} />
                <View style={styles.legTitleBlock}><Text style={styles.legTitle}>{legName(leg)}</Text><Text style={ui.muted}>{leg.from.name} → {leg.to.name}</Text></View>
                <Text style={styles.legDuration}>{duration(leg.planned.durationSeconds)}</Text>
              </View>}
          {isRide && expandedLegId === leg.id && <RideLegPanel
            leg={leg}
            color={color}
            selection={selected ?? null}
            onChoose={(candidate, status) => chooseVehicle(leg, candidate, status)}
            onRefreshSelection={refreshSelection}
            leadStops={leadStops[leg.id] ?? stopsBefore}
            onLeadStops={(value) => setLeadStops((previous) => ({ ...previous, [leg.id]: value }))}
          />}
        </View>;
      })}
    </View>
  </View>;
}

function RideLegPanel({ leg, color, selection, onChoose, onRefreshSelection, leadStops, onLeadStops }: {
  leg: RideLeg;
  color: string;
  selection: RideSelection | null;
  onChoose: (candidate: LiveCandidate, status: SelectedRide['status']) => void;
  onRefreshSelection: (leg: RideLeg, candidates: readonly LiveCandidate[]) => void;
  leadStops: number;
  onLeadStops: (value: number) => void;
}) {
  const [candidates, setCandidates] = useState<LiveCandidate[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const alarm = useAlarm();

  useEffect(() => {
    if (leg.mode === 'BUS' && (!leg.providerId || !leg.cityCode || !leg.routeId || leg.from.serviceSequence === null)) {
      setLoadError('이 버스 구간은 노선·정류장 순번 데이터가 없어 실시간 차량을 연결할 수 없어요.');
      return;
    }
    const controller = new AbortController();
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const items = leg.mode === 'SUBWAY'
          ? await getSubwayVehicleCandidates(leg, controller.signal)
          : await getBusVehicleCandidates(leg, controller.signal);
        if (controller.signal.aborted) return;
        setCandidates(items);
        onRefreshSelection(leg, items);
        setUpdatedAt(items[0]?.evidence[0]?.fetchedAt ?? new Date().toISOString());
        setLoadError(null);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '차량 위치를 불러오지 못했어요.');
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [leg, refresh, onRefreshSelection]);

  const corridor: CorridorStop[] = leg.mode === 'SUBWAY'
    ? getSubwayCorridor(leg)
    : getBusCorridorStops(leg).map((stop, index) => ({
        stationId: stop.id,
        name: stop.name,
        relativeStopIndex: stop.serviceSequence !== null && leg.from.serviceSequence !== null
          ? stop.serviceSequence - leg.from.serviceSequence : index,
        onLeg: true,
      }));
  const focused = candidates.find((candidate) => candidate.id === focusedId)
    ?? (selection?.candidate.id === focusedId ? selection.candidate : null);
  const currentSelected = selection ? candidates.find((candidate) => candidate.id === selection.candidate.id) ?? null : null;
  const freshEnough = updatedAt !== null && Date.now() - Date.parse(updatedAt) < 180_000;
  const focusFresh = Boolean(focused && candidates.some(candidate => candidate.id === focused.id)
    && freshEnough && !loadError && !loading);
  const canPlanFocused = !!focused && focusFresh && canPlan(focused);
  const canBeOnboardFocused = !!focused && focusFresh && canBeOnboard(focused, leg);
  const targetTiming = selection && currentSelected
    ? alarmTiming(leg, currentSelected, selection.ride.status, leadStops)
    : null;
  const selectedVehicleId = selection
    ? selection.ride.run.realtimeRunId ?? selection.ride.run.vehicleId ?? selection.ride.candidateId
    : null;
  const activeHere = Boolean(alarm.status === 'active' && alarm.alarm?.context?.legId === leg.id
    && alarm.alarm.context.vehicleId === selectedVehicleId);
  const selectedIdentity = selection ? candidateName(selection.candidate) : null;

  function startAlarm() {
    if (!selection || !currentSelected || !freshEnough || loadError || !targetTiming?.target || targetTiming.seconds === null) return;
    const target = targetTiming.target;
    const vehicleId = currentSelected.run.realtimeRunId ?? currentSelected.run.vehicleId ?? currentSelected.id;
    void alarm.start(leg.to.name, targetTiming.seconds, false, {
      legId: leg.id, mode: leg.mode, vehicleId,
      targetStopId: target.providerStopId ?? target.id,
      targetStopSequence: target.serviceSequence ?? target.sequence,
      basis: currentSelected.matchStatus === 'TIMETABLE_MATCHED'
        && (leg.planned.source === 'OFFICIAL_TIMETABLE' || leg.planned.source === 'TIMETABLE')
        ? 'TIMETABLE' : 'ESTIMATE',
    });
  }

  return <View style={styles.panel}>
    <View style={ui.spread}>
      <View style={styles.panelHeading}><Text style={styles.panelTitle}>이 구간의 {leg.mode === 'BUS' ? '버스' : '열차'} 선택</Text><Text style={ui.muted}>{leg.from.name} → {leg.to.name} 방향의 차량을 확인하세요.</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="차량 위치 새로고침" disabled={loading} onPress={() => setRefresh((value) => value + 1)} style={styles.refreshButton}><Text style={{ color: palette.green, fontSize: 12 }}>{loading ? '확인 중…' : '새로고침 ↻'}</Text></Pressable>
    </View>
    {updatedAt && <Text style={styles.updatedAt}>마지막 조회 {clock(updatedAt)} · 30초마다 새로 확인해요.</Text>}
    {loadError && <Text accessibilityRole="alert" style={styles.notice}>{loadError}</Text>}
    {!loading && !loadError && candidates.length === 0 && <Text style={styles.notice}>지금 이 구간의 방향과 맞는 실시간 차량이 확인되지 않아요. 잠시 후 다시 확인해주세요.</Text>}

    {leg.mode === 'BUS'
      ? <BusTrack leg={leg} candidates={candidates.filter((candidate): candidate is BusVehicleCandidate => candidate.mode === 'BUS')}
          color={color} selectedId={selection?.candidate.id} focusedId={focusedId} onPress={setFocusedId} />
      : <VehicleTrack leg={leg} stops={corridor} candidates={candidates} color={color}
          selectedId={selection?.candidate.id} focusedId={focusedId} onPress={setFocusedId} paused={!!loadError} />}

    {focused && <View style={styles.focusCard}>
      <View style={ui.spread}><Text style={styles.focusTitle}>{candidateName(focused)}</Text><Text style={styles.liveBadge}>{candidates.some((candidate) => candidate.id === focused.id) ? '실시간 조회' : '선택 기록'}</Text></View>
      <Text style={ui.muted}>{candidatePlace(focused, leg)}</Text>
      {focused.mode === 'SUBWAY' && <Text style={ui.muted}>{directionLabel(focused, leg)}{focused.destination ? ` · ${focused.destination}` : ''}</Text>}
      {focused.mode === 'BUS' && <Text style={ui.muted}>{leg.to.name} 방면 · 노선 정류장 순서 확인</Text>}
      {focused.mode === 'BUS' && focused.etaSource === 'POSITION_ESTIMATE' && focused.etaSeconds !== null
        && <Text style={styles.verifyText}>승차 정류장까지 약 {duration(focused.etaSeconds)} · 위치와 거리 기반 구간시간으로 추정해요.</Text>}
      {focused.mode === 'BUS' && focused.canBoardHere && focused.etaSeconds === null
        && <Text style={styles.notice}>이 버스의 승차 예정 시간은 아직 확인되지 않았어요.</Text>}
      {focused.mode === 'BUS' && focused.coveragePartial && <Text style={styles.notice}>전체 노선 중 승차 지점 또는 선택한 버스 주변의 차량만 조회하고 있어요.</Text>}
      <Text style={styles.verifyText}>{focused.mode === 'BUS'
        ? '이 구간의 정류장 순서와 맞는 실제 차량이에요. 표시한 도착 시간은 거리 기반 추정값이에요.'
        : focused.routeDirectionMatched
        ? '이 구간의 방향과 종착역을 확인한 열차예요. 도착 시각은 운행 상황에 따라 달라질 수 있어요.'
        : '차량의 방향과 정차역을 확인해주세요.'}</Text>
      <View style={styles.statusActions}>
        <Pressable accessibilityRole="button" disabled={!canPlanFocused} accessibilityState={{ disabled: !canPlanFocused }} onPress={() => onChoose(focused, 'PLANNED')} style={[styles.statusButton, { borderColor: color }, !canPlanFocused && styles.disabled]}>
          <Text style={styles.statusText}>탈 예정</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={!canBeOnboardFocused} accessibilityState={{ disabled: !canBeOnboardFocused }} onPress={() => onChoose(focused, 'ONBOARD')} style={[styles.statusButton, { borderColor: color }, !canBeOnboardFocused && styles.disabled]}>
          <Text style={styles.statusText}>지금 타고 있어요</Text>
        </Pressable>
      </View>
    </View>}

    {selection && <View style={[styles.selectedCard, { borderColor: color }]}>
      <Text style={styles.selectedEyebrow}>✓ 선택한 {leg.mode === 'BUS' ? '버스' : '열차'} · {selection.ride.status === 'ONBOARD' ? '탑승 중' : '탈 예정'}</Text>
      <Text style={styles.selectedTitle}>{selectedIdentity} → {leg.to.name} 하차</Text>
      {!currentSelected && <Text style={styles.notice}>이 차량이 최신 실시간 목록에서 확인되지 않아요. 다시 조회한 뒤 알림을 설정해주세요.</Text>}
      {currentSelected && (!freshEnough || loadError) && <Text style={styles.notice}>최근 차량 위치 조회에 실패했어요. 새로고침 후 알림을 설정해주세요.</Text>}
      <Text style={styles.verifyText}>{leg.mode === 'BUS' ? '버스 하차 알림은 차량의 정류장 기준 위치와 거리 기반 구간시간을 사용한 예상 알림이에요.'
        : '선택한 차량과 추천 시간표의 운행 일치는 확인되지 않았어요.'}</Text>
      <Text style={styles.subheading}>언제 알려드릴까요?</Text>
      <View style={styles.leadOptions}>{[1, 2, 3].filter((count) => count < leg.stops.length).map((count) => <Pressable key={count} accessibilityRole="radio" accessibilityState={{ checked: leadStops === count }} onPress={() => onLeadStops(count)} style={[styles.leadOption, leadStops === count && { borderColor: color, backgroundColor: '#F2F8F3' }]}><Text style={[styles.leadText, leadStops === count && { color: palette.ink, fontWeight: '700' }]}>{count}개 {leg.mode === 'BUS' ? '정류장' : '역'} 전</Text></Pressable>)}</View>
      {targetTiming?.target && <Text style={ui.muted}>알림 기준: {targetTiming.target.name}</Text>}
      {targetTiming?.seconds !== null && targetTiming?.seconds !== undefined && <Text style={styles.alarmEstimate}>약 {duration(targetTiming.seconds)} 뒤 알림 예정</Text>}
      {targetTiming?.reason && <Text style={styles.notice}>{targetTiming.reason}</Text>}
      <Text style={styles.alarmCaveat}>차량 위치와 구간 예상시간으로 계산해요. 이후 실시간 지연이 알림 시각에 자동 반영되지는 않아요.</Text>
      {alarm.error && <Text accessibilityRole="alert" style={styles.notice}>{alarm.error}</Text>}
      {activeHere && <Text style={styles.alarmEstimate}>이 구간의 알림이 켜져 있어요. 알림 메뉴에서 관리할 수 있어요.</Text>}
      <Action disabled={alarm.busy || alarm.status === 'active' || !currentSelected || !freshEnough || !!loadError || targetTiming?.seconds == null} onPress={startAlarm}>{alarm.busy ? '알림 설정 중…' : activeHere ? '알림이 켜져 있어요' : alarm.status === 'active' ? '다른 알림이 켜져 있어요' : '하차 알림 설정'}</Action>
      <BrowserNotificationPermission />
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  result: { gap: 16 },
  summary: { gap: 14 },
  preferences: { alignSelf: 'flex-start', flexDirection: 'row', backgroundColor: '#F3F6F2', borderRadius: 9, padding: 4, gap: 2 },
  preference: { paddingHorizontal: 11, minHeight: 34, justifyContent: 'center', borderRadius: 7 },
  preferenceActive: { backgroundColor: '#FFF' },
  preferenceText: { fontSize: 11, color: palette.muted, fontWeight: '600' },
  preferenceTextActive: { color: palette.green, fontWeight: '700' },
  totalTime: { fontSize: 32, color: palette.ink, fontWeight: '800', letterSpacing: -1 },
  minute: { fontSize: 17, fontWeight: '600' },
  schedule: { color: palette.green, fontSize: 12, fontWeight: '700' },
  barHint: { fontWeight: '600', fontSize: 13 },
  routeBar: { flexDirection: 'row', gap: 3, height: 44, alignItems: 'center' },
  barHit: { height: 44, justifyContent: 'center' },
  barSegment: { height: 12, borderRadius: 7 },
  barSegmentActive: { height: 18, borderWidth: 2, borderColor: palette.ink },
  barCaption: { color: palette.muted, fontSize: 10 },
  legList: { gap: 10 },
  legCard: { padding: 16, gap: 0 },
  legHeader: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 12 },
  modeMark: { width: 7, alignSelf: 'stretch', borderRadius: 4 },
  legTitleBlock: { flex: 1, gap: 3 },
  legTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  legRight: { alignItems: 'flex-end', gap: 1 },
  legDuration: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  chevron: { color: palette.muted, fontSize: 18 },
  chosenLabel: { color: palette.green, fontSize: 11, fontWeight: '700' },
  panel: { borderTopWidth: 1, borderTopColor: palette.border, marginTop: 14, paddingTop: 18, gap: 16 },
  panelHeading: { flex: 1, gap: 4 },
  panelTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  refreshButton: { minHeight: 38, paddingHorizontal: 8, justifyContent: 'center' },
  updatedAt: { color: palette.muted, fontSize: 11 },
  notice: { color: '#9A5B3A', fontSize: 12, lineHeight: 19 },
  subheading: { color: palette.ink, fontSize: 12, fontWeight: '700' },
  focusCard: { backgroundColor: '#F7F9F7', borderRadius: 12, padding: 14, gap: 9 },
  focusTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  liveBadge: { backgroundColor: '#E7F4EA', color: palette.green, fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  verifyText: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  statusActions: { flexDirection: 'row', gap: 8 },
  statusButton: { flex: 1, minHeight: 42, borderWidth: 1, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF', paddingHorizontal: 5 },
  statusText: { color: palette.ink, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: .35 },
  selectedCard: { backgroundColor: '#F7FBF7', borderWidth: 2, borderRadius: 14, padding: 16, gap: 11 },
  selectedEyebrow: { color: palette.green, fontSize: 11, fontWeight: '800' },
  selectedTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  leadOptions: { flexDirection: 'row', gap: 7 },
  leadOption: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: palette.border, borderRadius: 8, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center' },
  leadText: { color: palette.muted, fontSize: 11 },
  alarmEstimate: { color: palette.green, fontSize: 12, fontWeight: '700' },
  alarmCaveat: { color: palette.muted, fontSize: 10, lineHeight: 16 },
});
