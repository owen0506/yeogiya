import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupTDataTargets } from './t-data-lookup.mjs';
import { createTDataClient } from './t-data-client.mjs';
import { readFileSync } from 'node:fs';
import { parseTDataRouteMaster, parseTDataStopMaster, parseTDataRouteStops, parseTDataSectionTimes } from './t-data-model.mjs';

const data = Array.from({ length: 9 }, (_, i) => ({ routeId: String(i + 1), routeNm: `name-${i + 1}` }));
function paged(mode) {
  const calls = [];
  return { calls, routeMaster: async query => {
    calls.push(query);
    const offset = mode === 'offset' ? query.startRow - 1 : (query.startRow - 1) * query.rowCnt;
    return data.slice(offset, offset + query.rowCnt);
  } };
}
const options = { service: 'routeMaster', targetValues: ['8'], rowCnt: 3, maxRequests: 10 };

test('targeted pagination determines page-number behavior and stops immediately at target', async () => {
  const client = paged('page-number'); const result = await lookupTDataTargets(client, options);
  assert.equal(result.reason, 'targets-found'); assert.equal(result.pagination, 'page-number');
  assert.deepEqual(client.calls.map(q => q.startRow), [1, 2, 3]);
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].raw.routeId, '8');
  assert.equal(result.requests[1].overlapWithPrevious, 0);
  assert.ok(!JSON.stringify(result).includes('name-1')); // Non-target rows never retained in result.
});

test('offset probe observes overlap and advances by returned batch size without skipping', async () => {
  const client = paged('offset'); const result = await lookupTDataTargets(client, options);
  assert.equal(result.reason, 'targets-found'); assert.equal(result.pagination, 'offset');
  assert.deepEqual(client.calls.map(q => q.startRow), [1, 2, 5, 8]);
  assert.equal(result.requests[1].overlapWithPrevious, 2);
  const multiple = await lookupTDataTargets(paged('offset'), { ...options, targetValues: ['2', '8'] });
  assert.equal(multiple.matches[0].requestNumber, 1); // Keep first discovery despite probe overlap.
});

test('first-page target stops without unnecessary probing; multiple targets stop only when all found', async () => {
  const client = paged('page-number');
  const one = await lookupTDataTargets(client, { ...options, targetValues: ['1'] });
  assert.equal(one.requestCount, 1); assert.equal(one.pagination, 'undetermined');
  const both = await lookupTDataTargets(paged('page-number'), { ...options, targetValues: ['1', '8'] });
  assert.equal(both.requestCount, 3); assert.deepEqual(both.matches.map(x => x.value), ['1', '8']);
});

test('empty, repeated page, maximum requests, ambiguous overlap and errors all stop', async () => {
  const cases = [
    [{ routeMaster: async () => [] }, {}, 'empty-page', 1],
    [{ routeMaster: async () => data.slice(0, 3) }, {}, 'repeated-page', 2],
    [paged('page-number'), { maxRequests: 2 }, 'max-requests', 2],
    [{ routeMaster: async ({ startRow }) => startRow === 1 ? data.slice(0, 3) : [data[0], data[4], data[5]] }, {}, 'ambiguous-pagination', 2],
    [{ routeMaster: async () => { throw new Error('secret must not escape'); } }, {}, 'api-error', 1],
  ];
  for (const [client, extra, reason, count] of cases) {
    const result = await lookupTDataTargets(client, { ...options, ...extra });
    assert.equal(result.reason, reason); assert.equal(result.requestCount, count);
    assert.doesNotMatch(JSON.stringify(result), /secret must not escape/);
  }
});

test('only initial 400/413 size rejection reduces rowCnt; auth errors and abort do not retry', async () => {
  let calls = 0;
  const client = { routeMaster: async ({ rowCnt }) => {
    calls++; if (rowCnt > 100) throw Object.assign(new Error('T_DATA_HTTP_ERROR'), { status: 413 });
    return data;
  } };
  const result = await lookupTDataTargets(client, { ...options, rowCnt: 1000 });
  assert.equal(result.reason, 'targets-found'); assert.equal(calls, 2);
  assert.deepEqual(result.requests.map(x => x.rowCnt), [1000, 100]);
  const denied = await lookupTDataTargets({ routeMaster: async () => { throw Object.assign(new Error('T_DATA_HTTP_ERROR'), { status: 403 }); } }, { ...options, rowCnt: 1000 });
  assert.equal(denied.requestCount, 1);
  const controller = new AbortController(); controller.abort();
  assert.equal((await lookupTDataTargets(client, { ...options, signal: controller.signal })).requestCount, 0);
});

test('BIS name lookup returns only candidate and rejects multiple same-name records on a page', async () => {
  const result = await lookupTDataTargets({ bisRouteInfo: async () => data.slice(0, 3) }, { ...options, service: 'bisRouteInfo', matchField: 'routeNm', targetValues: ['name-2'] });
  assert.equal(result.matches[0].raw.routeId, '2'); assert.equal('crosswalk' in result, false);
  const ambiguous = await lookupTDataTargets({ bisRouteInfo: async () => [data[0], { ...data[1], routeNm: data[0].routeNm }] },
    { ...options, service: 'bisRouteInfo', matchField: 'routeNm', targetValues: ['name-1'] });
  assert.equal(ambiguous.reason, 'ambiguous-target');
});

test('client allows bounded master batches, preserves small history limit and rejects invented filters', async () => {
  const env = { T_DATA_API_KEY: 'test', T_DATA_BUS_SECTION_TIME_ENDPOINT: 'https://t-data.seoul.go.kr/section',
    T_DATA_ROUTE_STOP_ENDPOINT: 'https://t-data.seoul.go.kr/stops', T_DATA_ROUTE_MASTER_ENDPOINT: 'https://t-data.seoul.go.kr/routes',
    T_DATA_BIS_ROUTE_INFO_ENDPOINT: 'https://t-data.seoul.go.kr/bis' };
  const client = createTDataClient(env, async () => Response.json([]));
  assert.deepEqual(await client.routeMaster({ rowCnt: 1000 }), []);
  await assert.rejects(client.routeMaster({ rowCnt: 1001 }), /INVALID_QUERY/);
  await assert.rejects(client.routeMaster({ routeId: '100100252' }), /INVALID_QUERY/);
  await assert.rejects(client.sectionTimes({ stdrDe: '20260801', rowCnt: 1000 }), /INVALID_QUERY/);
  assert.deepEqual(await client.bisRouteInfo({ route_ty: '4', areaId: '523' }), []);
});

const live = () => JSON.parse(readFileSync(new URL('./fixtures/t-data-targeted-lookup.json', import.meta.url), 'utf8'));
test('actual targeted records identify 5515 and both stops without retaining whole pages', () => {
  const result = live();
  const route = result.lookups.find(x => x.service === 'routeMaster');
  assert.equal(route.reason, 'targets-found'); assert.equal(route.requestCount, 1);
  const [normalized] = parseTDataRouteMaster(route.matches.map(x => x.raw));
  assert.equal(normalized.routeId, '100100252'); assert.equal(normalized.name, '5515');
  assert.equal(normalized.routeType, '지선'); assert.equal(normalized.distanceValue, 10.8);
  const stops = result.lookups.find(x => x.service === 'stopMaster');
  assert.equal(stops.requestCount, 27); assert.equal(stops.pagination, 'offset');
  assert.equal(stops.requests[1].overlapWithPrevious, 999);
  assert.deepEqual(stops.matches.map(x => x.query.startRow), [22002, 25002]);
  const parsed = parseTDataStopMaster(stops.matches.map(x => x.raw));
  assert.deepEqual(parsed.map(x => [x.stopId, x.name, x.number]), [
    ['120000670', '서울대학교', '21376'], ['120000041', '신림중.삼성고.관악아트홀·도서관', '21142'],
  ]);
  assert.deepEqual(parsed.map(x => x.coordinates), [
    { x: 126.949631903, y: 37.4676609636, crs: 'unknown' },
    { x: 126.944412, y: 37.470352, crs: 'unknown' },
  ]);
  assert.ok(result.lookups.every(x => x.requests.every(r => !('raw' in r))));
  assert.equal(result.lookups.reduce((count, x) => count + x.matches.length, 0), 4);
});

test('actual master target IDs still match section-time and route-stop sequence 25→26', () => {
  const read = name => JSON.parse(readFileSync(new URL(`./fixtures/t-data-${name}.json`, import.meta.url), 'utf8')).raw;
  const section = parseTDataSectionTimes(read('section_time')).find(x => x.externalRouteId === '100100252');
  const master = parseTDataRouteStops(read('route_stop-seoul-page1'));
  const stopIds = live().lookups.find(x => x.service === 'stopMaster').matches.map(x => x.raw.sttnId);
  assert.equal(section.fromSequence, 25); assert.equal(section.toSequence, 26);
  assert.deepEqual([section.fromExternalStopId, section.toExternalStopId], stopIds);
  assert.deepEqual(master.filter(x => [25, 26].includes(x.sequence)).map(x => x.externalStopId), stopIds);
});

test('BIS official ID/name filters were ignored; name pagination found a candidate only', () => {
  const result = live();
  assert.deepEqual(result.bisFilters.map(x => x.status), ['ignored', 'ignored']);
  assert.equal(result.bisFilters[0].query.route_id, '100100252');
  assert.equal(result.bisFilters[1].query.route_nm, '5515');
  const bis = result.lookups.find(x => x.service === 'bisRouteInfo');
  assert.equal(bis.matchField, 'routeNm'); assert.equal(bis.requestCount, 1);
  assert.equal(bis.matches[0].raw.routeNm, '5515'); assert.equal(bis.matches[0].raw.routeId, '100100252');
  assert.equal('crosswalk' in bis, false);
  assert.equal(result.lookups.reduce((count, x) => count + x.requestCount, 0) + result.bisFilters.length, 31);
});
