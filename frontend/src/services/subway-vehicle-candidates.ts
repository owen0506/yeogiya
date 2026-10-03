import { getStationByName } from '../features/stations/stations';
import { interchangeName, networkSegments, stationAliases } from '../features/stations/network';
import type { RideLeg, VehicleCandidate, VehicleEvidence } from '../features/transit/journey-plan';
import { getArrivals, lineIds, type Arrival } from './seoul-subway';

export type SubwayCorridorStop = Readonly<{
  stationId: string | null;
  name: string;
  relativeStopIndex: number;
  onLeg: boolean;
}>;

export type SubwayPosition = Readonly<{
  trainId: string;
  lineId: string;
  direction: string | null;
  stationName: string;
  status: string | null;
  observedAt: string;
}>;

export type SubwayVehicleCandidate = VehicleCandidate & Readonly<{
  mode: 'SUBWAY';
  trainId: string;
  destination: string | null;
  direction: string | null;
  etaSeconds: number | null;
  message: string | null;
  currentStationName: string | null;
  relativeStopIndex: number | null;
  positionStatus: string | null;
  // A shared train number alone does not prove a timetable or direction match.
  positionAssociation: 'NONE' | 'TRAIN_NUMBER_ONLY' | 'POSITION_ONLY';
}>;

function canonical(name: string): string {
  const compact = name.replace(/\s/g, '').replace(/역$/, '');
  return interchangeName(stationAliases[compact] ?? compact);
}

function fallbackCorridor(leg: RideLeg): SubwayCorridorStop[] {
  return leg.stops.map((stop, index) => ({
    stationId: stop.id, name: stop.name,
    relativeStopIndex: index, onLeg: true,
  }));
}

// Extend a known route only when exactly one ordered network path contains it.
// A branch or loop with multiple possible predecessors stays at the known leg stops.
export function getSubwayCorridor(leg: RideLeg, radius = 3): SubwayCorridorStop[] {
  const fallback = fallbackCorridor(leg);
  if (leg.mode !== 'SUBWAY' || leg.stops.length < 2) return fallback;
  const wanted = leg.stops.map(stop => canonical(stop.name));
  const matches: { names: string[]; start: number }[] = [];
  for (const segment of networkSegments.filter(item => item.line === leg.line)) {
    const directions = segment.oneWay ? [segment.names] : [segment.names, [...segment.names].reverse()];
    for (const names of directions) {
      for (let start = 0; start <= names.length - wanted.length; start++) {
        if (wanted.every((name, index) => canonical(names[start + index]) === name)) matches.push({ names, start });
      }
    }
  }
  if (matches.length !== 1) return fallback;
  const { names, start } = matches[0];
  const limit = Math.max(0, Math.min(12, Math.floor(radius) || 0));
  return names.slice(Math.max(0, start - limit), Math.min(names.length, start + limit + 1))
    .map((name, index) => {
      const relativeStopIndex = Math.max(0, start - limit) + index - start;
      const known = leg.stops[relativeStopIndex];
      return {
        stationId: known?.id ?? getStationByName(name)?.id ?? null,
        name: known?.name ?? name,
        relativeStopIndex,
        onLeg: Boolean(known),
      };
    });
}

function seoulTime(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw.replace(' ', 'T')}+09:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function parseSubwayPositions(payload: unknown, line: string, now = Date.now()): SubwayPosition[] {
  if (!payload || typeof payload !== 'object') throw new Error('열차 위치 응답 형식이 올바르지 않습니다.');
  const data = payload as { errorMessage?: { code?: string }; RESULT?: { CODE?: string }; realtimePositionList?: unknown };
  const code = data.errorMessage?.code ?? data.RESULT?.CODE;
  if (code === 'INFO-200') return [];
  if (code && code !== 'INFO-000') throw new Error('서울시 열차 위치 API가 오류를 반환했습니다.');
  if (!Array.isArray(data.realtimePositionList)) throw new Error('열차 위치 목록을 읽을 수 없습니다.');
  const lineId = lineIds[line];
  return data.realtimePositionList.flatMap((value): SubwayPosition[] => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const trainId = String(row.trainNo ?? '').trim();
    const stationName = typeof row.statnNm === 'string' ? row.statnNm.trim() : '';
    const received = seoulTime(row.recptnDt);
    const suppliedLineId = row.subwayId == null ? null : String(row.subwayId);
    const suppliedLineName = row.subwayNm == null ? null : String(row.subwayNm);
    if (!lineId || (suppliedLineId !== lineId && suppliedLineName !== line) || !trainId || !stationName || !received) return [];
    if (now - received.getTime() > 180_000 || received.getTime() - now > 60_000) return [];
    return [{
      trainId, lineId, direction: row.updnLine == null ? null : String(row.updnLine),
      stationName, status: row.trainSttus == null ? null : String(row.trainSttus),
      observedAt: received.toISOString(),
    }];
  });
}

export async function getSubwayPositions(line: string, signal?: AbortSignal): Promise<SubwayPosition[]> {
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  if (!base) throw new Error('실시간 열차 위치 API가 설정되지 않았습니다.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/positions?line=${encodeURIComponent(line)}`, { signal: controller.signal });
    if (!response.ok) throw new Error('실시간 열차 위치를 가져오지 못했습니다.');
    return parseSubwayPositions(await response.json(), line);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function arrivalObservedAt(arrival: Arrival): string | null {
  return seoulTime(arrival.receivedAt)?.toISOString() ?? null;
}

function runId(line: string, trainId: string, observedAt: string | null): string {
  const day = observedAt ? new Date(Date.parse(observedAt) + 9 * 3600_000).toISOString().slice(0, 10) : 'unknown-date';
  return `${day}:${lineIds[line]}:${trainId}`;
}

function evidence(source: VehicleEvidence['source'], observedAt: string | null, fetchedAt: string): VehicleEvidence {
  return { source, observedAt, fetchedAt, freshness: observedAt ? 'LIVE' : 'UNKNOWN' };
}

export function mergeSubwayVehicleCandidates(
  leg: RideLeg,
  arrivals: readonly Arrival[],
  positions: readonly SubwayPosition[],
  fetchedAt = new Date().toISOString(),
): SubwayVehicleCandidate[] {
  if (leg.mode !== 'SUBWAY') return [];
  const corridor = getSubwayCorridor(leg);
  const offset = new Map(corridor.map(stop => [canonical(stop.name), stop.relativeStopIndex]));
  const nearby = positions.filter(position => {
    const relative = offset.get(canonical(position.stationName));
    return position.lineId === lineIds[leg.line] && relative !== undefined && Math.abs(relative) <= 3;
  });
  const byTrain = new Map<string, SubwayPosition[]>();
  nearby.forEach(position => byTrain.set(position.trainId, [...(byTrain.get(position.trainId) ?? []), position]));
  const candidates: SubwayVehicleCandidate[] = [];
  const arrivalTrainIds = new Set<string>();
  for (const arrival of arrivals) {
    const trainId = arrival.trainId.trim();
    if (!trainId || arrival.lineId !== lineIds[leg.line]) continue;
    arrivalTrainIds.add(trainId);
    const observedAt = arrivalObservedAt(arrival);
    const sameNumberPositions = byTrain.get(trainId) ?? [];
    const position = sameNumberPositions.length === 1 ? sameNumberPositions[0] : null;
    const id = `subway:${leg.id}:${runId(leg.line, trainId, observedAt)}`;
    candidates.push({
      id, legId: leg.id, mode: 'SUBWAY', trainId,
      destination: arrival.destination || null, direction: arrival.direction || null,
      etaSeconds: arrival.seconds, message: arrival.message || null,
      currentStationName: position?.stationName ?? null,
      relativeStopIndex: position ? offset.get(canonical(position.stationName)) ?? null : null,
      positionStatus: position?.status ?? null,
      positionAssociation: position ? 'TRAIN_NUMBER_ONLY' : 'NONE',
      run: {
        provider: 'SEOUL_SUBWAY', serviceDate: observedAt ? runId(leg.line, trainId, observedAt).split(':')[0] : null,
        tripId: null, realtimeRunId: trainId, vehicleId: null,
      },
      observedAt, matchStatus: 'UNVERIFIED', selectable: true,
      evidence: [evidence('SEOUL_ARRIVAL', observedAt, fetchedAt), ...(position ? [evidence('SEOUL_POSITION', position.observedAt, fetchedAt)] : [])],
    });
  }
  for (const position of nearby) {
    if (arrivalTrainIds.has(position.trainId)) continue;
    const id = `subway:${leg.id}:${runId(leg.line, position.trainId, position.observedAt)}`;
    candidates.push({
      id, legId: leg.id, mode: 'SUBWAY', trainId: position.trainId,
      destination: null, direction: position.direction,
      etaSeconds: null, message: null,
      currentStationName: position.stationName,
      relativeStopIndex: offset.get(canonical(position.stationName)) ?? null,
      positionStatus: position.status, positionAssociation: 'POSITION_ONLY',
      run: {
        provider: 'SEOUL_SUBWAY', serviceDate: runId(leg.line, position.trainId, position.observedAt).split(':')[0],
        tripId: null, realtimeRunId: position.trainId, vehicleId: null,
      },
      observedAt: position.observedAt, matchStatus: 'UNVERIFIED', selectable: true,
      evidence: [evidence('SEOUL_POSITION', position.observedAt, fetchedAt)],
    });
  }
  const unique = new Map<string, SubwayVehicleCandidate>();
  candidates.forEach(candidate => {
    const old = unique.get(candidate.id);
    if (!old || (candidate.etaSeconds ?? Infinity) < (old.etaSeconds ?? Infinity)) unique.set(candidate.id, candidate);
  });
  return [...unique.values()].sort((a, b) => (a.etaSeconds ?? Infinity) - (b.etaSeconds ?? Infinity));
}

export async function getSubwayVehicleCandidates(leg: RideLeg, signal?: AbortSignal): Promise<SubwayVehicleCandidate[]> {
  if (leg.mode !== 'SUBWAY') return [];
  const [arrivals, positions] = await Promise.allSettled([
    getArrivals(leg.from.name, leg.line, signal),
    getSubwayPositions(leg.line, signal),
  ]);
  if (arrivals.status === 'rejected' && positions.status === 'rejected') throw arrivals.reason;
  return mergeSubwayVehicleCandidates(
    leg,
    arrivals.status === 'fulfilled' ? arrivals.value : [],
    positions.status === 'fulfilled' ? positions.value : [],
  );
}
