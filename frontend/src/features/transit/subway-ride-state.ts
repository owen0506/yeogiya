import type { SubwayPositionPhase, SubwayVehicleCandidate } from '../../services/subway-vehicle-candidates';

export function observedSubwaySegment(index: number | null, phase: SubwayPositionPhase | 'STALE', sign: 1 | -1 | null = 1): readonly [number, number] | null {
  if (index === null || sign === null) return null;
  if (phase === 'DEPARTING') return [index, index + sign];
  if (phase === 'RUNNING' || phase === 'ARRIVING') return [index - sign, index];
  return null;
}

// Only provider observations are interpreted here. Display animation never feeds
// boarding eligibility or alarm calculations.
export function getObservedSubwayState(candidate: SubwayVehicleCandidate, now = Date.now(), sign: 1 | -1 | null = 1) {
  let index = candidate.relativeStopIndex;
  let phase = candidate.positionPhase ?? 'UNKNOWN';
  const parsed = candidate.positionObservedAt ? Date.parse(candidate.positionObservedAt) : NaN;
  let observedAtMs = Number.isFinite(parsed) ? parsed : null;
  const rawSegment = observedSubwaySegment(index, phase, sign);
  const arrival = candidate.segmentArrival;
  const arrivalAt = arrival ? Date.parse(arrival.observedAt) : NaN;
  const fetchedAt = arrival ? Date.parse(arrival.fetchedAt) : NaN;
  const segmentArrival = arrival && Number.isFinite(arrivalAt) && Number.isFinite(fetchedAt) &&
    now - arrivalAt <= 180_000 && now - arrivalAt >= -60_000 &&
    observedAtMs !== null && arrivalAt >= observedAtMs && rawSegment?.[1] === arrival.relativeStopIndex ? arrival : null;
  // ETA zero does not imply arrival; an explicit newer status does.
  if (segmentArrival && segmentArrival.phase !== 'UNKNOWN') {
    index = segmentArrival.relativeStopIndex;
    phase = segmentArrival.phase;
    observedAtMs = arrivalAt;
  }
  return { index, phase, observedAtMs, segmentArrival, segment: observedSubwaySegment(index, phase, sign) };
}

export function canPlanSubwayVehicle(candidate: SubwayVehicleCandidate): boolean {
  const state = getObservedSubwayState(candidate);
  const boardingAt = candidate.observedAt ? Date.parse(candidate.observedAt) : NaN;
  if (candidate.boardingPhase === 'DEPARTING' &&
      (state.observedAtMs === null || !Number.isFinite(boardingAt) || boardingAt >= state.observedAtMs)) return false;
  if (state.index === null) return true;
  if (state.index < 0) return true;
  if (state.index > 0) return false;
  return state.phase !== 'DEPARTING';
}

export function canBeOnboardSubwayVehicle(candidate: SubwayVehicleCandidate, stopCount: number): boolean {
  const state = getObservedSubwayState(candidate);
  if (state.index === null) return true;
  const from = state.segment?.[0] ?? state.index;
  return from >= 0 && from < stopCount - 1;
}
