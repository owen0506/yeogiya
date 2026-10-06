import { distanceMetersBetween, isCoordinate } from '../features/stations/nearby-stations';
import type { GunpoArrivalSnapshot, GunpoNetwork } from '../features/transit/gunpo-routing';

const CITY = '31160';
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const validTime = (x: unknown): x is string => text(x) && Number.isFinite(Date.parse(x));
const invalid = () => new Error('군포 버스 정보를 확인하지 못했어요. 지하철 경로로 다시 검색해주세요.');

export function parseGunpoNetwork(value: unknown): GunpoNetwork {
  if (!record(value) || value.providerId !== 'tago' || value.cityCode !== CITY || !validTime(value.fetchedAt)
    || !Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > 3) throw invalid();
  const ids = new Set<string>();
  for (const route of value.routes) {
    if (!record(route) || !text(route.routeId) || ids.has(route.routeId) || !text(route.routeNumber)
      || !Array.isArray(route.stops) || route.stops.length < 2 || route.stops.length > 500) throw invalid();
    ids.add(route.routeId);
    let previous = 0;
    for (const stop of route.stops) {
      if (!record(stop) || !text(stop.stopId) || !text(stop.name)
        || typeof stop.latitude !== 'number' || typeof stop.longitude !== 'number'
        || !isCoordinate({ latitude: stop.latitude, longitude: stop.longitude })
        || typeof stop.stopSequence !== 'number' || !Number.isSafeInteger(stop.stopSequence)
        || stop.stopSequence <= previous || (stop.directionCode !== undefined && !['0', '1'].includes(String(stop.directionCode)))) throw invalid();
      previous = stop.stopSequence;
    }
  }
  if (value.rideTimes !== undefined && (!Array.isArray(value.rideTimes) || value.rideTimes.some(row =>
    !record(row) || !text(row.routeId) || !ids.has(row.routeId) || !Number.isSafeInteger(row.fromSequence)
    || !Number.isSafeInteger(row.toSequence) || Number(row.toSequence) <= Number(row.fromSequence)
    || typeof row.seconds !== 'number' || !Number.isSafeInteger(row.seconds) || row.seconds <= 0 || !text(row.source)))) throw invalid();
  return value as unknown as GunpoNetwork;
}

export function parseGunpoArrivals(value: unknown, stopId: string, now = Date.now()): GunpoArrivalSnapshot {
  if (!record(value) || value.providerId !== 'tago' || value.cityCode !== CITY || value.stopId !== stopId
    || !validTime(value.fetchedAt) || now - Date.parse(value.fetchedAt) > 90_000 || Date.parse(value.fetchedAt) - now > 10_000
    || !Array.isArray(value.arrivals) || value.arrivals.length > 100) throw invalid();
  for (const row of value.arrivals) {
    if (!record(row) || !text(row.routeId) || !text(row.routeNumber)
      || typeof row.arrivalSeconds !== 'number' || !Number.isSafeInteger(row.arrivalSeconds) || row.arrivalSeconds < 0
      || typeof row.remainingStops !== 'number' || !Number.isSafeInteger(row.remainingStops) || row.remainingStops < 0) throw invalid();
  }
  return value as unknown as GunpoArrivalSnapshot;
}

async function request(path: string, signal?: AbortSignal): Promise<unknown> {
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  if (!base) throw invalid();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 12_000);
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { signal: controller.signal });
    if (!response.ok) throw invalid();
    return await response.json();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function getGunpoNetwork(signal?: AbortSignal): Promise<GunpoNetwork> {
  return parseGunpoNetwork(await request('/gunpo-bus-network', signal));
}

export function nearbyGunpoStopIds(network: GunpoNetwork, origin: { latitude: number; longitude: number }): string[] {
  const nearest = new Map<string, number>();
  for (const route of network.routes) {
    const counts = new Map<string, number>();
    for (const stop of route.stops) counts.set(stop.stopId, (counts.get(stop.stopId) ?? 0) + 1);
    for (const stop of route.stops) {
      // TAGO route arrival rows cannot identify which occurrence of a repeated
      // physical stop is approaching. Only unambiguous boarding stops are queried.
      if (counts.get(stop.stopId) !== 1) continue;
      const distance = distanceMetersBetween(origin, stop);
      if (distance <= 500) nearest.set(stop.stopId, Math.min(distance, nearest.get(stop.stopId) ?? Infinity));
    }
  }
  return [...nearest].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([id]) => id);
}

export async function getGunpoArrivals(network: GunpoNetwork, origin: { latitude: number; longitude: number }, signal?: AbortSignal) {
  const stopIds = nearbyGunpoStopIds(network, origin);
  const snapshots: GunpoArrivalSnapshot[] = [];
  let failed = 0;
  // Keep upstream requests bounded and share one snapshot per physical stop.
  for (let i = 0; i < stopIds.length; i += 3) {
    const batch = await Promise.allSettled(stopIds.slice(i, i + 3).map(async stopId => {
      const query = new URLSearchParams({ cityCode: CITY, stopId });
      return parseGunpoArrivals(await request(`/bus-arrivals?${query}`, signal), stopId);
    }));
    for (const result of batch) {
      if (result.status === 'fulfilled') snapshots.push(result.value);
      else failed++;
    }
    if (signal?.aborted) throw new Error('경로 검색이 취소됐어요.');
  }
  return { snapshots, failed, requested: stopIds.length };
}

/** Explicit pilot model, not measured averages, road distances, or a timetable. */
export function estimateGunpoRideSeconds(query: { fromStop: { latitude: number; longitude: number }; toStop: { latitude: number; longitude: number } }): number {
  const straightMeters = distanceMetersBetween(query.fromStop, query.toStop);
  return Math.max(45, Math.ceil(straightMeters * 1.3 / (15_000 / 3600) + 20));
}
