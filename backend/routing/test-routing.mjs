import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createKakaoRoutingProvider, normalizeKakaoRoutes } from './kakao-routing-provider.mjs';
import { compareBenchmarkRoutes } from './external-routing-provider.mjs';
import { handleBenchmarkRoute } from './benchmark-endpoint.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kakao-reference.json', import.meta.url), 'utf8'));
const query = { origin: { longitude: Number(fixture.query.start_x), latitude: Number(fixture.query.start_y) },
  destination: { longitude: Number(fixture.query.end_x), latitude: Number(fixture.query.end_y) } };
const env = { KAKAO_REST_API_KEY: 'test-only-key' };
const ok = raw => ({ ok: true, json: async () => raw });

test('fixture excludes authentication and geometry; frontend and graph costs do not import benchmark provider', () => {
  assert.doesNotMatch(JSON.stringify(fixture), /Authorization|KakaoAK|apiKey|REST_API_KEY|test-only-key|"path"|"points"/i);
  const root = new URL('../../frontend/src/', import.meta.url);
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]);
  for (const url of walk(root).filter(u => /\.[jt]sx?$/.test(u.pathname))) {
    assert.doesNotMatch(readFileSync(url, 'utf8'), /KAKAO_REST_API_KEY|kakao-routing-provider|benchmark-endpoint|external-routing-provider/);
  }
  for (const file of ['kakao-routing-provider.mjs', 'external-routing-provider.mjs', 'benchmark-endpoint.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /route-service|bus-graph|route-costs|BusRideCostProvider/);
  }
});

test('real UTF-8 fixture normalizes all modes, metrics and names without path or raw fields', () => {
  const routes = normalizeKakaoRoutes(fixture.raw);
  assert.equal(routes.length, 2);
  const route = routes[0];
  assert.equal(route.provider, 'KAKAO');
  assert.equal(route.totalSeconds, fixture.raw.routes[0].properties.totalTime);
  assert.equal(route.transferCount, fixture.raw.routes[0].properties.transfers);
  assert.equal(routes[1].transferCount, 0);
  assert.deepEqual(route.legs.map(l => l.type), ['SUBWAY', 'WALK', 'BUS']);
  assert.deepEqual(route.legs[0].stopNames, ['판교', '성남', '이매']);
  assert.equal(route.legs[0].fromName, '판교'); assert.equal(route.legs[0].toName, '이매');
  assert.deepEqual(route.legs[0].routeNames, ['경강선']);
  assert.deepEqual(route.legs[2].routeNames, ['51', '220', '17', '17-1', '119', '119-1']);
  for (let i = 0; i < route.legs.length; i++) {
    assert.equal(route.legs[i].seconds, fixture.raw.routes[0].steps[i].properties.time);
    assert.equal(route.legs[i].distanceMeters, fixture.raw.routes[0].steps[i].properties.distance);
  }
  assert.equal(route.walkingSeconds, 334);
  assert.notEqual(route.totalSeconds, route.legs.reduce((s, l) => s + l.seconds, 0));
  assert.equal(routes[1].walkingSeconds, undefined);
  const withPath = structuredClone(fixture.raw);
  withPath.routes[0].steps[0].path = { points: [[127, 37]] };
  assert.deepEqual(normalizeKakaoRoutes(withPath), routes);
  assert.doesNotMatch(JSON.stringify(routes), /path|points|guidance|landingURL|KakaoAK|test-only-key/);
});

test('missing totals/transfers stay unknown; missing walking time is not zero', () => {
  const raw = structuredClone(fixture.raw);
  delete raw.routes[0].properties.totalTime;
  delete raw.routes[0].properties.transfers;
  delete raw.routes[0].steps[1].properties.time;
  const route = normalizeKakaoRoutes(raw)[0];
  assert.equal(route.totalSeconds, undefined);
  assert.equal(route.transferCount, undefined);
  assert.equal(route.walkingSeconds, undefined);
});

test('normalizer rejects malformed shape, unknown mode and invalid numbers', () => {
  for (const value of [null, {}, { status: 'OK', routes: [] }, { status: 'OK', routes: [{}] }]) assert.throws(() => normalizeKakaoRoutes(value), /INVALID_RESPONSE/);
  assert.throws(() => normalizeKakaoRoutes({ status: 'NO_RESULTS' }), /NO_RESULTS/);
  for (const change of [
    r => { r.routes[0].steps[0].properties.type = 'FUTURE_MODE'; },
    r => { r.routes[0].properties.totalTime = -1; },
    r => { r.routes[0].properties.transfers = 1.5; },
    r => { r.routes[0].steps[0].properties.time = '270'; },
    r => { r.routes[0].steps[0].properties.distance = Infinity; },
    r => { r.routes[0].steps[0].properties.stops = [{}]; },
    r => { r.routes[0].steps[0].properties.vehicles = 'invalid'; },
  ]) { const raw = structuredClone(fixture.raw); change(raw); assert.throws(() => normalizeKakaoRoutes(raw), /INVALID_RESPONSE/); }
});

test('client validates configuration/coordinates and sends credentials only in header', async () => {
  assert.throws(() => createKakaoRoutingProvider({}), /NOT_CONFIGURED/);
  for (const endpoint of ['http://dapi.kakao.com/v2/routing/publictraffic', 'https://other.example/', 'https://dapi.kakao.com/v2/routing/publictraffic?key=secret']) {
    assert.throws(() => createKakaoRoutingProvider({ ...env, KAKAO_TRANSIT_ROUTE_ENDPOINT: endpoint }), /INVALID_ENDPOINT/);
  }
  let calls = 0;
  const provider = createKakaoRoutingProvider(env, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'KakaoAK test-only-key');
    assert.equal(options.redirect, 'error');
    assert.doesNotMatch(url.href, /test-only-key/);
    for (const [k, v] of Object.entries(fixture.query)) assert.equal(url.searchParams.get(k), v);
    return ok(fixture.raw);
  } });
  assert.deepEqual(await provider.searchRoute(query), normalizeKakaoRoutes(fixture.raw));
  await assert.rejects(provider.searchRoute({ ...query, origin: { longitude: 181, latitude: 37 } }), /INVALID_QUERY/);
  await assert.rejects(provider.searchRoute({ ...query, departureTime: '2026-09-25T09:00:00+09:00' }), /DEPARTURE_TIME_UNSUPPORTED/);
  assert.equal(calls, 1);
});

test('client sanitizes HTTP/JSON/network failures and supports timeout/cancellation including body read', async () => {
  for (const [fetchImpl, code] of [
    [async () => ({ ok: false }), 'BENCHMARK_HTTP_ERROR'],
    [async () => ({ ok: true, json: async () => { throw Error('test-only-key'); } }), 'BENCHMARK_INVALID_JSON'],
    [async () => { throw Error('test-only-key'); }, 'BENCHMARK_UNAVAILABLE'],
  ]) await assert.rejects(createKakaoRoutingProvider(env, { fetchImpl }).searchRoute(query), { message: code });
  const blocked = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('secret')), { once: true }));
  // Keep the event loop alive: AbortSignal.timeout intentionally uses an unref timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(createKakaoRoutingProvider(env, { fetchImpl: blocked, timeoutMs: 10 }).searchRoute(query), /BENCHMARK_TIMEOUT/);
    const bodyBlocked = async (_, options) => ({ ok: true, json: () => blocked(_, options) });
    await assert.rejects(createKakaoRoutingProvider(env, { fetchImpl: bodyBlocked, timeoutMs: 10 }).searchRoute(query), /BENCHMARK_TIMEOUT/);
    const controller = new AbortController();
    const pending = createKakaoRoutingProvider(env, { fetchImpl: blocked }).searchRoute(query, { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, /BENCHMARK_ABORTED/);
  } finally { clearInterval(keepAlive); }
});

test('comparison is Yeogiya minus benchmark, with safe missing metrics', () => {
  assert.deepEqual(compareBenchmarkRoutes({ totalSeconds: 2520, transferCount: 1, walkingSeconds: 100 }, { totalSeconds: 2340, transferCount: 2, walkingSeconds: 100 }),
    { totalSecondsDiff: 180, transferCountDiff: -1, walkingSecondsDiff: 0 });
  for (const value of [undefined, null, NaN, Infinity, -1, '100']) {
    assert.equal(compareBenchmarkRoutes({ totalSeconds: value }, { totalSeconds: 10 }).totalSecondsDiff, undefined);
    assert.equal(compareBenchmarkRoutes({ totalSeconds: 10 }, { totalSeconds: value }).totalSecondsDiff, undefined);
  }
});

test('HTTP benchmark endpoint returns normalized reference only; errors remain isolated', async () => {
  let calls = 0;
  const server = createServer((req, res) => handleBenchmarkRoute(new URL(req.url, 'http://localhost'), res, env,
    () => createKakaoRoutingProvider(env, { fetchImpl: async () => { calls++; return ok(fixture.raw); } })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/benchmark-route`;
  try {
    const response = await fetch(`${base}?${new URLSearchParams(fixture.query)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), normalizeKakaoRoutes(fixture.raw)[0]);
    assert.equal((await fetch(base)).status, 400);
    assert.equal((await fetch(`${base}?${new URLSearchParams({ ...fixture.query, start_x: 'NaN' })}`)).status, 400);
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
