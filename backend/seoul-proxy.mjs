import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { fetchOfficialRoute } from './route-provider.mjs';
import { loadSegmentSnapshot } from './segment-snapshot.mjs';
import { handleBenchmarkRoute } from './routing/benchmark-endpoint.mjs';
import { createTagoBusClient } from './tago-bus-client.mjs';
import { normalizeTagoBusResponse } from './tago-bus-model.mjs';

// 사용자가 이미 프런트엔드 .env에 저장한 비공개 키도 서버에서만 읽습니다.
const readEnv = (path) => { try { return parseEnv(readFileSync(new URL(path, import.meta.url), 'utf8')); } catch { return {}; } };
const env = { ...readEnv('../frontend/.env'), ...readEnv('./.env'), ...process.env };

// 개발용 중계 서버. 서울시 키는 프런트엔드에 전달하지 않습니다.
const port = Number(env.PORT || 8083);
const origin = env.FRONTEND_ORIGIN || 'http://localhost:8081';
const key = env.SEOUL_SUBWAY_API_KEY;
const segmentSnapshot = loadSegmentSnapshot();

const busVehicleRange = 8;
const busVehiclePageSize = 100;
const busVehicleMaxPages = 3;
const busVehicleMaxResults = 30;

/** TAGO's vehicleNumber identifies a reported bus, not a scheduled Trip. */
export async function fetchBusVehicles(params, config = env, fetchImpl = fetch, now = () => new Date()) {
  const cityCode = params.get('cityCode')?.trim();
  const routeId = params.get('routeId')?.trim();
  const nearSequenceValue = params.get('nearSequence')?.trim();
  if (['cityCode', 'routeId', 'nearSequence'].some(name => params.getAll(name).length !== 1)
    || !/^[1-9]\d{0,5}$/.test(cityCode || '')
    || !/^[A-Za-z0-9_-]{1,64}$/.test(routeId || '')
    || !/^[1-9]\d{0,3}$/.test(nearSequenceValue || '')) throw new Error('BUS_VEHICLES_INVALID_QUERY');
  const nearSequence = Number(nearSequenceValue);
  const sequenceRange = { from: Math.max(1, nearSequence - busVehicleRange), to: nearSequence + busVehicleRange };
  const client = createTagoBusClient(config, fetchImpl, { services: ['LOCATION'] });
  const nearby = [];
  const seen = new Set();
  let loadedCount = 0, totalCount = null, pagesFetched = 0;
  for (let pageNo = 1; pageNo <= busVehicleMaxPages; pageNo += 1) {
    const raw = await client.locations({ cityCode, routeId, pageNo, numOfRows: busVehiclePageSize });
    const body = raw.response.body;
    if (body.pageNo !== undefined && Number(body.pageNo) !== pageNo) throw new Error('TAGO_BUS_INVALID_DATA');
    if (body.totalCount !== undefined && body.totalCount !== null) {
      const value = String(body.totalCount);
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('TAGO_BUS_INVALID_DATA');
      if (totalCount !== null && Number(value) !== totalCount) throw new Error('TAGO_BUS_INVALID_DATA');
      totalCount = Number(value);
    }
    const vehicles = normalizeTagoBusResponse('locations', raw, { cityCode, routeId });
    pagesFetched += 1;
    loadedCount += vehicles.length;
    for (const vehicle of vehicles) {
      if (vehicle.stopSequence < sequenceRange.from || vehicle.stopSequence > sequenceRange.to) continue;
      const identity = `${vehicle.vehicleNumber}\u0000${vehicle.stopSequence}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      nearby.push(vehicle);
    }
    if (totalCount !== null && loadedCount >= totalCount) break;
    if (vehicles.length === 0) break;
  }
  nearby.sort((a, b) => a.stopSequence - b.stopSequence || a.vehicleNumber.localeCompare(b.vehicleNumber));
  return {
    providerId: 'tago', cityCode, routeId, nearSequence,
    fetchedAt: now().toISOString(), sequenceRange,
    vehicles: nearby.slice(0, busVehicleMaxResults),
    coverage: {
      totalCount, pagesFetched, loadedCount,
      partial: totalCount === null || loadedCount < totalCount || nearby.length > busVehicleMaxResults,
    },
  };
}

const busVehicleError = error => {
  const code = error?.message;
  if (code === 'BUS_VEHICLES_INVALID_QUERY') return [400, 'INVALID_QUERY'];
  if (code?.startsWith('TAGO_BUS_MISSING_')) return [503, 'TAGO_BUS_NOT_CONFIGURED'];
  if (code?.startsWith('TAGO_BUS_INVALID_TAGO_BUS_') || code === 'TAGO_BUS_INVALID_API_KEY') return [503, 'TAGO_BUS_INVALID_CONFIGURATION'];
  if (['TAGO_BUS_INVALID_DATA', 'TAGO_BUS_INVALID_RESPONSE'].includes(code)) return [502, 'TAGO_BUS_INVALID_DATA'];
  if (['TAGO_BUS_UPSTREAM_ERROR', 'TAGO_BUS_HTTP_ERROR'].includes(code)) return [502, 'TAGO_BUS_UPSTREAM_ERROR'];
  return [502, 'TAGO_BUS_UNAVAILABLE'];
};

export const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', origin);
  const reply = (status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); };
  if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: 'ORIGIN_NOT_ALLOWED' });
  if (req.method !== 'GET') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/benchmark-route') return handleBenchmarkRoute(url, res, env);
  if (url.pathname === '/segment-times') return reply(200, segmentSnapshot);
  if (url.pathname === '/bus-vehicles') {
    try { return reply(200, await fetchBusVehicles(url.searchParams)); }
    catch (error) {
      const [status, code] = busVehicleError(error);
      return reply(status, { error: code });
    }
  }
  if (url.pathname === '/health') return reply(200, { configured: Boolean(key), routesConfigured: Boolean(env.SUBWAY_API_KEY) });
  if (url.pathname === '/route') {
    const from = url.searchParams.get('from')?.trim(), to = url.searchParams.get('to')?.trim();
    const preference = url.searchParams.get('preference') || 'fastest';
    const validStation = (value) => value && value.length <= 50 && /^[가-힣a-zA-Z0-9()·,\s]+$/.test(value);
    if (!validStation(from) || !validStation(to) || from === to || !['fastest', 'fewest-transfers'].includes(preference)) return reply(400, { error: 'INVALID_QUERY' });
    try { return reply(200, await fetchOfficialRoute({ from, to, preference }, env)); }
    catch (error) {
      const code = ['ROUTE_API_NOT_CONFIGURED', 'ROUTE_API_INVALID_ENDPOINT', 'ROUTE_API_UNAVAILABLE', 'ROUTE_API_NO_RESULT', 'ROUTE_API_INVALID_DATA'].includes(error.message) ? error.message : 'ROUTE_API_UNAVAILABLE';
      return reply(code === 'ROUTE_API_NOT_CONFIGURED' ? 503 : 502, { error: code });
    }
  }
  const endpoints = { '/arrivals': ['realtimeStationArrival', 'station'], '/positions': ['realtimePosition', 'line'] };
  const endpoint = endpoints[url.pathname];
  if (!endpoint) return reply(404, { error: 'NOT_FOUND' });
  const value = url.searchParams.get(endpoint[1])?.trim();
  if (!value || value.length > 50 || !/^[가-힣a-zA-Z0-9()·,\s]+$/.test(value)) return reply(400, { error: 'INVALID_QUERY' });
  if (!key) return reply(503, { error: 'API_KEY_NOT_CONFIGURED' });
  try {
    const response = await fetch(`http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(key)}/json/${endpoint[0]}/0/100/${encodeURIComponent(value)}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return reply(502, { error: 'UPSTREAM_ERROR' });
    reply(200, await response.json());
  } catch {
    // 원본 오류에는 키가 포함된 URL이 들어갈 수 있어 로그/응답에 노출하지 않습니다.
    reply(502, { error: 'UPSTREAM_UNAVAILABLE' });
  }
});
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, env.HOST || '127.0.0.1', () => console.log(`Subway proxy ready on port ${port}; arrivals ${key ? 'configured' : 'not configured'}; routes ${env.SUBWAY_API_KEY ? 'configured' : 'not configured'}`));
}
