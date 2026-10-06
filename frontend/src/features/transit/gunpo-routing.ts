import stationLocationData from '../stations/station-locations.json';
import { getStation, type Station } from '../stations/stations';
import { distanceMetersBetween, isCoordinate, type Coordinate } from '../stations/nearby-stations';
import type { JourneyRoute } from '../journey/route-service';
import { createJourneyPlan, type JourneyLeg, type JourneyPlan, type JourneyStop, type PlannedTiming, type RideLeg } from './journey-plan';

export type GunpoStop = Readonly<{
  stopId: string;
  name: string;
  latitude: number;
  longitude: number;
  stopSequence: number;
  directionCode?: string | number;
}>;

export type GunpoNetwork = Readonly<{
  providerId: 'tago';
  cityCode: '31160';
  fetchedAt: string;
  routes: readonly Readonly<{
    routeId: string;
    routeNumber: string;
    routeType?: string;
    stops: readonly GunpoStop[];
  }>[];
  rideTimes?: readonly Readonly<{
    routeId: string;
    fromSequence: number;
    toSequence: number;
    seconds: number;
    source: string;
  }>[];
}>;

export type GunpoArrivalSnapshot = Readonly<{
  providerId: 'tago';
  cityCode: '31160';
  stopId: string;
  fetchedAt: string;
  arrivals: readonly Readonly<{
    routeId: string;
    routeNumber: string;
    arrivalSeconds: number;
    remainingStops: number;
  }>[];
}>;

export type GunpoFixedBus = Readonly<{
  legId?: string;
  routeId: string;
  vehicleNumber?: string;
  boardSequence: number;
  alightSequence: number;
}> & (
  | Readonly<{ status: 'PLANNED'; departureAt: string }>
  | Readonly<{ status: 'ONBOARD'; currentSequence: number; observedAt: string }>
);

export type GunpoRideQuery = Readonly<{
  routeId: string;
  fromStop: GunpoStop;
  toStop: GunpoStop;
}>;

export type GunpoJourneyQuery = Readonly<{
  origin: Readonly<{
    latitude?: number;
    longitude?: number;
    name?: string;
    stationId?: string;
    /** Explicitly selected rail connection; stationId may only be an automatic nearest-station hint. */
    connectionStationId?: string;
    isCurrentLocation?: boolean;
  }>;
  destination: Station;
  network: GunpoNetwork;
  arrivals: readonly GunpoArrivalSnapshot[];
  departureAt: string;
  preference?: 'fastest' | 'fewest-transfers';
  signal?: AbortSignal;
  getSubwayRoute: (
    from: Station, to: Station, preference: 'fastest' | 'fewest-transfers',
    signal?: AbortSignal, departureAt?: string,
  ) => Promise<JourneyRoute | null>;
  rideSeconds?: (query: GunpoRideQuery) => number | null;
  stationCoordinates?: readonly Readonly<{ stationId: string; latitude: number; longitude: number }>[];
  fixedBus?: GunpoFixedBus;
}>;

type GunpoRoute = GunpoNetwork['routes'][number];
type Pattern = Readonly<{ route: GunpoRoute; direction: string; stops: readonly GunpoStop[] }>;
type Access = Readonly<{
  station: Station;
  readyMs: number;
  transferCount: number;
  basis: 'DIRECT' | 'ROUTE_ARRIVAL' | 'POSITION_ESTIMATE' | 'ONBOARD';
  buildLegs: () => JourneyLeg[];
}>;

const BOARD_WALK_LIMIT_METERS = 500;
const DIRECT_WALK_LIMIT_METERS = 3000;
const RAIL_WALK_LIMIT_METERS = 400;
const RAIL_PLATFORM_SECONDS = 120;
const WALK_METERS_PER_SECOND = 1.2;
const MAX_ARRIVAL_AGE_MS = 120_000;
const MAX_ONBOARD_FIX_AGE_MS = 120_000;
const ALLOWED_STATION_IDS = ['station-금정', 'station-산본'] as const;
const BUS_ESTIMATE_NOTE = '버스·도보 시간은 거리 기반 추정이며 실제 도로·교통상황과 다를 수 있어요.';

const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const secondsBetween = (from: number, to: number) => (to - from) / 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const rideKey = (routeId: string, from: number, to: number) => JSON.stringify([routeId, from, to]);

function instant(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error('GUNPO_INVALID_TIME');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('GUNPO_INVALID_TIME');
  return parsed;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('GUNPO_ABORTED');
}

function walkSeconds(distanceMeters: number): number {
  return Math.ceil(distanceMeters / WALK_METERS_PER_SECOND);
}

function timing(fromMs: number, toMs: number, source: PlannedTiming['source'] = 'ESTIMATE'): PlannedTiming {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new Error('GUNPO_INVALID_TIME');
  return {
    startOffsetSeconds: null, endOffsetSeconds: null, durationSeconds: secondsBetween(fromMs, toMs),
    departureAt: iso(fromMs), arrivalAt: iso(toMs), source,
  };
}

function point(id: string, name: string, atMs: number, originMs: number, providerStopId: string | null = null,
  serviceSequence: number | null = null, sequence = 0): JourneyStop {
  return { id, name, platformId: null, providerStopId, serviceSequence, sequence,
    plannedOffsetSeconds: secondsBetween(originMs, atMs) };
}

function busPoint(stop: GunpoStop, atMs: number, originMs: number, sequence = 0): JourneyStop {
  return point(`bus-stop:${JSON.stringify(['tago', '31160', stop.stopId])}`, stop.name, atMs, originMs,
    stop.stopId, stop.stopSequence, sequence);
}

function leg(kind: 'WALK' | 'WAIT' | 'TRANSFER', from: JourneyStop, to: JourneyStop,
  startMs: number, endMs: number, originMs: number, id: string): JourneyLeg {
  return {
    id: `${kind.toLowerCase()}:${id}`, kind, from, to,
    planned: { ...timing(startMs, endMs), startOffsetSeconds: secondsBetween(originMs, startMs),
      endOffsetSeconds: secondsBetween(originMs, endMs) },
  };
}

function patternDirection(value: GunpoStop['directionCode']): string {
  return value === undefined || value === null || value === '' ? 'SERVICE_SEQUENCE' : String(value);
}

function checkedNetwork(network: GunpoNetwork): { patterns: Pattern[]; costs: Map<string, number> } {
  if (!network || network.providerId !== 'tago' || network.cityCode !== '31160' ||
    !Array.isArray(network.routes) || !Array.isArray(network.rideTimes ?? [])) throw new Error('GUNPO_INVALID_NETWORK');
  instant(network.fetchedAt);
  const patterns: Pattern[] = [];
  const routeIds = new Set<string>();
  for (const route of network.routes) {
    if (!route || !validText(route.routeId) || !validText(route.routeNumber) || !Array.isArray(route.stops) ||
      routeIds.has(route.routeId)) throw new Error('GUNPO_INVALID_NETWORK');
    routeIds.add(route.routeId);
    let previousSequence = 0;
    let previousDirection: string | null = null;
    let current: GunpoStop[] = [];
    for (const stop of route.stops) {
      if (!stop || !validText(stop.stopId) || !validText(stop.name) || !isCoordinate(stop) ||
        !Number.isSafeInteger(stop.stopSequence) || stop.stopSequence <= previousSequence) throw new Error('GUNPO_INVALID_NETWORK');
      const direction = patternDirection(stop.directionCode);
      if (previousDirection !== null && direction !== previousDirection) {
        if (current.length) patterns.push({ route, direction: previousDirection, stops: current });
        current = [];
      }
      current.push(stop);
      previousSequence = stop.stopSequence;
      previousDirection = direction;
    }
    if (current.length) patterns.push({ route, direction: previousDirection!, stops: current });
  }
  const costs = new Map<string, number>();
  for (const row of network.rideTimes ?? []) {
    if (!row || !routeIds.has(row.routeId) || !Number.isSafeInteger(row.fromSequence) ||
      !Number.isSafeInteger(row.toSequence) || row.fromSequence < 1 || row.toSequence <= row.fromSequence ||
      !Number.isSafeInteger(row.seconds) || row.seconds < 1 || !validText(row.source)) throw new Error('GUNPO_INVALID_RIDE_TIME');
    const key = rideKey(row.routeId, row.fromSequence, row.toSequence);
    if (costs.has(key)) throw new Error('GUNPO_DUPLICATE_RIDE_TIME');
    costs.set(key, row.seconds);
  }
  return { patterns, costs };
}

function arrivalIndex(snapshots: readonly GunpoArrivalSnapshot[], queryMs: number): Map<string, number[]> {
  if (!Array.isArray(snapshots)) throw new Error('GUNPO_INVALID_ARRIVALS');
  const result = new Map<string, number[]>();
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.providerId !== 'tago' || snapshot.cityCode !== '31160' ||
      !validText(snapshot.stopId) || !Array.isArray(snapshot.arrivals)) throw new Error('GUNPO_INVALID_ARRIVALS');
    const fetchedMs = instant(snapshot.fetchedAt);
    if (fetchedMs < queryMs - MAX_ARRIVAL_AGE_MS || fetchedMs > queryMs + MAX_ARRIVAL_AGE_MS) continue;
    for (const arrival of snapshot.arrivals) {
      if (!arrival || !validText(arrival.routeId) || !validText(arrival.routeNumber) ||
        !Number.isSafeInteger(arrival.arrivalSeconds) || arrival.arrivalSeconds < 0 ||
        !Number.isSafeInteger(arrival.remainingStops) || arrival.remainingStops < 0) throw new Error('GUNPO_INVALID_ARRIVALS');
      const key = JSON.stringify([snapshot.stopId, arrival.routeId, arrival.routeNumber]);
      const departureMs = fetchedMs + arrival.arrivalSeconds * 1000;
      result.set(key, [...(result.get(key) ?? []), departureMs]);
    }
  }
  for (const departures of result.values()) departures.sort((a, b) => a - b);
  return result;
}

function stationPoints(points: GunpoJourneyQuery['stationCoordinates']): Map<string, Coordinate[]> {
  const result = new Map<string, Coordinate[]>();
  for (const row of points ?? stationLocationData.points) {
    if (!validText(row.stationId) || !isCoordinate(row)) continue;
    result.set(row.stationId, [...(result.get(row.stationId) ?? []), row]);
  }
  return result;
}

function nearestDistance(from: Coordinate, points: readonly Coordinate[] | undefined): number | null {
  if (!points?.length) return null;
  return Math.min(...points.map(to => distanceMetersBetween(from, to)));
}

function shiftSubwayLegs(route: JourneyRoute, stationReadyMs: number, searchMs: number): {
  legs: JourneyLeg[]; arrivalMs: number; transferCount: number; includesWaiting: boolean;
} {
  const base = createJourneyPlan(route);
  if (!route.steps.length) throw new Error('GUNPO_INVALID_SUBWAY_ROUTE');
  const subwayStartMs = route.official ? instant(route.official.departureAt) : stationReadyMs;
  if (subwayStartMs < stationReadyMs) throw new Error('GUNPO_SUBWAY_DEPARTS_BEFORE_TRANSFER');
  const subwayArrivalMs = route.official ? instant(route.official.arrivalAt) : subwayStartMs + route.seconds * 1000;
  if (subwayArrivalMs < subwayStartMs || !Number.isFinite(route.seconds) || route.seconds < 0 ||
    (route.official && Math.abs(secondsBetween(subwayStartMs, subwayArrivalMs) - route.seconds) > 1)) {
    throw new Error('GUNPO_INVALID_SUBWAY_ROUTE');
  }
  const delta = secondsBetween(searchMs, subwayStartMs);
  const shifted = base.legs.map((item): JourneyLeg => {
    const shiftStop = (stop: JourneyStop): JourneyStop => ({ ...stop,
      plannedOffsetSeconds: stop.plannedOffsetSeconds === null ? null : stop.plannedOffsetSeconds + delta });
    const planned = item.planned;
    if (planned.startOffsetSeconds === null || planned.endOffsetSeconds === null) throw new Error('GUNPO_INVALID_SUBWAY_ROUTE');
    const startMs = subwayStartMs + planned.startOffsetSeconds * 1000;
    const endMs = subwayStartMs + planned.endOffsetSeconds * 1000;
    const shiftedTiming: PlannedTiming = {
      ...planned, startOffsetSeconds: secondsBetween(searchMs, startMs),
      endOffsetSeconds: secondsBetween(searchMs, endMs), departureAt: iso(startMs), arrivalAt: iso(endMs),
    };
    if (item.kind === 'RIDE') {
      const stops = item.stops.map(shiftStop);
      return { ...item, from: stops[0], to: stops[stops.length - 1], stops, planned: shiftedTiming };
    }
    return { ...item, from: shiftStop(item.from), to: shiftStop(item.to), planned: shiftedTiming };
  });
  return { legs: shifted, arrivalMs: subwayArrivalMs,
    transferCount: shifted.filter(item => item.kind === 'TRANSFER').length,
    includesWaiting: Boolean(route.official) };
}

function planForAccess(access: Access, query: GunpoJourneyQuery, searchMs: number): Promise<JourneyPlan | null> {
  return (async () => {
    checkAbort(query.signal);
    let legs = access.buildLegs();
    const hasAccessWalk = legs.some(item => item.kind === 'WALK');
    let arrivalMs = access.readyMs;
    let transferCount = access.transferCount;
    let includesWaiting = true;
    if (access.station.id !== query.destination.id) {
      const route = await query.getSubwayRoute(access.station, query.destination,
        query.preference ?? 'fastest', query.signal, iso(access.readyMs));
      checkAbort(query.signal);
      if (!route) return null;
      if (route.steps[0]?.station.stationId !== access.station.id ||
        route.steps[route.steps.length - 1]?.station.stationId !== query.destination.id) {
        throw new Error('GUNPO_INVALID_SUBWAY_ROUTE');
      }
      const subway = shiftSubwayLegs(route, access.readyMs, searchMs);
      const firstDepartureMs = subway.legs[0]?.planned.departureAt
        ? instant(subway.legs[0].planned.departureAt) : subway.arrivalMs;
      if (firstDepartureMs < access.readyMs) throw new Error('GUNPO_SUBWAY_DEPARTS_BEFORE_TRANSFER');
      if (firstDepartureMs > access.readyMs) {
        const atStation = point(access.station.id, access.station.name, access.readyMs, searchMs);
        const atDeparture = point(access.station.id, access.station.name, firstDepartureMs, searchMs);
        legs.push(leg('WAIT', atStation, atDeparture, access.readyMs, firstDepartureMs, searchMs,
          JSON.stringify(['subway', access.station.id])));
      }
      legs = [...legs, ...subway.legs];
      arrivalMs = subway.arrivalMs;
      transferCount += subway.transferCount;
      includesWaiting = subway.includesWaiting;
    }
    if (legs.some(item => item.planned.startOffsetSeconds === null || item.planned.endOffsetSeconds === null ||
      item.planned.durationSeconds === null)) throw new Error('GUNPO_INVALID_LEG');
    const notes = access.basis === 'DIRECT'
      ? [!hasAccessWalk ? '선택한 역에서 출발하는 지하철 경로예요.' : access.station.id === query.destination.id
        ? '가까운 역까지의 도보 시간은 직선거리 기반 추정이에요.'
        : '가까운 역까지의 도보·승강장 진입 시간은 직선거리 기반 추정이에요.']
      : ['군포 버스 시범 연결', BUS_ESTIMATE_NOTE,
        access.basis === 'ROUTE_ARRIVAL'
          ? '버스 대기는 정류장 실시간 도착정보 기준이에요.'
          : access.basis === 'POSITION_ESTIMATE'
            ? '선택한 실차 위치로 버스 승차 시각을 추정했으며 정류장 도착정보의 운행과 일치 여부는 확인되지 않았어요.'
            : '선택한 버스의 최근 위치부터 남은 구간 시간을 추정해요.'];
    if (!includesWaiting) notes.push('지하철 시간표를 확인하지 못해 대기시간은 포함되지 않았어요.');
    return {
      legs, totalSeconds: secondsBetween(searchMs, arrivalMs), searchedAt: iso(searchMs), source: 'ESTIMATE',
      departureAt: iso(searchMs), arrivalAt: iso(arrivalMs), notes,
      includesAccessAndWaiting: includesWaiting, transferCount,
    };
  })();
}

/** One bus ride at most. Arrival ETA is route-level evidence, never a vehicle or exact Trip identity. */
export async function findGunpoJourney(query: GunpoJourneyQuery): Promise<JourneyPlan | null> {
  checkAbort(query.signal);
  const searchMs = instant(query.departureAt);
  if (!query.destination || !validText(query.destination.id) ||
    !['fastest', 'fewest-transfers'].includes(query.preference ?? 'fastest') ||
    (query.origin.connectionStationId !== undefined && !validText(query.origin.connectionStationId))) {
    throw new Error('GUNPO_INVALID_QUERY');
  }
  const { patterns, costs } = checkedNetwork(query.network);
  const arrivals = arrivalIndex(query.arrivals, searchMs);
  const coordinates = stationPoints(query.stationCoordinates);
  const originPoint: Coordinate | null = query.origin.latitude === undefined && query.origin.longitude === undefined
    ? (query.origin.stationId ? coordinates.get(query.origin.stationId)?.[0] ?? null : null)
    : { latitude: query.origin.latitude!, longitude: query.origin.longitude! };
  if (!originPoint || !isCoordinate(originPoint)) throw new Error('GUNPO_INVALID_ORIGIN');
  const originName = query.origin.name ?? (query.origin.stationId ? getStation(query.origin.stationId)?.name : null) ?? '내 위치';
  const originId = query.origin.stationId ?? `gps:${JSON.stringify([originPoint.latitude, originPoint.longitude])}`;
  const connectionStationId = query.origin.connectionStationId;
  const stations = ALLOWED_STATION_IDS.filter(id => !connectionStationId || id === connectionStationId).flatMap(id => {
    const station = getStation(id);
    return station && coordinates.has(id) ? [{ station, points: coordinates.get(id)! }] : [];
  });
  const directStations = [...coordinates].flatMap(([id, points]) => {
    if (connectionStationId && id !== connectionStationId) return [];
    const station = getStation(id);
    const distance = nearestDistance(originPoint, points);
    return station && distance !== null && distance <= DIRECT_WALK_LIMIT_METERS
      ? [{ station, distance }] : [];
  }).sort((a, b) => a.distance - b.distance || a.station.id.localeCompare(b.station.id)).slice(0, 3);
  const fixed = query.fixedBus;
  if (fixed && (!validText(fixed.routeId) || !Number.isSafeInteger(fixed.boardSequence) ||
    !Number.isSafeInteger(fixed.alightSequence) || fixed.boardSequence < 1 ||
    fixed.alightSequence <= fixed.boardSequence)) throw new Error('GUNPO_INVALID_FIXED_BUS');
  const access: Access[] = [];
  if (!fixed) for (const target of directStations) {
    const isCurrentLocation = query.origin.isCurrentLocation ??
      (query.origin.latitude !== undefined && query.origin.longitude !== undefined);
    const platformSeconds = isCurrentLocation && target.station.id !== query.destination.id ? RAIL_PLATFORM_SECONDS : 0;
    const duration = walkSeconds(target.distance) + platformSeconds;
    const readyMs = searchMs + duration * 1000;
    access.push({ station: target.station, readyMs, transferCount: 0, basis: 'DIRECT', buildLegs: () => {
      if (!duration) return [];
      const from = point(originId, originName, searchMs, searchMs);
      const to = point(target.station.id, target.station.name, readyMs, searchMs);
      return [leg('WALK', from, to, searchMs, readyMs, searchMs,
        JSON.stringify(['direct', originId, target.station.id]))];
    } });
  }

  const rideSeconds = (routeId: string, from: GunpoStop, to: GunpoStop): number | null => {
    // A missing provider sequence or a direction change cannot be crossed by an inferred edge.
    if (to.stopSequence !== from.stopSequence + 1 || patternDirection(from.directionCode) !== patternDirection(to.directionCode)) return null;
    const value = costs.get(rideKey(routeId, from.stopSequence, to.stopSequence))
      ?? query.rideSeconds?.({ routeId, fromStop: from, toStop: to }) ?? null;
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('GUNPO_INVALID_RIDE_TIME');
    return value;
  };

  for (const pattern of patterns) {
    checkAbort(query.signal);
    if (fixed && pattern.route.routeId !== fixed.routeId) continue;
    const occurrences = new Map<string, number>();
    for (const stop of pattern.route.stops) occurrences.set(stop.stopId, (occurrences.get(stop.stopId) ?? 0) + 1);
    for (let originalBoardIndex = 0; originalBoardIndex < pattern.stops.length - 1; originalBoardIndex++) {
      const originalBoard = pattern.stops[originalBoardIndex];
      if (fixed && originalBoard.stopSequence !== fixed.boardSequence) continue;
      if (!fixed && occurrences.get(originalBoard.stopId) !== 1) continue;
      let boardIndex = originalBoardIndex;
      let boardReadyMs = searchMs;
      let boardDepartureMs: number;
      let boardWalkSeconds = 0;
      if (fixed?.status === 'ONBOARD') {
        const observedMs = instant(fixed.observedAt);
        if (observedMs > searchMs || searchMs - observedMs > MAX_ONBOARD_FIX_AGE_MS) continue;
        boardIndex = pattern.stops.findIndex(stop => stop.stopSequence === fixed.currentSequence);
        if (boardIndex < originalBoardIndex || boardIndex >= pattern.stops.length - 1) continue;
        boardDepartureMs = searchMs;
      } else {
        const distance = distanceMetersBetween(originPoint, originalBoard);
        if (distance > BOARD_WALK_LIMIT_METERS) continue;
        boardWalkSeconds = walkSeconds(distance);
        boardReadyMs = searchMs + boardWalkSeconds * 1000;
        if (fixed?.status === 'PLANNED') boardDepartureMs = instant(fixed.departureAt);
        else {
          const key = JSON.stringify([originalBoard.stopId, pattern.route.routeId, pattern.route.routeNumber]);
          const next = arrivals.get(key)?.find(departureMs => departureMs >= boardReadyMs);
          if (next === undefined) continue;
          boardDepartureMs = next;
        }
        if (boardDepartureMs < boardReadyMs) continue;
      }
      const board = pattern.stops[boardIndex];
      let elapsedRide = 0;
      const rideOffsets = new Map<number, number>([[board.stopSequence, 0]]);
      for (let alightIndex = boardIndex + 1; alightIndex < pattern.stops.length; alightIndex++) {
        const previous = pattern.stops[alightIndex - 1];
        const alight = pattern.stops[alightIndex];
        const segmentSeconds = rideSeconds(pattern.route.routeId, previous, alight);
        if (segmentSeconds === null) break;
        elapsedRide += segmentSeconds;
        rideOffsets.set(alight.stopSequence, elapsedRide);
        if (fixed && alight.stopSequence !== fixed.alightSequence) continue;
        const alightMs = boardDepartureMs + elapsedRide * 1000;
        for (const target of stations) {
          const distance = nearestDistance(alight, target.points);
          if (distance === null || distance > RAIL_WALK_LIMIT_METERS) continue;
          const transferWalkSeconds = walkSeconds(distance);
          const needsSubway = target.station.id !== query.destination.id;
          const platformSeconds = needsSubway ? RAIL_PLATFORM_SECONDS : 0;
          const readyMs = alightMs + (transferWalkSeconds + platformSeconds) * 1000;
          const stableLegId = `ride:${JSON.stringify(['tago', '31160', pattern.route.routeId,
            pattern.direction, originalBoard.stopSequence, alight.stopSequence])}`;
          if (fixed?.legId && fixed.legId !== stableLegId) continue;
          const buildLegs = (): JourneyLeg[] => {
            const result: JourneyLeg[] = [];
            const boardAt = busPoint(board, boardDepartureMs, searchMs);
            if (boardWalkSeconds > 0) {
              const from = point(originId, originName, searchMs, searchMs);
              const to = busPoint(originalBoard, boardReadyMs, searchMs);
              result.push(leg('WALK', from, to, searchMs, boardReadyMs, searchMs,
                JSON.stringify(['bus-access', originId, originalBoard.stopId, originalBoard.stopSequence])));
            }
            if (boardDepartureMs > boardReadyMs) {
              const from = busPoint(originalBoard, boardReadyMs, searchMs);
              const to = busPoint(originalBoard, boardDepartureMs, searchMs);
              result.push(leg('WAIT', from, to, boardReadyMs, boardDepartureMs, searchMs,
                JSON.stringify(['bus', pattern.route.routeId, originalBoard.stopSequence])));
            }
            const stops = pattern.stops.slice(boardIndex, alightIndex + 1).map((stop, index) =>
              busPoint(stop, boardDepartureMs + (rideOffsets.get(stop.stopSequence) ?? 0) * 1000, searchMs, index));
            const approachStart = Math.max(0, originalBoardIndex - 8);
            const approachStops = pattern.stops.slice(approachStart, alightIndex + 1).map((stop, index) => {
              if (stop.stopSequence >= board.stopSequence) {
                return busPoint(stop, boardDepartureMs + (rideOffsets.get(stop.stopSequence) ?? 0) * 1000, searchMs, index);
              }
              let secondsBefore = 0;
              let known = true;
              const fromIndex = pattern.stops.findIndex(candidate => candidate.stopSequence === stop.stopSequence);
              for (let i = fromIndex; i < boardIndex; i++) {
                const cost = rideSeconds(pattern.route.routeId, pattern.stops[i], pattern.stops[i + 1]);
                if (cost === null) { known = false; break; }
                secondsBefore += cost;
              }
              const result = busPoint(stop, boardDepartureMs - secondsBefore * 1000, searchMs, index);
              return known ? result : { ...result, plannedOffsetSeconds: null };
            });
            const ride: RideLeg & { boardingSequence: number } = {
              id: stableLegId, kind: 'RIDE', mode: 'BUS', line: pattern.route.routeNumber,
              routeId: pattern.route.routeId, providerId: 'tago', cityCode: '31160',
              routeType: pattern.route.routeType ?? null, direction: pattern.direction,
              boardingSequence: originalBoard.stopSequence,
              from: stops[0], to: stops[stops.length - 1], stops, approachStops,
              planned: { ...timing(boardDepartureMs, alightMs),
                startOffsetSeconds: secondsBetween(searchMs, boardDepartureMs),
                endOffsetSeconds: secondsBetween(searchMs, alightMs) },
            };
            result.push(ride);
            const stationAtWalk = point(target.station.id, target.station.name,
              alightMs + transferWalkSeconds * 1000, searchMs);
            if (transferWalkSeconds > 0) result.push(leg('WALK', stops[stops.length - 1], stationAtWalk,
              alightMs, alightMs + transferWalkSeconds * 1000, searchMs,
              JSON.stringify(['rail-access', pattern.route.routeId, alight.stopSequence, target.station.id])));
            if (platformSeconds > 0) {
              const platformReady = point(target.station.id, target.station.name, readyMs, searchMs);
              result.push(leg('TRANSFER', stationAtWalk, platformReady,
                alightMs + transferWalkSeconds * 1000, readyMs, searchMs,
                JSON.stringify(['platform', target.station.id])));
            }
            return result;
          };
          access.push({ station: target.station, readyMs, transferCount: needsSubway ? 1 : 0,
            basis: fixed?.status === 'ONBOARD' ? 'ONBOARD'
              : fixed?.status === 'PLANNED' ? 'POSITION_ESTIMATE' : 'ROUTE_ARRIVAL', buildLegs });
        }
      }
    }
  }

  // At the same station and with the same number of pre-rail transfers, arriving
  // earlier dominates a later connection: the traveller can wait for that train.
  const earliest = new Map<string, Access>();
  for (const candidate of access) {
    const key = JSON.stringify([candidate.station.id, candidate.transferCount]);
    const old = earliest.get(key);
    if (!old || candidate.readyMs < old.readyMs) earliest.set(key, candidate);
  }
  const ranked = [...earliest.values()].sort((a, b) => a.readyMs - b.readyMs || a.transferCount - b.transferCount);
  let best: JourneyPlan | null = null;
  let firstFailure: unknown = null;
  for (const candidate of ranked) {
    checkAbort(query.signal);
    try {
      const plan = await planForAccess(candidate, query, searchMs);
      if (!plan) continue;
      const transfers = plan.transferCount ?? 0;
      const bestTransfers = best?.transferCount ?? 0;
      const compare = query.preference === 'fewest-transfers'
        ? transfers - bestTransfers || plan.totalSeconds - (best?.totalSeconds ?? Infinity)
        : plan.totalSeconds - (best?.totalSeconds ?? Infinity) || transfers - bestTransfers;
      if (!best || compare < 0) best = plan;
    } catch (error) {
      if (query.signal?.aborted) throw error;
      firstFailure ??= error;
    }
  }
  if (!best && firstFailure) throw firstFailure;
  return best;
}
