import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createGunpoBusService, loadGunpoBusNetwork, validateGunpoBusNetwork } from './gunpo-bus.mjs';
import { parseTagoResponse } from './tago-bus-client.mjs';
import { normalizeTagoBusResponse } from './tago-bus-model.mjs';
import { server } from './seoul-proxy.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const stopId = 'GGB225000047';
const config = { TAGO_BUS_API_KEY: 'unit-test-secret', TAGO_BUS_ARRIVAL_ENDPOINT: 'https://apis.data.go.kr/test/arrival' };
const params = stop => new URLSearchParams({ cityCode: '31160', stopId: stop });
const arrivalsRaw = () => structuredClone(fixture(`tago-gunpo-arrivals-${stopId}`).pages[0].raw);

test('captured Gunpo routes retain every provider sequence and repeated stop occurrence', () => {
  const network = loadGunpoBusNetwork();
  assert.equal(network.cityCode, '31160');
  assert.deepEqual(network.routes.map(r => [r.routeNumber, r.stops.length]), [['30', 96], ['31', 75]]);
  assert.equal('rideTimes' in network, false);
  for (const route of network.routes) {
    const source = fixture(`tago-gunpo-routeStops-${route.routeId}`);
    const rows = source.pages.flatMap(page => normalizeTagoBusResponse('routeStops', page.raw, page.query));
    assert.equal(rows.length, Number(source.pages[0].raw.response.body.totalCount));
    assert.deepEqual(route.stops.map(s => [s.stopId, s.stopSequence, s.latitude, s.longitude]),
      rows.map(s => [s.stopId, s.stopSequence, s.latitude, s.longitude]));
    assert.ok(route.stops.every(s => s.directionCode === undefined));
  }
  const thirty = network.routes[0];
  assert.deepEqual(thirty.stops.filter(s => s.stopId === stopId).map(s => s.stopSequence), [15, 36]);
  assert.ok(thirty.stops.some(s => s.name === '금정역'));
  assert.ok(network.routes[1].stops.some(s => s.name === '산본역'));
  assert.ok(Object.isFrozen(network.routes[0].stops));
});

test('Gunpo snapshots reject a missing/duplicate sequence and unsupported coordinate/cost records', () => {
  for (const mutate of [
    x => { x.routes[0].stops.splice(2, 1); },
    x => { x.routes[0].stops[1].stopSequence = 1; },
    x => { x.routes.push(structuredClone(x.routes[0])); },
    x => { x.routes[0].stops[0].latitude = 0; },
    x => { x.routes[0].stops[0].directionCode = 'unknown'; },
    x => { x.rideTimes = [{ routeId: x.routes[0].routeId, fromSequence: 1, toSequence: 3, seconds: 1, source: 'test' }]; },
  ]) {
    const data = structuredClone(loadGunpoBusNetwork()); mutate(data);
    assert.throws(() => validateGunpoBusNetwork(data), /GUNPO_BUS_INVALID_NETWORK/);
  }
});

test('live arrivals use the stop endpoint, retain route estimates, and exclude routes outside the pilot', async () => {
  let requested;
  const raw = arrivalsRaw();
  assert.equal(parseTagoResponse(raw).length, 6);
  const service = createGunpoBusService({ config, now: () => new Date('2026-10-06T08:10:00Z'), fetchImpl: async url => {
    requested = url;
    return Response.json(raw);
  } });
  const result = await service.getArrivals(params(stopId));
  assert.equal(requested.pathname, '/test/arrival/getSttnAcctoArvlPrearngeInfoList');
  assert.equal(requested.searchParams.get('cityCode'), '31160');
  assert.equal(requested.searchParams.get('nodeId'), stopId);
  assert.equal(requested.searchParams.get('numOfRows'), '100');
  const routes = new Set(service.getNetwork().routes.map(r => r.routeId));
  const expected = normalizeTagoBusResponse('arrivals', raw, { cityCode: '31160', nodeId: stopId })
    .filter(row => routes.has(row.routeId)).map(({ routeId, routeNumber, arrivalSeconds, remainingStops }) => ({ routeId, routeNumber, arrivalSeconds, remainingStops }));
  assert.deepEqual(result.arrivals, expected);
  assert.equal(result.fetchedAt, '2026-10-06T08:10:00.000Z');
  assert.equal(result.stopId, stopId);
  assert.doesNotMatch(JSON.stringify(result), /unit-test-secret|serviceKey|vehicleno|tripId/);
});

test('arrival caching coalesces concurrent reads, expires after 20 seconds, and never serves stale failures', async () => {
  let ms = Date.parse('2026-10-06T08:10:00Z'), calls = 0, fail = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createGunpoBusService({ config, now: () => new Date(ms), fetchImpl: async () => {
    calls += 1;
    if (calls === 1) await gate;
    if (fail) throw new Error('authenticated private URL unit-test-secret');
    return Response.json(arrivalsRaw());
  } });
  const first = service.getArrivals(params(stopId)), second = service.getArrivals(params(stopId));
  release();
  const values = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.strictEqual(values[0], values[1]);
  ms += 19_999; await service.getArrivals(params(stopId)); assert.equal(calls, 1);
  ms += 1; fail = true;
  await assert.rejects(service.getArrivals(params(stopId)), { message: 'TAGO_BUS_UNAVAILABLE' });
  assert.equal(calls, 2);
  fail = false; await service.getArrivals(params(stopId)); assert.equal(calls, 3);
});

test('Gunpo arrivals block unsupported cities/stops and duplicate parameters before contacting a provider', async () => {
  const service = createGunpoBusService({ fetchImpl: () => assert.fail('must not make an external request') });
  for (const query of ['cityCode=23&stopId=GGB225000047', 'cityCode=31160&stopId=bad%20stop',
    'cityCode=31160&stopId=GGB225000047&stopId=GGB225000052', 'cityCode=31160&stopId=GGB225000047&routeId=x']) {
    await assert.rejects(service.getArrivals(new URLSearchParams(query)), /GUNPO_BUS_INVALID_QUERY/);
  }
  await assert.rejects(service.getArrivals(params('GGB000000000')), /GUNPO_BUS_STOP_NOT_SUPPORTED/);
  assert.throws(() => service.assertRoute('unknown'), /GUNPO_BUS_ROUTE_NOT_SUPPORTED/);
});

test('arrival endpoint rejects wrong stops/pagination and bounds total pages', async () => {
  for (const mutate of [
    x => { x.response.body.items.item[0].nodeid = 'wrong'; },
    x => { x.response.body.pageNo = 2; },
    x => { x.response.body.totalCount += 1; },
  ]) {
    const raw = arrivalsRaw(); mutate(raw);
    const service = createGunpoBusService({ config, fetchImpl: async () => Response.json(raw) });
    await assert.rejects(service.getArrivals(params(stopId)), /TAGO_BUS_INVALID_DATA/);
  }
});

test('captured Gunpo fixtures contain public records without authenticated request material', () => {
  const folder = new URL('./fixtures/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.startsWith('tago-gunpo-'))) {
    const contents = readFileSync(new URL(name, folder), 'utf8');
    assert.doesNotMatch(contents, /serviceKey|TAGO_BUS_API_KEY|apikey|authorization|unit-test-secret/i);
    const data = JSON.parse(contents);
    for (const page of data.pages ?? [data]) {
      assert.ok(Number.isFinite(Date.parse(page.capturedAt)));
      assert.equal(page.raw.response.header.resultCode, '00');
    }
  }
});

test('HTTP Gunpo network is available without an upstream call and queries are strictly scoped', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/gunpo-bus-network`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).routes.map(r => r.routeNumber), ['30', '31']);
    for (const path of ['/gunpo-bus-network?cityCode=23', '/bus-arrivals?cityCode=23&stopId=GGB225000047',
      '/bus-arrivals?cityCode=31160&stopId=GGB000000000',
      '/bus-vehicles?cityCode=31160&routeId=GGB000000000&nearSequence=1']) {
      const result = await fetch(base + path);
      assert.equal(result.status, 400);
      assert.doesNotMatch(JSON.stringify(await result.json()), /serviceKey|apikey/i);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
