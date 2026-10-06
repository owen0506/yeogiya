import { getStationByName } from '../features/stations/stations';
import { interchangeName, stationAliases } from '../features/stations/network';
import type { RideLeg, VehicleCandidate, VehicleEvidence } from '../features/transit/journey-plan';
import { getArrivals, lineIds, type Arrival } from './seoul-subway';
import { getSubwayCorridorNames, sameSubwayDirection, subwayServiceMatchesLeg, subwayTerminalName } from './subway-service-direction';

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
  destination?: string | null;
  express?: boolean | null;
}>;

export type SubwayPositionPhase = 'ARRIVING' | 'STOPPED' | 'DEPARTING' | 'RUNNING' | 'UNKNOWN';

// Seoul realtimePosition: 0 entry, 1 arrival, 2 departure, 3 previous-station departure.
// https://data.seoul.go.kr/dataList/datasetView.do?infId=OA-12601&serviceKind=1&srvType=A
export function normalizeSubwayPositionStatus(status: string | null): SubwayPositionPhase {
  const phases: Record<string, SubwayPositionPhase> = { '0': 'ARRIVING', '1': 'STOPPED', '2': 'DEPARTING', '3': 'RUNNING' };
  return status === null ? 'UNKNOWN' : phases[status] ?? 'UNKNOWN';
}

export type SubwayVehicleCandidate = VehicleCandidate & Readonly<{
  mode: 'SUBWAY';
  trainId: string;
  destination: string | null;
  direction: string | null;
  etaSeconds: number | null;
  boardingPhase?: SubwayPositionPhase;
  message: string | null;
  currentStationName: string | null;
  relativeStopIndex: number | null;
  positionStatus: string | null;
  positionPhase: SubwayPositionPhase;
  positionObservedAt: string | null;
  positionDirection: string | null;
  positionDestination: string | null;
  positionIsExpress: boolean | null;
  routeDirectionMatched?: boolean;
  segmentArrival?: Readonly<{
    relativeStopIndex: number;
    seconds: number | null;
    phase: SubwayPositionPhase;
    observedAt: string;
    fetchedAt: string;
  }> | null;
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

// Show approaching trains from the upstream end through the alighting stop.
// Relative indices stay anchored at boarding, independently of display length.
export function getSubwayCorridor(leg: RideLeg): SubwayCorridorStop[] {
  const fallback = fallbackCorridor(leg);
  const names = getSubwayCorridorNames(leg);
  if (!names) return fallback;
  const boardingIndex = names.length - leg.stops.length;
  return names.map((name, index) => {
    const relativeStopIndex = index - boardingIndex;
    const known = leg.stops[relativeStopIndex];
    const station = getStationByName(name);
    return {
      stationId: known?.id ?? station?.id ?? null,
      name: known?.name ?? station?.name ?? name,
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
      destination: typeof row.statnTnm === 'string' ? row.statnTnm.trim() || null : null,
      express: row.directAt == null ? null : ['1', '7'].includes(String(row.directAt)),
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

export function normalizeSubwayArrivalStatus(status: string | null | undefined): SubwayPositionPhase {
  // Previous-station entry/arrival (4/5) still includes a previous stop, not this segment's motion.
  const phases: Record<string, SubwayPositionPhase> = {
    '0': 'ARRIVING', '1': 'STOPPED', '2': 'DEPARTING',
    '3': 'RUNNING', '99': 'RUNNING',
  };
  return status == null ? 'UNKNOWN' : phases[status] ?? 'UNKNOWN';
}

function terminalCompatible(first: string | null | undefined, second: string | null | undefined): boolean {
  const a = subwayTerminalName(first), b = subwayTerminalName(second);
  return !a || !b || a === b;
}

export type SubwaySegmentArrival = Readonly<{ stop: SubwayCorridorStop; arrivals: readonly Arrival[]; fetchedAt: string }>;

function nextArrivalStop(candidate: SubwayVehicleCandidate, corridor: readonly SubwayCorridorStop[]): SubwayCorridorStop | null {
  if (candidate.relativeStopIndex === null || candidate.routeDirectionMatched !== true) return null;
  const nextIndex = candidate.positionPhase === 'DEPARTING' ? candidate.relativeStopIndex + 1
    : candidate.positionPhase === 'RUNNING' || candidate.positionPhase === 'ARRIVING' ? candidate.relativeStopIndex : null;
  return corridor.find(stop => stop.relativeStopIndex === nextIndex) ?? null;
}

function withSegmentArrival(candidate: SubwayVehicleCandidate, leg: RideLeg, corridor: readonly SubwayCorridorStop[], segments: readonly SubwaySegmentArrival[]): SubwayVehicleCandidate {
  const next = nextArrivalStop(candidate, corridor);
  if (!next) return candidate;
  const source = segments.find(segment => segment.stop.relativeStopIndex === next.relativeStopIndex);
  // Association uses line + number + direction; an ETA at a different stop is never boarding ETA.
  const matching = source?.arrivals.filter(arrival => arrival.trainId.trim() === candidate.trainId &&
    arrival.lineId === lineIds[leg.line] && sameSubwayDirection(arrival.direction, candidate.positionDirection) &&
    arrival.arrivalCode !== '4' && arrival.arrivalCode !== '5' &&
    terminalCompatible(arrival.terminalName ?? arrival.destination, candidate.positionDestination) &&
    subwayServiceMatchesLeg(leg, arrival.direction, arrival.terminalName ?? arrival.destination, arrival.express));
  if (!source || matching?.length !== 1) return candidate;
  const arrival = matching[0], observedAt = arrivalObservedAt(arrival);
  if (!observedAt) return candidate;
  return { ...candidate, segmentArrival: {
    relativeStopIndex: next.relativeStopIndex, seconds: arrival.seconds,
    phase: normalizeSubwayArrivalStatus(arrival.arrivalCode), observedAt, fetchedAt: source.fetchedAt,
  } };
}

export function mergeSubwayVehicleCandidates(
  leg: RideLeg,
  arrivals: readonly Arrival[],
  positions: readonly SubwayPosition[],
  fetchedAt = new Date().toISOString(),
  segmentArrivals: readonly SubwaySegmentArrival[] = [],
): SubwayVehicleCandidate[] {
  if (leg.mode !== 'SUBWAY') return [];
  const corridor = getSubwayCorridor(leg);
  const offset = new Map(corridor.map(stop => [canonical(stop.name), stop.relativeStopIndex]));
  const nearby = positions.filter(position => {
    const relative = offset.get(canonical(position.stationName));
    return position.lineId === lineIds[leg.line] && relative !== undefined &&
      subwayServiceMatchesLeg(leg, position.direction, position.destination, position.express);
  });
  const byTrain = new Map<string, SubwayPosition[]>();
  nearby.forEach(position => byTrain.set(position.trainId, [...(byTrain.get(position.trainId) ?? []), position]));
  const candidates: SubwayVehicleCandidate[] = [];
  const arrivalTrainIds = new Set<string>();
  for (const arrival of arrivals) {
    const trainId = arrival.trainId.trim();
    if (!trainId || arrival.lineId !== lineIds[leg.line] ||
      !subwayServiceMatchesLeg(leg, arrival.direction, arrival.terminalName ?? arrival.destination, arrival.express)) continue;
    arrivalTrainIds.add(trainId);
    const observedAt = arrivalObservedAt(arrival);
    const sameNumberPositions = (byTrain.get(trainId) ?? []).filter(position =>
      sameSubwayDirection(arrival.direction, position.direction) &&
      terminalCompatible(arrival.terminalName ?? arrival.destination, position.destination));
    const position = sameNumberPositions.length === 1 ? sameNumberPositions[0] : null;
    const id = `subway:${leg.id}:${runId(leg.line, trainId, observedAt)}`;
    candidates.push({
      id, legId: leg.id, mode: 'SUBWAY', trainId,
      destination: arrival.destination || null, direction: arrival.direction || null,
      etaSeconds: arrival.seconds, message: arrival.message || null,
      boardingPhase: normalizeSubwayArrivalStatus(arrival.arrivalCode),
      currentStationName: position?.stationName ?? null,
      relativeStopIndex: position ? offset.get(canonical(position.stationName)) ?? null : null,
      positionStatus: position?.status ?? null,
      positionPhase: normalizeSubwayPositionStatus(position?.status ?? null),
      positionObservedAt: position?.observedAt ?? null,
      positionDirection: position?.direction ?? null,
      positionDestination: position?.destination ?? null,
      positionIsExpress: position?.express ?? null,
      routeDirectionMatched: true, segmentArrival: null,
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
      destination: position.destination ?? null, direction: position.direction,
      etaSeconds: null, message: null,
      currentStationName: position.stationName,
      relativeStopIndex: offset.get(canonical(position.stationName)) ?? null,
      positionStatus: position.status, positionAssociation: 'POSITION_ONLY',
      positionPhase: normalizeSubwayPositionStatus(position.status),
      positionObservedAt: position.observedAt,
      positionDirection: position.direction,
      positionDestination: position.destination ?? null,
      positionIsExpress: position.express ?? null,
      routeDirectionMatched: true, segmentArrival: null,
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
  return [...unique.values()].map(candidate => withSegmentArrival(candidate, leg, corridor, segmentArrivals))
    .sort((a, b) => (a.etaSeconds ?? Infinity) - (b.etaSeconds ?? Infinity));
}

export async function getSubwayVehicleCandidates(leg: RideLeg, signal?: AbortSignal): Promise<SubwayVehicleCandidate[]> {
  if (leg.mode !== 'SUBWAY') return [];
  const [arrivals, positions] = await Promise.allSettled([
    getArrivals(leg.from.name, leg.line, signal),
    getSubwayPositions(leg.line, signal),
  ]);
  if (arrivals.status === 'rejected' && positions.status === 'rejected') throw arrivals.reason;
  const boardingArrivals = arrivals.status === 'fulfilled' ? arrivals.value : [];
  const livePositions = positions.status === 'fulfilled' ? positions.value : [];
  const fetchedAt = new Date().toISOString();
  const candidates = mergeSubwayVehicleCandidates(leg, boardingArrivals, livePositions, fetchedAt);
  const corridor = getSubwayCorridor(leg);
  const required = new Map<string, SubwayCorridorStop>();
  for (const candidate of candidates) {
    const stop = nextArrivalStop(candidate, corridor);
    if (stop) required.set(canonical(stop.name), stop);
  }
  // Reuse line-wide positions for the whole corridor; additional arrival queries
  // remain capped at seven distinct stops per 30-second refresh.
  const segmentArrivals = await Promise.all([...required.values()].slice(0, 7).map(async stop => {
    if (canonical(stop.name) === canonical(leg.from.name)) return { stop, arrivals: boardingArrivals, fetchedAt };
    try {
      const rows = await getArrivals(stop.name, leg.line, signal);
      return { stop, arrivals: rows, fetchedAt: new Date().toISOString() };
    } catch {
      return { stop, arrivals: [] as Arrival[], fetchedAt: new Date().toISOString() };
    }
  }));
  return mergeSubwayVehicleCandidates(
    leg,
    boardingArrivals, livePositions, fetchedAt, segmentArrivals,
  );
}
