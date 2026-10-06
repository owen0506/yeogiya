import { interchangeName, networkSegments, stationAliases } from '../stations/network';
import type { RideLeg } from './journey-plan';
import type { SubwayCorridorStop, SubwayPositionPhase, SubwayVehicleCandidate } from '../../services/subway-vehicle-candidates';
import { getObservedSubwayState, observedSubwaySegment as movementSegment } from './subway-ride-state';

export const VEHICLE_OBSERVATION_MAX_AGE_MS = 180_000;

// Display coordinates are separate from observations and never feed alarms or routing.
// Keep the previous result per candidate to retain direction evidence and departure anchors.
export type VehicleMotion = Readonly<{
  candidateId: string;
  relativeStopIndex: number | null;
  travelSign: 1 | -1 | null;
  phase: SubwayPositionPhase | 'STALE';
  displayLabel: string;
  estimated: boolean;
  moving: boolean;
  observationKey: string;
  observedAtMs: number | null;
  observedStopIndex: number | null;
  positionDirection: string | null;
  motionStartedAtMs: number | null;
  progressAtAnchor?: number | null;
  observedPhase?: SubwayPositionPhase;
}>;

const labels: Record<VehicleMotion['phase'], string> = {
  ARRIVING: '다음 역 진입', STOPPED: '역 도착', DEPARTING: '출발 · 예상 위치',
  RUNNING: '운행 중 · 예상 위치', UNKNOWN: '위치 확인 중', STALE: '정보 지연',
};

function canonical(name: string): string {
  const compact = name.replace(/\s/g, '').replace(/역$/, '');
  return interchangeName(stationAliases[compact] ?? compact);
}

function codeDirection(raw: string | null): '0' | '1' | null {
  if (raw === '0' || raw === '상행' || raw === '내선') return '0';
  if (raw === '1' || raw === '하행' || raw === '외선') return '1';
  return null;
}

function isJunction(line: string, station: string): boolean {
  const neighbors = new Set<string>();
  for (const segment of networkSegments.filter(item => item.line === line)) {
    segment.names.forEach((name, index) => {
      if (canonical(name) !== station) return;
      if (index > 0) neighbors.add(canonical(segment.names[index - 1]));
      if (index < segment.names.length - 1) neighbors.add(canonical(segment.names[index + 1]));
    });
  }
  return neighbors.size > 2;
}

function topologyDirection(candidate: SubwayVehicleCandidate, leg: RideLeg, corridor: readonly SubwayCorridorStop[]): 1 | -1 | null {
  const current = candidate.currentStationName && canonical(candidate.currentStationName);
  const index = candidate.relativeStopIndex;
  if (!current || index === null || candidate.positionIsExpress === true || isJunction(leg.line, current)) return null;
  const neighbors = corridor.filter(stop => Math.abs(stop.relativeStopIndex - index) === 1);

  // Only the main 2-line loop has a verified inner/outer orientation here.
  // Seoul Metro: Sadang -> Nakseongdae is inner; the network array uses this order.
  // https://mediahub.seoul.go.kr/archives/1189048
  if (leg.line === '2호선') {
    const direction = codeDirection(candidate.positionDirection);
    const ring = networkSegments.find(segment => segment.line === leg.line && !segment.branch);
    if (!direction || !ring) return null;
    const names = ring.names.slice(0, -1).map(canonical);
    const at = names.indexOf(current);
    if (at < 0) return null; // Spur inner/outer names do not imply loop orientation.
    const next = names[(at + (direction === '0' ? 1 : -1) + names.length) % names.length];
    const target = neighbors.filter(stop => canonical(stop.name) === next);
    if (target.length !== 1) return null;
    return target[0].relativeStopIndex > index ? 1 : -1;
  }

  // Raw 0/1 is not enough to infer a direction through every line or branch.
  // A unique path towards the position API's terminus supplies the next stop.
  const destination = candidate.positionDestination && canonical(candidate.positionDestination.replace(/행$/, ''));
  if (!destination || destination === current) return null;
  const nextNames = new Set<string>();
  for (const segment of networkSegments.filter(item => item.line === leg.line && !item.oneWay)) {
    const names = segment.names.map(canonical);
    const from = names.indexOf(current), to = names.indexOf(destination);
    if (from >= 0 && to >= 0 && from !== to) nextNames.add(names[from + Math.sign(to - from)]);
  }
  if (nextNames.size !== 1) return null;
  const target = neighbors.filter(stop => nextNames.has(canonical(stop.name)));
  if (target.length !== 1) return null;
  return target[0].relativeStopIndex > index ? 1 : -1;
}

function observedDirection(candidate: SubwayVehicleCandidate, leg: RideLeg, previous: VehicleMotion | undefined, at: number | null): 1 | -1 | null {
  if (!previous || previous.candidateId !== candidate.id || at === null || previous.observedAtMs === null ||
      previous.observedStopIndex === null || candidate.relativeStopIndex === null || candidate.positionIsExpress === true ||
      isJunction(leg.line, canonical(candidate.currentStationName ?? ''))) return null;
  const direction = codeDirection(candidate.positionDirection), oldDirection = codeDirection(previous.positionDirection);
  if (direction && oldDirection && direction !== oldDirection) return null;
  const elapsed = at - previous.observedAtMs;
  const difference = candidate.relativeStopIndex - previous.observedStopIndex;
  // A skipped station may be an express, branch, or new run; do not extrapolate it.
  if (elapsed > 0 && elapsed <= VEHICLE_OBSERVATION_MAX_AGE_MS && Math.abs(difference) === 1) return difference > 0 ? 1 : -1;
  if (difference === 0 && elapsed >= 0 && elapsed <= VEHICLE_OBSERVATION_MAX_AGE_MS) return previous.travelSign;
  return null;
}

function segmentSeconds(leg: RideLeg, from: number, to: number): number {
  const first = leg.stops[from]?.plannedOffsetSeconds, second = leg.stops[to]?.plannedOffsetSeconds;
  const direct = first != null && second != null ? Math.abs(second - first) : null;
  const average = leg.planned.durationSeconds != null && leg.stops.length > 1
    ? leg.planned.durationSeconds / (leg.stops.length - 1) : 120;
  const duration = direct && direct > 0 ? direct : average;
  return Math.max(30, Math.min(600, Number.isFinite(duration) && duration > 0 ? duration : 120));
}

export function getVehicleMotion(
  candidate: SubwayVehicleCandidate,
  leg: RideLeg,
  corridor: readonly SubwayCorridorStop[],
  now = Date.now(),
  previous?: VehicleMotion,
): VehicleMotion {
  let index = candidate.relativeStopIndex;
  const parsedAt = candidate.positionObservedAt ? Date.parse(candidate.positionObservedAt) : NaN;
  let at = Number.isFinite(parsedAt) ? parsedAt : null;
  let phase = candidate.positionPhase ?? 'UNKNOWN';
  const prior = previous?.candidateId === candidate.id ? previous : undefined;
  const travelSign = candidate.routeDirectionMatched === true && candidate.positionIsExpress !== true ? 1
    : topologyDirection(candidate, leg, corridor) ?? observedDirection(candidate, leg, prior, at);
  const observation = getObservedSubwayState(candidate, now, travelSign);
  index = observation.index;
  phase = observation.phase;
  at = observation.observedAtMs;
  const freshArrival = observation.segmentArrival;
  const arrivalFetchedAt = freshArrival ? Date.parse(freshArrival.fetchedAt) : NaN;
  const observationKey = JSON.stringify([candidate.id, index, phase, at, candidate.positionDirection, candidate.positionDestination]);
  const age = at === null ? Infinity : now - at;
  const stale = at === null || age > VEHICLE_OBSERVATION_MAX_AGE_MS || age < -60_000;
  // Do not let an older snapshot undo a newer station or interval observation.
  if (prior?.observedAtMs != null && at !== null && at < prior.observedAtMs) {
    return now - prior.observedAtMs > VEHICLE_OBSERVATION_MAX_AGE_MS
      ? { ...prior, phase: 'STALE', moving: false, displayLabel: labels.STALE } : prior;
  }
  // A partial refresh may return an arrival candidate without position data.
  // Keep its last observation and interval anchor so recovery cannot restart it.
  if (stale && prior) return { ...prior, phase: 'STALE', moving: false, displayLabel: labels.STALE };
  const priorPhase = prior?.phase === 'STALE' ? prior.observedPhase : prior?.phase;
  if (priorPhase === 'STOPPED' && prior?.observedStopIndex === index &&
      prior.travelSign === travelSign && (phase === 'RUNNING' || phase === 'ARRIVING')) {
    phase = 'STOPPED';
  }
  const segment = movementSegment(index, phase, travelSign);
  const priorSegment = prior && movementSegment(prior.observedStopIndex,
    prior.phase === 'STALE' ? prior.observedPhase ?? 'UNKNOWN' : prior.phase, prior.travelSign);
  // Departure at A and previous-station departure at B describe the same A -> B ride.
  // Refreshing either report must keep that ride's animation anchor.
  const sameInterval = prior && segment && priorSegment && prior.travelSign === travelSign &&
    segment[0] === priorSegment[0] && segment[1] === priorSegment[1];
  const sameMovement = sameInterval &&
    at !== null && prior.observedAtMs !== null && at >= prior.observedAtMs &&
    at - prior.observedAtMs <= VEHICLE_OBSERVATION_MAX_AGE_MS;
  // recptnDt is an update timestamp, not the train's actual departure time.
  const motionStartedAtMs = segment ? sameMovement ? prior.motionStartedAtMs ?? now : now : null;
  const progressAtAnchor = segment ? sameMovement ? prior.progressAtAnchor ?? 0.12
    : phase === 'ARRIVING' ? 0.88 : phase === 'RUNNING' ? 0.45 : 0.12 : null;
  const base: VehicleMotion = {
    candidateId: candidate.id, relativeStopIndex: index, travelSign,
    phase: stale ? 'STALE' : phase, displayLabel: labels[stale ? 'STALE' : phase],
    estimated: false, moving: false, observationKey,
    observedAtMs: at, observedStopIndex: index,
    positionDirection: candidate.positionDirection, motionStartedAtMs, progressAtAnchor, observedPhase: phase,
  };
  if (stale) return {
    ...base,
    // Once stale, keep the last displayed position instead of running indefinitely.
    relativeStopIndex: prior?.relativeStopIndex ?? index,
    estimated: prior?.estimated ?? false,
  };
  if (!segment || !travelSign || motionStartedAtMs === null) {
    return !travelSign && (phase === 'DEPARTING' || phase === 'RUNNING' || phase === 'ARRIVING')
      ? { ...base, relativeStopIndex: null, displayLabel: '운행 방향 확인 중' } : base;
  }
  // State 3 names the upcoming station; state 2 names the departed station.
  const [start, end] = segment;
  if (!corridor.some(stop => stop.relativeStopIndex === start) || !corridor.some(stop => stop.relativeStopIndex === end)) {
    return { ...base, relativeStopIndex: null, displayLabel: '화면 밖 구간 운행' };
  }
  const duration = segmentSeconds(leg, start, end);
  let progress = (progressAtAnchor ?? 0.12) + Math.max(0, now - motionStartedAtMs) / (duration * 1000) * 0.75;
  if (freshArrival?.relativeStopIndex === end && freshArrival.seconds !== null && freshArrival.seconds >= 0) {
    // The arrival parser already corrected observation delay; only elapsed time
    // since this fetch is subtracted again here.
    const remaining = Math.max(0, freshArrival.seconds - Math.max(0, now - arrivalFetchedAt) / 1000);
    progress = 1 - remaining / duration;
  }
  if (phase === 'ARRIVING') progress = Math.max(0.88, progress);
  if (sameInterval && prior.relativeStopIndex !== null) {
    progress = Math.max(progress, (prior.relativeStopIndex - start) * travelSign);
  }
  progress = Math.max(0.12, Math.min(0.94, progress));
  const displayLabel = phase === 'ARRIVING' ? '다음 역 진입'
    : progress <= 0.25 && phase === 'DEPARTING' ? '출발 · 예상 위치'
    : progress >= 0.75 ? '도착 접근 · 예상 위치' : '구간 운행 중 · 예상 위치';
  return {
    ...base, relativeStopIndex: start + travelSign * progress,
    displayLabel, estimated: true, moving: progress < 0.94,
  };
}
