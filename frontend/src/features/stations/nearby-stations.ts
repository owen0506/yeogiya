import { getStation, type NearbyStation } from './stations';

export type Coordinate = Readonly<{ latitude: number; longitude: number }>;
export type StationMapPoint = Coordinate & Readonly<{ stationId: string }>;
export const NEARBY_STATION_RADIUS_METERS = 3000;

export function isCoordinate(point: Coordinate): boolean {
  return Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

// Distance is geographic straight-line distance, not a walking route.
export function distanceMetersBetween(from: Coordinate, to: Coordinate): number {
  if (!isCoordinate(from) || !isCoordinate(to)) throw new Error('위치 좌표를 확인할 수 없어요.');
  const radians = Math.PI / 180;
  const latitude = (to.latitude - from.latitude) * radians;
  const longitude = (to.longitude - from.longitude) * radians;
  const a = Math.sin(latitude / 2) ** 2 + Math.cos(from.latitude * radians) *
    Math.cos(to.latitude * radians) * Math.sin(longitude / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

export function findNearbyStations(
  position: Coordinate,
  points: readonly StationMapPoint[],
  limit = 3,
  maxDistanceMeters = NEARBY_STATION_RADIUS_METERS,
): NearbyStation[] {
  if (!isCoordinate(position)) throw new Error('위치 좌표를 확인할 수 없어요.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isFinite(maxDistanceMeters) || maxDistanceMeters < 0) {
    throw new Error('주변 역 검색 범위가 올바르지 않아요.');
  }
  const matches = new Map<string, NearbyStation>();
  for (const point of points) {
    const station = getStation(point.stationId);
    if (!station || !isCoordinate(point)) continue;
    const distanceMeters = distanceMetersBetween(position, point);
    if (distanceMeters > maxDistanceMeters) continue;
    const previous = matches.get(station.id);
    if (!previous || distanceMeters < previous.distanceMeters) matches.set(station.id, { station, distanceMeters });
  }
  return [...matches.values()].sort((a, b) => a.distanceMeters - b.distanceMeters || a.station.id.localeCompare(b.station.id)).slice(0, limit);
}

export function formatNearbyDistance(meters: number): string {
  return meters < 1000 ? `${Math.max(10, Math.round(meters / 10) * 10)}m` : `${(meters / 1000).toFixed(1)}km`;
}
