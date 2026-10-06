import { readFileSync } from 'node:fs';
import { createTagoBusClient } from './tago-bus-client.mjs';
import { normalizeTagoBusResponse } from './tago-bus-model.mjs';

export const gunpoCityCode = '31160';
const invalid = () => { throw new Error('GUNPO_BUS_INVALID_NETWORK'); };
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// A full provider sequence is preserved, including repeated physical stops.
// Direction is retained only when provided; it is never guessed from a sequence.
export function validateGunpoBusNetwork(value) {
  if (!value || value.providerId !== 'tago' || value.cityCode !== gunpoCityCode || !timestamp(value.fetchedAt)
    || !Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > 20) invalid();
  const seenRoutes = new Set();
  const routes = value.routes.map(route => {
    if (!route || !id(route.routeId) || seenRoutes.has(route.routeId) || !text(route.routeNumber)
      || (route.routeType !== undefined && !text(route.routeType))
      || !Array.isArray(route.stops) || route.stops.length < 2 || route.stops.length > 500) invalid();
    seenRoutes.add(route.routeId);
    const stops = route.stops.map((stop, index) => {
      if (!stop || !id(stop.stopId) || !text(stop.name) || stop.stopSequence !== index + 1
        || !Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)
        || stop.latitude < 33 || stop.latitude > 39 || stop.longitude < 124 || stop.longitude > 132
        || (stop.directionCode !== undefined && !['0', '1'].includes(stop.directionCode))) invalid();
      return { stopId: stop.stopId, name: stop.name, latitude: stop.latitude, longitude: stop.longitude,
        stopSequence: stop.stopSequence, ...(stop.directionCode === undefined ? {} : { directionCode: stop.directionCode }) };
    });
    return { routeId: route.routeId, routeNumber: route.routeNumber,
      ...(route.routeType === undefined ? {} : { routeType: route.routeType }), stops };
  });
  let rideTimes;
  if (value.rideTimes !== undefined) {
    if (!Array.isArray(value.rideTimes)) invalid();
    const seenCosts = new Set();
    rideTimes = value.rideTimes.map(row => {
      const route = routes.find(r => r.routeId === row?.routeId);
      const key = `${row?.routeId}:${row?.fromSequence}:${row?.toSequence}`;
      if (!route || seenCosts.has(key) || !Number.isInteger(row.fromSequence) || row.fromSequence < 1
        || row.toSequence !== row.fromSequence + 1 || row.toSequence > route.stops.length
        || !Number.isSafeInteger(row.seconds) || row.seconds < 1 || !text(row.source)) invalid();
      seenCosts.add(key);
      return { routeId: row.routeId, fromSequence: row.fromSequence, toSequence: row.toSequence, seconds: row.seconds, source: row.source };
    });
  }
  return freeze({ providerId: 'tago', cityCode: gunpoCityCode, fetchedAt: value.fetchedAt, routes,
    ...(rideTimes === undefined ? {} : { rideTimes }) });
}

export function loadGunpoBusNetwork() {
  return validateGunpoBusNetwork(JSON.parse(readFileSync(new URL('./data/gunpo-bus-network.json', import.meta.url), 'utf8')));
}

export function createGunpoBusService({ network = loadGunpoBusNetwork(), config = {}, fetchImpl = fetch,
  now = () => new Date(), cacheTtlMs = 20_000 } = {}) {
  const snapshot = validateGunpoBusNetwork(network);
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 60_000) throw new Error('GUNPO_BUS_INVALID_CACHE');
  const allowedRoutes = new Set(snapshot.routes.map(route => route.routeId));
  const allowedStops = new Set(snapshot.routes.flatMap(route => route.stops.map(stop => stop.stopId)));
  const cache = new Map(), pending = new Map();
  const assertRoute = routeId => {
    if (!allowedRoutes.has(routeId)) throw new Error('GUNPO_BUS_ROUTE_NOT_SUPPORTED');
  };
  async function fetchArrivals(stopId) {
    const client = createTagoBusClient(config, fetchImpl, { services: ['ARRIVAL'] });
    const rows = [];
    let total;
    for (let pageNo = 1; pageNo <= 3; pageNo += 1) {
      const raw = await client.arrivals({ cityCode: gunpoCityCode, nodeId: stopId, pageNo, numOfRows: 100 });
      const body = raw.response.body;
      const count = Number(body.totalCount);
      if (!Number.isSafeInteger(count) || count < 0 || (total !== undefined && total !== count)
        || Number(body.pageNo) !== pageNo || Number(body.numOfRows) !== 100) throw new Error('TAGO_BUS_INVALID_DATA');
      total = count;
      const page = normalizeTagoBusResponse('arrivals', raw, { cityCode: gunpoCityCode, nodeId: stopId });
      if (page.length !== Math.min(100, Math.max(0, total - (pageNo - 1) * 100))) throw new Error('TAGO_BUS_INVALID_DATA');
      rows.push(...page);
      if (rows.length >= total) {
        const fetchedAt = now().toISOString();
        return freeze({ providerId: 'tago', cityCode: gunpoCityCode, stopId, fetchedAt,
          arrivals: rows.filter(row => allowedRoutes.has(row.routeId)).map(row => ({ routeId: row.routeId,
            routeNumber: row.routeNumber, arrivalSeconds: row.arrivalSeconds, remainingStops: row.remainingStops })) });
      }
    }
    throw new Error('GUNPO_BUS_ARRIVALS_INCOMPLETE');
  }
  return Object.freeze({
    getNetwork: () => snapshot,
    assertRoute,
    async getArrivals(params) {
      if (!(params instanceof URLSearchParams) || params.getAll('cityCode').length !== 1 || params.getAll('stopId').length !== 1
        || [...params.keys()].some(name => !['cityCode', 'stopId'].includes(name))
        || params.get('cityCode') !== gunpoCityCode || !id(params.get('stopId'))) throw new Error('GUNPO_BUS_INVALID_QUERY');
      const stopId = params.get('stopId');
      if (!allowedStops.has(stopId)) throw new Error('GUNPO_BUS_STOP_NOT_SUPPORTED');
      const cached = cache.get(stopId);
      const time = now().getTime();
      if (cached && time >= cached.savedAt && time - cached.savedAt < cacheTtlMs) return cached.value;
      if (pending.has(stopId)) return pending.get(stopId);
      const request = fetchArrivals(stopId).then(value => {
        cache.set(stopId, { savedAt: now().getTime(), value });
        return value;
      }).finally(() => pending.delete(stopId));
      pending.set(stopId, request);
      return request;
    },
  });
}
