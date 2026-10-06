import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusVehicleCandidate } from '../../services/bus-vehicles';
import type { SubwayCorridorStop, SubwayVehicleCandidate } from '../../services/subway-vehicle-candidates';
import type { RideLeg } from '../transit/journey-plan';
import { VehicleAsset } from '../transit/vehicle-asset';
import { getVehicleMotion, type VehicleMotion } from '../transit/vehicle-motion';
import { palette } from './journey-ui';

type Candidate = SubwayVehicleCandidate | BusVehicleCandidate;
export type TrackStop = SubwayCorridorStop;
const STOP_GAP = 128;
const MARKER_WIDTH = 94;
const RAIL_Y = 56;

function vehicleName(candidate: Candidate) {
  return candidate.mode === 'BUS' ? `${candidate.vehicleNumber} 버스` : `${candidate.trainId} 열차`;
}

function coordinate(stops: readonly TrackStop[], relative: number | null): number | null {
  if (relative === null || !Number.isFinite(relative) || !stops.length) return null;
  if (relative < stops[0].relativeStopIndex || relative > stops[stops.length - 1].relativeStopIndex) return null;
  for (let i = 0; i < stops.length; i++) {
    if (relative === stops[i].relativeStopIndex) return (i + .5) * STOP_GAP;
    const next = stops[i + 1];
    if (next && relative > stops[i].relativeStopIndex && relative < next.relativeStopIndex) {
      return (i + .5 + (relative - stops[i].relativeStopIndex) / (next.relativeStopIndex - stops[i].relativeStopIndex)) * STOP_GAP;
    }
  }
  return null;
}

function motionLocation(stops: readonly TrackStop[], relative: number | null): string {
  if (relative === null) return '위치 확인 중';
  const station = stops.find(stop => stop.relativeStopIndex === relative);
  if (station) return station.name;
  for (let index = 0; index < stops.length - 1; index++) {
    if (relative > stops[index].relativeStopIndex && relative < stops[index + 1].relativeStopIndex) {
      return `${stops[index].name} → ${stops[index + 1].name}`;
    }
  }
  return '위치 확인 중';
}

export function VehicleChip({ candidate, selected, focused, color, onPress }: {
  candidate: Candidate; selected: boolean; focused: boolean; color: string; onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${vehicleName(candidate)} 선택`} accessibilityState={{ selected }} onPress={onPress}
    style={[styles.chip, { borderColor: selected || focused ? color : palette.border }, selected && styles.selectedChip]}>
    <Text style={[styles.number, { color: selected ? color : palette.ink }]} numberOfLines={1}>{selected ? '✓ ' : ''}{candidate.mode === 'BUS' ? candidate.vehicleNumber : candidate.trainId}</Text>
    <VehicleAsset mode={candidate.mode} color={color} width={72} />
  </Pressable>;
}

export function VehicleTrack({ leg, stops, candidates, color, selectedId, focusedId, onPress, paused }: {
  leg: RideLeg; stops: readonly TrackStop[]; candidates: readonly Candidate[]; color: string;
  selectedId?: string; focusedId: string | null; onPress: (id: string) => void; paused: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const [reduceMotion, setReduceMotion] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const history = useRef(new Map<string, VehicleMotion>());
  const frozen = paused || !foreground;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      if (state === 'active') setNow(Date.now());
    });
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive) setReduceMotion(value); });
    const accessibility = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; subscription.remove(); accessibility.remove(); };
  }, []);
  useEffect(() => {
    if (frozen) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [frozen]);
  useEffect(() => { history.current.clear(); setExpandedCandidateId(null); }, [leg.id]);

  const frames = useMemo(() => candidates.map(candidate => {
    const previous = history.current.get(candidate.id);
    const motion = frozen && previous ? { ...previous, moving: false, displayLabel: '정보 지연' }
      : candidate.mode === 'SUBWAY' ? getVehicleMotion(candidate, leg, stops, now, previous)
      : { candidateId: candidate.id, relativeStopIndex: candidate.relativeStopIndex, travelSign: null,
          phase: 'UNKNOWN' as const, displayLabel: '관측 위치', estimated: false, moving: false,
          observationKey: candidate.id, observedAtMs: null, observedStopIndex: candidate.relativeStopIndex,
          positionDirection: null, motionStartedAtMs: null };
    return { candidate, motion, x: coordinate(stops, motion.relativeStopIndex) };
  }), [candidates, frozen, leg, stops, now]);
  useEffect(() => { history.current = new Map(frames.map(frame => [frame.candidate.id, frame.motion])); }, [frames]);

  const placed = frames.filter((frame): frame is typeof frame & { x: number } => frame.x !== null);
  // The route has one rail. Only overlapping vehicle markers share a badge;
  // their individual observed identities remain available in the selection list.
  const groups: Array<Array<typeof placed[number]>> = [];
  for (const frame of [...placed].sort((a, b) => a.x - b.x || a.candidate.id.localeCompare(b.candidate.id))) {
    const group = groups[groups.length - 1];
    const first = group?.[0];
    if (first && frame.x - first.x < MARKER_WIDTH) group.push(frame);
    else groups.push([frame]);
  }
  const layout = groups.map(group => {
    const representative = group.find(frame => frame.candidate.id === focusedId)
      ?? group.find(frame => frame.candidate.id === selectedId) ?? group[0];
    return { ...representative, group };
  });
  const expandedGroup = groups.find(group => group.length > 1 && group.some(frame => frame.candidate.id === expandedCandidateId));
  const labelsTop = RAIL_Y + 24;
  const alightIndex = leg.mode === 'BUS'
    ? leg.to.serviceSequence !== null && leg.from.serviceSequence !== null
      ? leg.to.serviceSequence - leg.from.serviceSequence : null
    : leg.stops.length - 1;
  const boardingColumn = stops.findIndex(stop => stop.relativeStopIndex === 0);
  const displayRange = stops.length ? `${stops[0].name} → ${stops[stops.length - 1].name}` : null;
  useEffect(() => {
    if (viewportWidth && boardingColumn >= 0) scroll.current?.scrollTo({
      x: Math.max(0, (boardingColumn + .5) * STOP_GAP - viewportWidth / 2), animated: false,
    });
  }, [viewportWidth, boardingColumn, leg.id]);

  return <View style={styles.wrapper}>
    <Text style={styles.hint}>{displayRange ? `${displayRange} 구간을 표시해요. ` : ''}겹친 차량은 대수 배지를 눌러 고르세요.</Text>
    <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator onLayout={event => setViewportWidth(event.nativeEvent.layout.width)}>
      <View style={{ width: stops.length * STOP_GAP, height: labelsTop + 62 }}>
        <View style={[styles.rail, {
          top: RAIL_Y, left: STOP_GAP / 2, width: Math.max(0, (stops.length - 1) * STOP_GAP), backgroundColor: color,
        }]} />
        {stops.map((stop, index) => <View key={`${stop.relativeStopIndex}:${index}`} style={[styles.station, { left: index * STOP_GAP }]}>
          <View style={[styles.dot, {
            top: RAIL_Y - 5, borderColor: color,
            backgroundColor: stop.relativeStopIndex === 0 ? color : '#FFF',
          }]} />
          <View style={{ marginTop: labelsTop, gap: 4 }}>
            <Text style={[styles.stopName, stop.relativeStopIndex === 0 && { color, fontWeight: '800' }]} numberOfLines={2}>{stop.name}</Text>
            {stop.relativeStopIndex === 0 && <Text style={[styles.stopRole, { color }]}>승차</Text>}
            {stop.relativeStopIndex === alightIndex && <Text style={styles.stopRole}>하차</Text>}
          </View>
        </View>)}
        {layout.map(frame => <MovingVehicle key={frame.candidate.id} {...frame} color={color}
          selected={frame.candidate.id === selectedId} focused={frame.candidate.id === focusedId}
          count={frame.group.length} expanded={frame.group === expandedGroup}
          paused={frozen || frame.motion.phase === 'STALE'} reduceMotion={reduceMotion}
          onPress={() => frame.group.length > 1
            ? setExpandedCandidateId(frame.group === expandedGroup ? null : frame.candidate.id)
            : onPress(frame.candidate.id)} />)}
      </View>
    </ScrollView>
    {candidates.length > 0 && placed.length === 0 && <Text style={styles.hint}>표시할 수 있는 차량 위치가 아직 확인되지 않아요.</Text>}
    <Text style={styles.disclosure}>{frozen ? '위치 갱신을 기다리고 있어요.' : leg.mode === 'BUS'
      ? '차량의 관측 위치를 30초마다 확인해요.' : '역 사이 위치는 예상 위치예요. 실제 운행 상태는 30초마다 확인해요.'}</Text>
    {expandedGroup && <View style={styles.groupSelection}>
      <View style={styles.groupHeading}>
        <Text style={styles.groupTitle}>겹친 차량 {expandedGroup.length}대 · 차량을 선택하세요</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="겹친 차량 목록 닫기" onPress={() => setExpandedCandidateId(null)} style={styles.closeButton}>
          <Text style={styles.closeText}>닫기</Text>
        </Pressable>
      </View>
      <View style={styles.chipWrap}>{expandedGroup.map(({ candidate, motion }) => <View key={candidate.id} style={styles.groupItem}>
        <VehicleChip candidate={candidate} selected={candidate.id === selectedId} focused={candidate.id === focusedId} color={color}
          onPress={() => onPress(candidate.id)} />
        <Text style={styles.groupPhase}>{motion.displayLabel}</Text>
        <Text style={styles.groupPlace}>{motionLocation(stops, motion.relativeStopIndex)}</Text>
      </View>)}</View>
    </View>}
  </View>;
}

function MovingVehicle({ candidate, motion, x, count, expanded, color, selected, focused, paused, reduceMotion, onPress }: {
  candidate: Candidate; motion: VehicleMotion; x: number; count: number; expanded: boolean; color: string;
  selected: boolean; focused: boolean; paused: boolean; reduceMotion: boolean; onPress: () => void;
}) {
  const position = useRef(new Animated.Value(x - MARKER_WIDTH / 2)).current;
  const previousX = useRef(x);
  useEffect(() => {
    position.stopAnimation();
    if (paused) return;
    const correction = Math.abs(previousX.current - x) > STOP_GAP / 2;
    previousX.current = x;
    if (reduceMotion) { position.setValue(x - MARKER_WIDTH / 2); return; }
    const animation = Animated.timing(position, { toValue: x - MARKER_WIDTH / 2,
      duration: correction ? 650 : 1000, easing: correction ? Easing.out(Easing.quad) : Easing.linear, useNativeDriver: Platform.OS !== 'web' });
    animation.start();
    return () => animation.stop();
  }, [x, position, paused, reduceMotion]);
  return <Animated.View style={[styles.moving, { transform: [{ translateX: position }] }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={count > 1 ? `${vehicleName(candidate)} 외 ${count - 1}대 선택 목록` : `${vehicleName(candidate)} 선택`}
      accessibilityHint={`${motion.displayLabel}${motion.estimated ? ', 예상 위치' : ''}`}
      accessibilityState={{ selected, expanded: count > 1 ? expanded : undefined }} onPress={onPress} style={styles.marker}>
      <Text style={[styles.markerNumber, { borderColor: selected || focused ? color : palette.border, color: selected ? color : palette.ink },
        (selected || focused) && styles.markerSelected]} numberOfLines={1}>
        {selected ? '✓ ' : ''}{candidate.mode === 'BUS' ? candidate.vehicleNumber : candidate.trainId}
        {motion.travelSign === 1 ? ' →' : motion.travelSign === -1 ? ' ←' : ''}
      </Text>
      <View style={[selected && { transform: [{ scale: 1.06 }] }, paused && { opacity: .5 }]}>
        <VehicleAsset mode={candidate.mode} color={color} direction={motion.travelSign === -1 ? -1 : 1} width={84} />
        {count > 1 && <Text style={[styles.countBadge, { backgroundColor: color }]}>{count}대</Text>}
      </View>
      <Text style={styles.phase}>{motion.displayLabel}</Text>
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  wrapper: { gap: 10 },
  hint: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  disclosure: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  rail: { position: 'absolute', height: 3, borderRadius: 2, opacity: .55, pointerEvents: 'none' },
  station: { position: 'absolute', top: 0, width: STOP_GAP, alignItems: 'center', pointerEvents: 'none' },
  dot: { position: 'absolute', width: 13, height: 13, borderRadius: 7, borderWidth: 3 },
  stopName: { color: palette.muted, fontSize: 11, lineHeight: 16, textAlign: 'center', minHeight: 32, paddingHorizontal: 6 },
  stopRole: { color: palette.ink, fontSize: 10, textAlign: 'center', fontWeight: '700' },
  moving: { position: 'absolute', top: 0, width: MARKER_WIDTH },
  marker: { alignItems: 'center', minHeight: 72, gap: 3 },
  markerNumber: { fontSize: 11, fontWeight: '800', backgroundColor: '#FFF', borderWidth: 1, borderRadius: 10, minWidth: 58, maxWidth: MARKER_WIDTH, textAlign: 'center', paddingHorizontal: 5, paddingVertical: 3 },
  markerSelected: { borderWidth: 2, backgroundColor: '#F1F7F2' },
  phase: { color: palette.muted, fontSize: 9, marginTop: 2, backgroundColor: '#FFF' },
  countBadge: { position: 'absolute', right: -3, top: -4, color: '#FFF', fontSize: 9, fontWeight: '800', borderRadius: 8, paddingHorizontal: 5, paddingVertical: 2 },
  groupSelection: { padding: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 10, gap: 10, backgroundColor: '#F7F9F7' },
  groupHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  groupTitle: { flex: 1, color: palette.ink, fontSize: 11, fontWeight: '700' },
  closeButton: { minHeight: 32, paddingHorizontal: 7, justifyContent: 'center' },
  closeText: { color: palette.green, fontSize: 11 },
  groupItem: { width: 108, gap: 4, alignItems: 'center' },
  groupPhase: { color: palette.ink, fontSize: 10, fontWeight: '600' },
  groupPlace: { color: palette.muted, fontSize: 9, lineHeight: 13, textAlign: 'center' },
  chip: { minWidth: 82, maxWidth: 112, minHeight: 60, borderWidth: 1, borderRadius: 9, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center', padding: 5, gap: 3 },
  selectedChip: { borderWidth: 2, backgroundColor: '#F4F8F5' },
  number: { fontSize: 11, fontWeight: '800' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
