import stationLocationData from '../stations/station-locations.json';
import type { Station, StationFieldValue } from '../stations/stations';
import {
  distanceMetersBetween, findNearbyStations, isCoordinate, type Coordinate, type StationMapPoint,
} from '../stations/nearby-stations';
import { findGunpoJourney, type GunpoJourneyQuery } from './gunpo-routing';
import type { JourneyLeg, JourneyPlan, JourneyStop } from './journey-plan';

export type PlaceJourneyQuery = Readonly<{
  originField: StationFieldValue;
  destinationField: StationFieldValue;
}> & Pick<GunpoJourneyQuery, 'network' | 'arrivals' | 'departureAt' | 'preference' | 'signal' |
  'getSubwayRoute' | 'rideSeconds' | 'stationCoordinates' | 'fixedBus'>;

const MAX_WALK_METERS = 3000;
const WALK_DETOUR_FACTOR = 1.25;
const WALK_METERS_PER_SECOND = 1.2;
const WALK_NOTE = '장소까지의 도보 시간은 직선거리에 보정치를 적용한 추정이며 실제 보행 경로·출입구와 다를 수 있어요.';

export function isCoordinateEndpoint(field: StationFieldValue): boolean {
  return Boolean(field.place || field.currentLocation);
}

export function endpointName(field: StationFieldValue): string {
  return field.place?.name ?? (field.currentLocation ? '내 위치' : field.station?.name ?? field.query);
}

export function endpointCoordinate(
  field: StationFieldValue,
  points: readonly StationMapPoint[] = stationLocationData.points,
): Coordinate | null {
  const selected = field.place ?? field.currentLocation;
  if (selected) return isCoordinate(selected)
    ? { latitude: selected.latitude, longitude: selected.longitude } : null;
  const point = field.station ? points.find(row => row.stationId === field.station!.id && isCoordinate(row)) : null;
  return point ? { latitude: point.latitude, longitude: point.longitude } : null;
}

export function canSearchEndpoints(origin: StationFieldValue, destination: StationFieldValue): boolean {
  const valid = (field: StationFieldValue) => isCoordinateEndpoint(field)
    ? Boolean(endpointCoordinate(field)) : Boolean(field.station);
  if (!valid(origin) || !valid(destination)) return false;
  if (!isCoordinateEndpoint(origin) && !isCoordinateEndpoint(destination)) return origin.station!.id !== destination.station!.id;
  if (origin.place && destination.place && origin.place.provider === destination.place.provider &&
    origin.place.providerPlaceId === destination.place.providerPlaceId) return false;
  return true;
}

function endpointId(field: StationFieldValue, side: 'origin' | 'destination'): string {
  if (field.place) return `place:${JSON.stringify([field.place.provider, field.place.providerPlaceId])}`;
  if (field.currentLocation) return `current-location:${side}`;
  return field.station!.id;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('PLACE_ROUTING_ABORTED');
}

function at(ms: number): string { return new Date(ms).toISOString(); }

function stop(id: string, name: string, offset: number): JourneyStop {
  return { id, name, sequence: 0, platformId: null, providerStopId: null,
    serviceSequence: null, plannedOffsetSeconds: offset };
}

function walkLeg(from: JourneyStop, to: JourneyStop, startOffset: number, seconds: number, startMs: number): JourneyLeg {
  return { id: `walk:${JSON.stringify(['endpoint', from.id, to.id])}`, kind: 'WALK', from, to,
    planned: { startOffsetSeconds: startOffset, endOffsetSeconds: startOffset + seconds,
      durationSeconds: seconds, departureAt: at(startMs + startOffset * 1000),
      arrivalAt: at(startMs + (startOffset + seconds) * 1000), source: 'ESTIMATE' } };
}

function walkingSeconds(distanceMeters: number): number {
  return Math.ceil(distanceMeters * WALK_DETOUR_FACTOR / WALK_METERS_PER_SECOND);
}

function destinations(field: StationFieldValue, points: readonly StationMapPoint[]): readonly Readonly<{
  station: Station; distanceMeters: number;
}>[] {
  if (!isCoordinateEndpoint(field)) return field.station ? [{ station: field.station, distanceMeters: 0 }] : [];
  const coordinate = endpointCoordinate(field, points);
  if (!coordinate) return [];
  const selected = field.currentLocation?.connectionStationSelected ? field.station : null;
  if (selected) {
    const stationPoints = points.filter(point => point.stationId === selected.id && isCoordinate(point));
    if (!stationPoints.length) return [];
    const distanceMeters = Math.min(...stationPoints.map(point => distanceMetersBetween(coordinate, point)));
    return distanceMeters <= MAX_WALK_METERS ? [{ station: selected, distanceMeters }] : [];
  }
  return findNearbyStations(coordinate, points, 3, MAX_WALK_METERS);
}

function destinationWalk(plan: JourneyPlan, field: StationFieldValue, station: Station, distance: number, startMs: number): JourneyPlan {
  if (!isCoordinateEndpoint(field)) return plan;
  const seconds = walkingSeconds(distance);
  const last = plan.legs[plan.legs.length - 1];
  const from = last?.to ?? stop(station.id, station.name, plan.totalSeconds);
  const to = stop(endpointId(field, 'destination'), endpointName(field), plan.totalSeconds + seconds);
  const walk = walkLeg(from, to, plan.totalSeconds, seconds, startMs);
  return { ...plan, legs: [...plan.legs, walk], totalSeconds: plan.totalSeconds + seconds,
    arrivalAt: at(startMs + (plan.totalSeconds + seconds) * 1000), source: 'ESTIMATE',
    notes: [...(plan.notes ?? []), WALK_NOTE] };
}

function directWalk(query: PlaceJourneyQuery, points: readonly StationMapPoint[], startMs: number): JourneyPlan | null {
  if (query.fixedBus || (!isCoordinateEndpoint(query.originField) && !isCoordinateEndpoint(query.destinationField)) ||
    query.originField.currentLocation?.connectionStationSelected || query.destinationField.currentLocation?.connectionStationSelected) {
    return null;
  }
  const fromPoint = endpointCoordinate(query.originField, points);
  const toPoint = endpointCoordinate(query.destinationField, points);
  if (!fromPoint || !toPoint) return null;
  const distance = distanceMetersBetween(fromPoint, toPoint);
  if (distance > MAX_WALK_METERS) return null;
  const seconds = walkingSeconds(distance);
  const from = stop(endpointId(query.originField, 'origin'), endpointName(query.originField), 0);
  const to = stop(endpointId(query.destinationField, 'destination'), endpointName(query.destinationField), seconds);
  return { legs: [walkLeg(from, to, 0, seconds, startMs)], totalSeconds: seconds, searchedAt: at(startMs),
    source: 'ESTIMATE', departureAt: at(startMs), arrivalAt: at(startMs + seconds * 1000),
    notes: [WALK_NOTE], includesAccessAndWaiting: true, transferCount: 0 };
}

function compare(a: JourneyPlan, b: JourneyPlan, preference: PlaceJourneyQuery['preference']): number {
  const transfers = (a.transferCount ?? 0) - (b.transferCount ?? 0);
  return preference === 'fewest-transfers'
    ? transfers || a.totalSeconds - b.totalSeconds
    : a.totalSeconds - b.totalSeconds || transfers;
}

/** Keep places outside the transit graph; compare rail connections with both endpoint walks included. */
export async function findPlaceJourney(query: PlaceJourneyQuery): Promise<JourneyPlan | null> {
  checkAbort(query.signal);
  const startMs = Date.parse(query.departureAt);
  if (!canSearchEndpoints(query.originField, query.destinationField) || !Number.isFinite(startMs) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(query.departureAt) ||
    !['fastest', 'fewest-transfers'].includes(query.preference ?? 'fastest')) throw new Error('PLACE_ROUTING_INVALID_QUERY');
  const points = query.stationCoordinates ?? stationLocationData.points;
  const originPoint = endpointCoordinate(query.originField, points);
  if (!originPoint) return null;
  const coordinateOrigin = isCoordinateEndpoint(query.originField);
  const originStation = coordinateOrigin ? null : query.originField.station;
  const selectedConnection = query.originField.currentLocation?.connectionStationSelected
    ? query.originField.station?.id : undefined;
  const origin: GunpoJourneyQuery['origin'] = {
    ...originPoint, endpointId: endpointId(query.originField, 'origin'), name: endpointName(query.originField),
    ...(originStation ? { stationId: originStation.id, directStationId: originStation.id } : {}),
    ...(selectedConnection ? { connectionStationId: selectedConnection } : {}),
    isCurrentLocation: Boolean(query.originField.currentLocation), requiresPlatformAccess: coordinateOrigin,
  };
  let best = directWalk(query, points, startMs);
  let firstFailure: unknown = null;
  // At most three destination stations run concurrently; each access search remains bounded by Gunpo's pruning.
  const candidates = await Promise.allSettled(destinations(query.destinationField, points).map(async destination => {
    checkAbort(query.signal);
    const plan = await findGunpoJourney({ origin, destination: destination.station,
      network: query.network, arrivals: query.arrivals, departureAt: query.departureAt,
      preference: query.preference, signal: query.signal, getSubwayRoute: query.getSubwayRoute,
      rideSeconds: query.rideSeconds, stationCoordinates: points, fixedBus: query.fixedBus });
    checkAbort(query.signal);
    return plan ? destinationWalk(plan, query.destinationField, destination.station, destination.distanceMeters, startMs) : null;
  }));
  checkAbort(query.signal);
  for (const candidate of candidates) {
    if (candidate.status === 'rejected') { firstFailure ??= candidate.reason; continue; }
    const complete = candidate.value;
    if (complete && (!best || compare(complete, best, query.preference) < 0)) best = complete;
  }
  if (!best && firstFailure) throw firstFailure;
  return best;
}
