import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTDataClient } from './t-data-client.mjs';
import { parseTDataSectionTimes, parseTDataRouteStops, parseTDataRouteMaster, parseTDataStopMaster, parseTDataBisRouteInfo } from './t-data-model.mjs';
import { matchTaimsBisRoute, matchTaimsBisStop } from './t-data-crosswalk.mjs';
import { buildTDataBusRideSnapshot } from './t-data-mapping.mjs';
import { loadBusSnapshot } from './bus-snapshot.mjs';

const fixture = kind => JSON.parse(readFileSync(new URL(`./fixtures/t-data-${kind}.json`, import.meta.url), 'utf8')).raw;
const env = { T_DATA_API_KEY: 'test-only-secret', T_DATA_BUS_SECTION_TIME_ENDPOINT: 'http://t-data.seoul.go.kr/test-section', T_DATA_ROUTE_STOP_ENDPOINT: 'https://t-data.seoul.go.kr/test-master' };

test('actual new masters parse names, identifiers, stop numbers and unverified XY coordinates', () => {
  const routes = parseTDataRouteMaster(fixture('route_master-page1'));
  assert.deepEqual(routes[0], { providerId: 'seoul-taims', routeId: '113900011', name: '마포05', routeType: '마을', distanceValue: 2.1 });
  assert.ok(routes.every(r => !('startStopName' in r)));
  const stops = parseTDataStopMaster(fixture('stop_master-page1'));
  assert.equal(stops[0].stopId, '122900102'); assert.equal(stops[0].name, '강남신동아파밀리에2단지');
  assert.equal(stops[0].number, '23893');
  assert.deepEqual(stops[0].coordinates, { x: 127.101712859, y: 37.4646017803, crs: 'unknown' });
  assert.equal('latitude' in stops[0], false);
  const bis = parseTDataBisRouteInfo(fixture('bis_route-candidate'));
  assert.equal(bis[0].name, '서초13'); assert.equal(bis[0].routeType, '마을');
  assert.equal(bis[0].startStopName, '이수역'); assert.equal(bis[0].endStopName, '동덕여고');
  for (const invalid of [null, '', false, 'NaN']) assert.throws(() => parseTDataStopMaster([{ ...fixture('stop_master-page1')[0], crdntX: invalid }]), /INVALID_RESPONSE/);
});

test('actual target filter probes did not isolate the requested IDs; never create a crosswalk', () => {
  assert.deepEqual(fixture('route_master-filter-probe'), fixture('route_master-page1'));
  assert.deepEqual(fixture('stop_master-filter-probe'), fixture('stop_master-page1'));
  assert.deepEqual(fixture('bis_route-filter-probe'), fixture('bis_route-candidate'));
  assert.ok(!fixture('route_master-filter-probe').some(r => r.routeId === '100100252'));
  assert.ok(!fixture('stop_master-filter-probe').some(r => ['120000670', '120000041'].includes(r.sttnId)));
  assert.deepEqual(matchTaimsBisRoute(parseTDataRouteMaster(fixture('route_master-page1')),
    parseTDataBisRouteInfo(fixture('bis_route-candidate')), '100100252'), { status: 'missing', reason: 'source-not-loaded' });
});

test('new client services use environment endpoints, reject unsupported filters and detect ignored BIS filters', async () => {
  const configured = { ...env, T_DATA_ROUTE_MASTER_ENDPOINT: 'https://t-data.seoul.go.kr/test-routes',
    T_DATA_STOP_MASTER_ENDPOINT: 'https://t-data.seoul.go.kr/test-stops', T_DATA_BIS_ROUTE_INFO_ENDPOINT: 'https://t-data.seoul.go.kr/test-bis' };
  const client = createTDataClient(configured, async url => Response.json(fixture(
    url.pathname === '/test-routes' ? 'route_master-page1' : url.pathname === '/test-stops' ? 'stop_master-page1' : 'bis_route-candidate')));
  assert.equal((await client.routeMaster()).length, 3); assert.equal((await client.stopMaster()).length, 3);
  await assert.rejects(client.bisRouteInfo({ route_id: '100100252' }), /T_DATA_FILTER_MISMATCH/);
  await assert.rejects(client.bisRouteInfo({ route_nm: '없는노선' }), /T_DATA_FILTER_MISMATCH/);
  await assert.rejects(client.routeMaster({ routeId: '100100252' }), /INVALID_QUERY/);
  await assert.rejects(client.stopMaster({ sttnId: '120000670' }), /INVALID_QUERY/);
  assert.equal((await client.bisRouteInfo({})).length, 3); // Unfiltered pages support targeted lookup.
  for (const method of ['routeMaster', 'stopMaster', 'bisRouteInfo']) await assert.rejects(createTDataClient(env)[method]({}), /T_DATA_MISSING/);
});

test('synthetic route crosswalk requires identity evidence, not equal provider IDs', () => {
  const taims = { providerId: 'seoul-taims', routeId: 'source-test', name: 'test-route', routeType: '간선', startStopName: 'A', endStopName: 'B' };
  const bis = { ...taims, providerId: 'seoul-bis', routeId: 'different-test' };
  const matched = matchTaimsBisRoute([taims], [bis], taims.routeId);
  assert.equal(matched.status, 'matched'); assert.equal(matched.crosswalk.bisRouteId, 'different-test');
  assert.equal(matchTaimsBisRoute([taims], [bis, bis], taims.routeId).reason, 'ambiguous-route');
  assert.equal(matchTaimsBisRoute([{ ...taims, endStopName: undefined }], [bis], taims.routeId).reason, 'unconfirmed-termini');
  assert.equal(matchTaimsBisRoute([taims], [{ ...bis, name: 'other', routeId: taims.routeId }], taims.routeId).status, 'missing');
  assert.equal(matchTaimsBisRoute([taims], [{ ...bis, routeType: '마을' }], taims.routeId).status, 'missing');
  const stop = { providerId: 'seoul-taims', routeId: taims.routeId, stopId: 'source-stop', name: 'test-stop', number: '00123' };
  const target = { ...stop, providerId: 'seoul-bis', routeId: bis.routeId, stopId: 'different-stop' };
  assert.equal(matchTaimsBisStop(stop, [target], matched).status, 'matched');
  assert.equal(matchTaimsBisStop(stop, [target, target], matched).reason, 'ambiguous-stop');
  assert.equal(matchTaimsBisStop(stop, [{ ...target, number: '00999' }], matched).status, 'missing');
  assert.equal(matchTaimsBisStop(stop, [target], { status: 'missing' }).reason, 'unverified-route');
});

test('T-Data config, bounded queries, HTTPS and actual response', async () => {
  for (const name of Object.keys(env)) assert.throws(() => createTDataClient({ ...env, [name]: '' }), /T_DATA_MISSING/);
  assert.throws(() => createTDataClient({ ...env, T_DATA_BUS_SECTION_TIME_ENDPOINT: 'https://example.com/' }), /INVALID_ENDPOINT/);
  const client = createTDataClient(env, async (url, options) => {
    assert.equal(url.protocol, 'https:'); assert.equal(url.searchParams.get('apikey'), env.T_DATA_API_KEY);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return Response.json(fixture('section_time'));
  });
  assert.equal((await client.sectionTimes({ stdrDe: '20260801' })).length, 3);
  await assert.rejects(client.sectionTimes({ stdrDe: '20260801', rowCnt: 100 }), /INVALID_QUERY/);
  const master = createTDataClient(env, async url => {
    assert.equal(url.searchParams.get('routeId'), '100100252');
    return Response.json(fixture('route_stop'));
  });
  assert.equal((await master.routeStops({ routeId: '100100252' })).length, 2);
});

test('T-Data HTTP, JSON, shape and sanitized network errors', async () => {
  for (const [fetcher, expected] of [
    [async () => new Response('private upstream body', { status: 403 }), 'HTTP_ERROR'],
    [async () => new Response('<html>'), 'INVALID_JSON'],
    [async () => Response.json({ error: 'denied' }), 'INVALID_RESPONSE'],
    [async () => { throw new Error(env.T_DATA_API_KEY); }, 'REQUEST_FAILED'],
  ]) await assert.rejects(createTDataClient(env, fetcher).sectionTimes({ stdrDe: '20260801' }), error => {
    assert.equal(error.message, `T_DATA_${expected}`); assert.ok(!error.message.includes(env.T_DATA_API_KEY)); return true;
  });
});

test('T-Data cancellation and timeout', async () => {
  const waiting = (_url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => resolve(Response.json([])), 1000);
    const abort = () => { clearTimeout(keepAlive); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createTDataClient(env, waiting).routeStops({ routeId: '100100252' }, { signal: controller.signal }), /T_DATA_ABORTED/);
  await assert.rejects(createTDataClient(env, waiting, { timeoutMs: 5 }).sectionTimes({ stdrDe: '20260801' }), /T_DATA_TIMEOUT/);
});

test('history requires explicit endpoint, route and valid reference date; sends bounded queries', async () => {
  const query = { routeId: '100100252', stdrDe: '20260801', startRow: 1, rowCnt: 3 };
  await assert.rejects(createTDataClient(env).stopHistory(query), /MISSING_T_DATA_BUS_STOP_HISTORY_ENDPOINT/);
  let calls = 0;
  const client = createTDataClient({ ...env, T_DATA_BUS_STOP_HISTORY_ENDPOINT: 'https://t-data.seoul.go.kr/test-history' }, async url => {
    calls++;
    assert.equal(url.pathname, '/test-history');
    assert.equal(url.searchParams.get('routeId'), query.routeId);
    assert.equal(url.searchParams.get('stdrDe'), query.stdrDe);
    assert.equal(url.searchParams.get('rowCnt'), '3');
    return Response.json([]); // Mock transport, not an actual history fixture.
  });
  assert.deepEqual(await client.stopHistory(query), []);
  for (const patch of [{ stdrDe: undefined }, { routeId: undefined }, { stdrDe: '20260230' }, { rowCnt: 1001 }]) {
    await assert.rejects(client.stopHistory({ ...query, ...patch }), /INVALID_QUERY/);
  }
  assert.equal(calls, 1);
});

test('actual Seoul master confirms section 25→26, independently of unsupported TAGO mapping', async () => {
  const master = parseTDataRouteStops(fixture('route_stop-seoul-page1'));
  const section = parseTDataSectionTimes(fixture('section_time')).find(x => x.externalRouteId === '100100252');
  assert.equal(master.find(x => x.sequence === 25).externalStopId, section.fromExternalStopId);
  assert.equal(master.find(x => x.sequence === 26).externalStopId, section.toExternalStopId);
  const { loadTDataBusRideSnapshot } = await import('./t-data-snapshot.mjs');
  const result = loadTDataBusRideSnapshot();
  assert.equal(result.snapshot.records.length, 0);
  assert.ok(!result.rejected.find(x => x.index === 1).reasons.includes('master-segment-unconfirmed'));
  assert.ok(result.rejected.find(x => x.index === 1).reasons.includes('missing-mapping'));
  const cities = JSON.parse(readFileSync(new URL('./fixtures/tago-bus-cities.json', import.meta.url), 'utf8'));
  assert.equal(cities.raw.response.body.items.item.some(x => x.cityname.includes('서울')), false);
});

test('actual requested-date history is empty: no inferred events, samples or costs', async () => {
  const saved = JSON.parse(readFileSync(new URL('./fixtures/t-data-stop_history-seoul-page1.json', import.meta.url), 'utf8'));
  assert.equal(saved.query.routeId, '100100252');
  assert.equal(saved.query.stdrDe, '20260801');
  assert.deepEqual(saved.raw, []);
  const client = createTDataClient({ ...env, T_DATA_BUS_STOP_HISTORY_ENDPOINT: 'https://t-data.seoul.go.kr/test-history' }, async () => Response.json(saved.raw));
  assert.deepEqual(await client.stopHistory(saved.query), []);
  const { loadTDataBusRideSnapshot } = await import('./t-data-snapshot.mjs');
  assert.deepEqual(loadTDataBusRideSnapshot().snapshot.records, []);
});

test('actual JSON names parse without inventing units, names, direction or counts', () => {
  const rows = parseTDataSectionTimes(fixture('section_time'));
  assert.equal(rows.length, 3); assert.equal(rows[1].value, 87);
  assert.equal(rows[1].referenceDate, '2026-08-01');
  assert.equal(rows[1].hours.find(x => x.hour === 13).value, 150);
  assert.equal('seconds' in rows[1], false); assert.equal('sampleCount' in rows[1], false);
  assert.deepEqual(parseTDataRouteStops(fixture('route_stop')).map(x => x.sequence), [11, 12]);
  for (const bad of [0, null, -1, 'NaN', '', false, Infinity]) {
    const raw = { ...fixture('section_time')[0], tripTime: bad, tripTime04h: bad };
    const [row] = parseTDataSectionTimes([raw]);
    assert.equal(row.value, undefined); assert.ok(!row.hours.some(x => x.hour === 4));
  }
  assert.throws(() => parseTDataSectionTimes([{ ...fixture('section_time')[0], fromStaSn: 'bad' }]), /INVALID_RESPONSE/);
});

test('actual samples remain unconnected: no verified unit or TAGO crosswalk', () => {
  const result = buildTDataBusRideSnapshot({ sectionRaw: fixture('section_time'), masterRaw: fixture('route_stop'), topology: loadBusSnapshot() });
  assert.deepEqual(result.snapshot, { version: 1, records: [] });
  assert.equal(result.rejected.length, 3);
  assert.ok(result.rejected.every(r => r.reasons.includes('unverified-time-semantics') && r.reasons.includes('missing-mapping')));
});

// Synthetic contract tests only: these assertions do not verify production units/mapping.
function scenario() {
  const topology = loadBusSnapshot(), r = topology.routes[0], d = r.directions[0];
  const [a, b] = d.segments[0].stops;
  const sectionRaw = [{ routeId: '1', fromStaId: '10', toStaId: '11', fromStaSn: '1', toStaSn: '2', stdrDe: '20260801', tripTime: '90', tripTime07h: '95', tripTime08h: '131', tripTime09h: '0' }];
  const masterRaw = [{ routeId: '1', nodeId: '10', sttnSn: '1' }, { routeId: '1', nodeId: '11', sttnSn: '2' }];
  const target = { providerId: r.providerId, cityCode: r.cityCode, routeId: r.routeId, direction: d.direction,
    fromStopId: a.stopId, fromSequence: a.sequence, toStopId: b.stopId, toSequence: b.sequence };
  return { topology, sectionRaw, masterRaw, crosswalk: [{ source: { routeId: '1', fromStopId: '10', toStopId: '11', fromSequence: 1, toSequence: 2 }, target,
    evidence: { route: 'synthetic route proof', fromStop: 'synthetic stop proof', toStop: 'synthetic stop proof', direction: 'synthetic ordered topology proof' } }],
    semantics: { unit: 'seconds', statistic: 'test-mean', measure: 'directed-adjacent-travel-time', timeZone: 'Asia/Seoul', evidence: 'synthetic semantics proof' } };
}

test('reviewed mapping gates conversion and preserves directed hourly records', () => {
  const input = scenario(), result = buildTDataBusRideSnapshot(input);
  assert.equal(result.rejected.length, 0); assert.equal(result.snapshot.records.length, 3);
  assert.deepEqual(result.snapshot.records.map(r => r.seconds), [90, 95, 131]);
  assert.deepEqual(result.snapshot.records.slice(1).map(r => r.timeBucket), [{ startHour: 7, endHour: 8 }, { startHour: 8, endHour: 9 }]);
  assert.ok(result.snapshot.records.every(r => r.direction === '0' && r.fromSequence === 1 && r.toSequence === 2));
  input.semantics.unit = 'minutes';
  assert.equal(buildTDataBusRideSnapshot(input).snapshot.records[0].seconds, 5400);
  input.semantics.unit = 'unknown';
  assert.equal(buildTDataBusRideSnapshot(input).snapshot.records.length, 0);
});

test('wrong route, endpoints, sequence, direction, missing evidence and ambiguity reject mapping', () => {
  for (const mutate of [
    x => x.crosswalk.push(structuredClone(x.crosswalk[0])),
    x => { x.crosswalk[0].source.routeId = '2'; },
    x => { x.crosswalk[0].source.fromStopId = '12'; },
    x => { x.crosswalk[0].target.direction = '1'; },
    x => { x.crosswalk[0].target.toSequence = 3; },
    x => { delete x.crosswalk[0].evidence.direction; },
    x => { x.masterRaw[1].nodeId = '12'; },
    x => { x.masterRaw.push(x.masterRaw[0]); },
    x => { x.sectionRaw[0].toStaSn = '3'; },
    x => { [x.crosswalk[0].target.fromStopId, x.crosswalk[0].target.toStopId] = [x.crosswalk[0].target.toStopId, x.crosswalk[0].target.fromStopId]; },
  ]) { const input = scenario(); mutate(input); assert.equal(buildTDataBusRideSnapshot(input).snapshot.records.length, 0); }
});
