import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createTagoBusClient, parseTagoResponse } from './tago-bus-client.mjs';
import { normalizeTagoBusResponse } from './tago-bus-model.mjs';
import { buildBusSnapshot, loadBusSnapshot } from './bus-snapshot.mjs';

test('bus snapshot uses actual route/pages and exposes normalized partial segments only', () => {
  const snapshot = loadBusSnapshot();
  assert.equal(snapshot.routes.length, 1);
  const route = snapshot.routes[0];
  assert.equal(route.routeId, 'ICB161000002');
  assert.equal(route.routeNumber, '6777');
  assert.equal(route.cityCode, '23');
  assert.equal(route.totalStops, 30); assert.equal(route.loadedStops, 6); assert.equal(route.partial, true);
  assert.deepEqual(route.directions.map(d => [d.direction, d.segments[0].stops.map(s => s.sequence)]), [['0', [1, 2, 3]], ['1', [28, 29, 30]]]);
  assert.doesNotMatch(JSON.stringify(snapshot), /nodeid|nodeord|updowncd|serviceKey|patternId|arrtime/);
  assert.deepEqual(buildBusSnapshot(fixture('routes'), [fixture('routeStops-return'), fixture('routeStops')]), snapshot);
});

test('bus snapshot rejects duplicates, bad ordering, missing direction, wrong pagination and unknown routes', () => {
  const route = fixture('routes');
  const original = fixture('routeStops');
  assert.throws(() => buildBusSnapshot(route, [original, original]), /BUS_SNAPSHOT_INVALID_DATA/);
  for (const mutate of [
    f => { f.raw.response.body.items.item[1].nodeord = 1; },
    f => { f.raw.response.body.items.item.reverse(); },
    f => { delete f.raw.response.body.items.item[0].updowncd; },
    f => { f.raw.response.body.pageNo = 2; },
    f => { f.raw.response.body.items.item.pop(); },
    f => { f.query.routeId = 'unmatched'; },
  ]) {
    const f = structuredClone(original); mutate(f);
    assert.throws(() => buildBusSnapshot(route, [f]), /BUS_SNAPSHOT_INVALID_DATA/);
  }
});

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/tago-bus-${name}.json`, import.meta.url), 'utf8'));
// These URLs/credentials are test doubles only; fetch is always injected below.
const env = Object.fromEntries(['STOP', 'ROUTE', 'ARRIVAL', 'LOCATION'].map(service => [`TAGO_BUS_${service}_ENDPOINT`, `https://apis.data.go.kr/test/${service}`]));
env.TAGO_BUS_API_KEY = 'test%2Bkey%2F%3D';
const ok = raw => ({ ok: true, json: async () => raw });

test('TAGO configuration errors name the missing variable without exposing values', () => {
  for (const name of Object.keys(env)) {
    const copy = { ...env }; delete copy[name];
    assert.throws(() => createTagoBusClient(copy), { message: `TAGO_BUS_MISSING_${name}` });
  }
  for (const url of ['http://apis.data.go.kr/test', 'https://other.example/test', 'https://user:password@apis.data.go.kr/test', 'https://apis.data.go.kr/test?serviceKey=secret']) {
    assert.throws(() => createTagoBusClient({ ...env, TAGO_BUS_STOP_ENDPOINT: url }), { message: 'TAGO_BUS_INVALID_TAGO_BUS_STOP_ENDPOINT' });
  }
});

test('all four clients use configured endpoints, documented operations and backend-only credentials', async () => {
  const cases = [
    ['routes', 'ROUTE', 'getRouteNoList'], ['routeStops', 'ROUTE', 'getRouteAcctoThrghSttnList'],
    ['stops', 'STOP', 'getCrdntPrxmtSttnList'], ['arrivals', 'ARRIVAL', 'getSttnAcctoArvlPrearngeInfoList'],
    ['locations', 'LOCATION', 'getRouteAcctoBusLcList'],
  ];
  for (const [method, service, operation] of cases) {
    const saved = fixture(method);
    const client = createTagoBusClient(env, async (url, options) => {
      assert.equal(url.origin + url.pathname, `${env[`TAGO_BUS_${service}_ENDPOINT`]}/${operation}`);
      assert.equal(url.searchParams.get('serviceKey'), 'test+key/=');
      assert.equal(url.searchParams.get('_type'), 'json');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      for (const [key, value] of Object.entries(saved.query)) assert.equal(url.searchParams.get(key), String(value));
      return ok(saved.raw);
    });
    assert.deepEqual(await client[method]({ ...saved.query, serviceKey: 'ignored' }), saved.raw);
  }
});

test('TAGO failures, invalid bodies and cancellation are sanitized', async () => {
  const query = fixture('routes').query;
  for (const [fetchImpl, message] of [
    [async () => { throw new Error('secret URL test+key/='); }, 'TAGO_BUS_UNAVAILABLE'],
    [async () => ({ ok: false }), 'TAGO_BUS_HTTP_ERROR'],
    [async () => ({ ok: true, json: async () => { throw new Error('secret XML'); } }), 'TAGO_BUS_INVALID_RESPONSE'],
    [async () => ok({ response: { header: { resultCode: '30', resultMsg: 'secret' } } }), 'TAGO_BUS_UPSTREAM_ERROR'],
    [async () => ok({}), 'TAGO_BUS_INVALID_RESPONSE'],
  ]) await assert.rejects(createTagoBusClient(env, fetchImpl).routes(query), { message });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createTagoBusClient(env, async (_, options) => { options.signal.throwIfAborted(); }).routes(query, { signal: controller.signal }), { message: 'TAGO_BUS_ABORTED' });
  await assert.rejects(createTagoBusClient(env, () => assert.fail('must not fetch')).routes({}), /INVALID_QUERY/);
  await assert.rejects(createTagoBusClient(env, () => assert.fail('must not fetch')).routes({ ...query, numOfRows: 101 }), /INVALID_QUERY/);
});

test('TAGO envelope supports actual arrays/singletons and explicit empty results, rejects malformed items', () => {
  assert.equal(parseTagoResponse(fixture('stops').raw).length, 3);
  assert.equal(parseTagoResponse(fixture('arrivals').raw).length, 1);
  for (const items of ['', {}, { item: '' }]) assert.deepEqual(parseTagoResponse({ response: { header: { resultCode: '00' }, body: { items, totalCount: 0 } } }), []);
  for (const body of [{}, { items: { item: [null] } }, { items: { item: 'bad' }, totalCount: 1 }, { items: { unexpected: true }, totalCount: 0 }]) {
    assert.throws(() => parseTagoResponse({ response: { header: { resultCode: '00' }, body } }), /INVALID_RESPONSE/);
  }
});

test('actual fixtures normalize without collapsing stop IDs, inventing patterns or vehicle IDs', () => {
  const normalize = name => { const f = fixture(name); return normalizeTagoBusResponse(name, f.raw, f.query); };
  const stops = normalize('stops');
  assert.equal(stops[0].name, stops[1].name);
  assert.equal(stops[0].latitude, stops[1].latitude);
  assert.notEqual(stops[0].stopId, stops[1].stopId);
  assert.equal(stops[0].cityCode, '23');
  const route = normalize('routes')[0];
  assert.equal(route.routeId, 'ICB161000002');
  assert.equal(route.routeNumber, '6777');
  assert.equal('patternId' in route, false);
  const outbound = normalize('routeStops');
  assert.deepEqual(outbound.map(row => row.stopSequence), [1, 2, 3]);
  assert.ok(outbound.every(row => row.directionCode === '0'));
  const inboundFixture = fixture('routeStops-return');
  const inbound = normalizeTagoBusResponse('routeStops', inboundFixture.raw, inboundFixture.query);
  assert.deepEqual(inbound.map(row => row.stopSequence), [28, 29, 30]);
  assert.ok(inbound.every(row => row.directionCode === '1'));
  const arrival = normalize('arrivals')[0];
  assert.equal(arrival.arrivalSeconds, 447);
  assert.equal(arrival.remainingStops, 1);
  assert.equal('vehicleId' in arrival, false);
  const location = normalize('locations')[0];
  assert.equal(location.routeId, route.routeId);
  assert.equal(location.vehicleNumber, '인천70바4029');
  assert.equal('directionCode' in location, false);
  assert.equal('routeid' in parseTagoResponse(fixture('locations').raw)[0], false);
});

test('normalization rejects bad data/context, preserves repeated-stop occurrences and raw data', () => {
  const f = fixture('routeStops'); const original = JSON.stringify(f.raw);
  const first = f.raw.response.body.items.item[0];
  f.raw.response.body.items.item[1].nodeid = first.nodeid;
  const rows = normalizeTagoBusResponse('routeStops', f.raw, f.query);
  assert.equal(rows[0].stopId, rows[1].stopId);
  assert.notEqual(rows[0].stopSequence, rows[1].stopSequence);
  delete first.updowncd;
  assert.equal('directionCode' in normalizeTagoBusResponse('routeStops', f.raw, f.query)[0], false);
  for (const changes of [{ gpslati: null }, { gpslong: 200 }, { nodeord: -1 }, { updowncd: 2 }, { routeid: 'wrong-route' }, { nodeid: '' }]) {
    const raw = JSON.parse(original); Object.assign(raw.response.body.items.item[0], changes);
    assert.throws(() => normalizeTagoBusResponse('routeStops', raw, f.query), /INVALID_DATA/);
  }
  const fresh = fixture('routeStops'); normalizeTagoBusResponse('routeStops', fresh.raw, fresh.query);
  assert.equal(JSON.stringify(fresh.raw), original);
  assert.throws(() => normalizeTagoBusResponse('locations', fixture('locations').raw, { cityCode: 23 }), /INVALID_DATA/);
  assert.throws(() => normalizeTagoBusResponse('arrivals', fixture('arrivals').raw, { cityCode: 23, nodeId: 'wrong-stop' }), /INVALID_DATA/);
});

test('frontend source has no TAGO key access or backend bus imports; fixtures contain no authentication parameters', () => {
  function walk(url) {
    return readdirSync(url, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(new URL(`${entry.name}/`, url)) : [new URL(entry.name, url)]);
  }
  for (const root of ['../frontend/src/']) {
    for (const file of walk(new URL(root, import.meta.url)).filter(url => /\.[cm]?[jt]sx?$/.test(url.pathname))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /TAGO_BUS_API_KEY|tago-bus-client|tago-bus-model/);
    }
  }
  for (const name of ['stops', 'routes', 'routeStops', 'routeStops-return', 'arrivals', 'locations']) {
    assert.doesNotMatch(JSON.stringify(fixture(name)), /serviceKey|TAGO_BUS_API_KEY/i);
  }
});
