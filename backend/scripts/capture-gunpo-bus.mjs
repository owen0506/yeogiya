import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createTagoBusClient, parseTagoResponse } from '../tago-bus-client.mjs';
import { normalizeTagoBusResponse } from '../tago-bus-model.mjs';

// Bounded manual refresh. Credentials and authenticated URLs are never saved.
const readEnv = path => { try { return parseEnv(readFileSync(new URL(path, import.meta.url), 'utf8')); } catch { return {}; } };
const config = { ...readEnv('../../frontend/.env'), ...readEnv('../.env'), ...process.env };
const cityCode = '31160';
const selectedIds = ['GGB225000009', 'GGB225000006'];
const client = createTagoBusClient(config);
const fixtureDir = new URL('../fixtures/', import.meta.url);
const dataDir = new URL('../data/', import.meta.url);
mkdirSync(dataDir, { recursive: true });
const save = (name, value) => writeFileSync(new URL(name, fixtureDir), `${JSON.stringify(value, null, 2)}\n`);
const captured = (operation, query, raw) => ({ capturedAt: new Date().toISOString(), operation, query, raw });
const allowedFields = {
  routes: ['routeid', 'routeno', 'routetp', 'startnodenm', 'endnodenm', 'startvehicletime', 'endvehicletime'],
  routeStops: ['routeid', 'nodeid', 'nodenm', 'nodeno', 'nodeord', 'updowncd', 'gpslati', 'gpslong'],
  locations: ['vehicleno', 'nodeid', 'nodenm', 'nodeord', 'gpslati', 'gpslong', 'routenm', 'routetp'],
  arrivals: ['nodeid', 'nodenm', 'routeid', 'routeno', 'routetp', 'arrtime', 'arrprevstationcnt', 'vehicletp'],
  stops: ['citycode', 'nodeid', 'nodenm', 'nodeno', 'gpslati', 'gpslong'],
};
function publicRaw(kind, raw) {
  const body = raw.response.body;
  const rows = parseTagoResponse(raw).map(row => Object.fromEntries(allowedFields[kind].filter(k => row[k] !== undefined).map(k => [k, row[k]])));
  return { response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: {
    items: { item: rows }, pageNo: Number(body.pageNo), numOfRows: Number(body.numOfRows), totalCount: Number(body.totalCount),
  } } };
}
async function pages(kind, operation, query, maxPages = 4) {
  const fixtures = [], records = [];
  let count;
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const params = { ...query, pageNo, numOfRows: 100 };
    const raw = await client[kind](params);
    const total = Number(raw.response.body.totalCount);
    if (!Number.isSafeInteger(total) || total < 0 || (count !== undefined && count !== total)) throw new Error('GUNPO_PROBE_INVALID_PAGE');
    count = total;
    const rows = normalizeTagoBusResponse(kind, raw, query);
    records.push(...rows);
    fixtures.push(captured(operation, params, publicRaw(kind, raw)));
    if (records.length >= count) return { fixtures, records, totalCount: count };
    if (!rows.length) throw new Error('GUNPO_PROBE_INCOMPLETE_PAGE');
  }
  throw new Error('GUNPO_PROBE_PAGE_LIMIT');
}
try {
  const routesResult = await pages('routes', 'getRouteNoList', { cityCode });
  save('tago-gunpo-routes.json', { providerId: 'tago', cityCode, pages: routesResult.fixtures });
  const routes = [];
  for (const routeId of selectedIds) {
    const route = routesResult.records.find(row => row.routeId === routeId);
    if (!route) throw new Error('GUNPO_PROBE_ROUTE_NOT_FOUND');
    const result = await pages('routeStops', 'getRouteAcctoThrghSttnList', { cityCode, routeId });
    save(`tago-gunpo-routeStops-${routeId}.json`, { providerId: 'tago', cityCode, routeId, pages: result.fixtures });
    const stops = result.records.map(({ stopId, name, latitude, longitude, stopSequence, directionCode }) => ({
      stopId, name, latitude, longitude, stopSequence, ...(directionCode === undefined ? {} : { directionCode }),
    }));
    routes.push({ routeId, routeNumber: route.routeNumber, ...(route.routeType ? { routeType: route.routeType } : {}), stops });
    const locations = await pages('locations', 'getRouteAcctoBusLcList', { cityCode, routeId });
    save(`tago-gunpo-locations-${routeId}.json`, { providerId: 'tago', cityCode, routeId, pages: locations.fixtures });
    console.log(JSON.stringify({ kind: 'route', routeNumber: route.routeNumber, routeId, stopCount: stops.length,
      directions: [...new Set(stops.map(s => s.directionCode))], anchors: stops.filter(s => /금정역|산본역/.test(s.name)), locationCount: locations.records.length }));
  }
  const fetchedAt = new Date().toISOString();
  const network = { providerId: 'tago', cityCode, fetchedAt, routes };
  writeFileSync(new URL('gunpo-bus-network.json', dataDir), `${JSON.stringify(network, null, 2)}\n`);
  const anchors = [...new Map(routes.flatMap(r => r.stops).filter(s => /금정역|산본역/.test(s.name)).map(s => [s.stopId, s])).values()].slice(0, 1);
  for (const stop of anchors) {
    const arrivals = await pages('arrivals', 'getSttnAcctoArvlPrearngeInfoList', { cityCode, nodeId: stop.stopId });
    save(`tago-gunpo-arrivals-${stop.stopId}.json`, { providerId: 'tago', cityCode, stopId: stop.stopId, pages: arrivals.fixtures });
    console.log(JSON.stringify({ kind: 'arrivals', stopId: stop.stopId, stopName: stop.name, count: arrivals.records.length }));
  }
  if (anchors.length) {
    const anchor = anchors[0];
    const params = { gpsLati: anchor.latitude, gpsLong: anchor.longitude, pageNo: 1, numOfRows: 100 };
    const raw = await client.stops(params);
    save('tago-gunpo-nearby-stops.json', captured('getCrdntPrxmtSttnList', params, publicRaw('stops', raw)));
    console.log(JSON.stringify({ kind: 'nearby-stops', count: normalizeTagoBusResponse('stops', raw).length }));
  }
  console.log(JSON.stringify({ status: 'complete', routeCount: routes.length, fetchedAt, rideTimes: 'not-provided-by-these-apis' }));
} catch (error) {
  const code = typeof error?.message === 'string' && /^(TAGO_BUS|GUNPO_PROBE)_[A-Z0-9_]+$/.test(error.message) ? error.message : 'GUNPO_PROBE_FAILED';
  console.log(JSON.stringify({ status: 'failed', code }));
  process.exitCode = 1;
}
