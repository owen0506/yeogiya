import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verify5515RouteCrosswalk } from './t-data-crosswalk.mjs';
import { parseTDataRouteMaster, parseTDataBisRouteInfo } from './t-data-model.mjs';
import { createTDataClient } from './t-data-client.mjs';
import { loadTDataBusRideSnapshot } from './t-data-snapshot.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
function records() {
  const source = fixture('t-data-targeted-lookup');
  const rows = kind => source.lookups.find(x => x.service === kind).matches.map(x => x.raw);
  return { taims: parseTDataRouteMaster(rows('routeMaster')), bis: parseTDataBisRouteInfo(rows('bisRouteInfo')) };
}

test('actual 5515 route crosswalk uses name, type, distance and active flags, not ID equality', () => {
  const { taims, bis } = records();
  assert.equal(bis[0].startStopName, '금호타운아파트'); assert.equal(bis[0].endStopName, '청림동현대아파트');
  assert.equal(bis[0].typeCode, '4'); assert.equal(bis[0].distanceValue, 10.8);
  assert.equal(bis[0].useCode, '1'); assert.equal(bis[0].operationCode, '1');
  const matched = verify5515RouteCrosswalk(taims, bis);
  assert.equal(matched.status, 'matched');
  const saved = fixture('t-data-5515-crosswalk');
  assert.deepEqual(matched.crosswalk, saved.crosswalk);
  assert.equal(saved.crosswalk.evidence.idEqualityUsedAsEvidence, false);
  assert.equal(saved.crosswalk.evidence.terminiCompared, false);
  assert.equal(saved.crosswalk.scope, 'captured-5515-route-identity-only');
});

test('5515 exception rejects other routes, conflicting evidence and duplicate candidates', () => {
  for (const mutate of [
    x => { x.taims[0].routeId = 'other'; },
    x => { x.taims[0].name = 'other'; x.bis[0].name = 'other'; },
    x => { x.taims[0].distanceValue = 11; x.bis[0].distanceValue = 11; },
    x => { x.bis[0].distanceValue = 11; },
    x => { delete x.bis[0].distanceValue; },
    x => { x.bis[0].routeType = '간선'; },
    x => { x.bis[0].useCode = '0'; },
    x => { x.bis[0].operationCode = '0'; },
    x => { x.bis.push(structuredClone(x.bis[0])); },
  ]) {
    const input = records(); mutate(input);
    assert.equal(verify5515RouteCrosswalk(input.taims, input.bis).status, 'missing');
  }
  // Synthetic mutation proves ID equality is not used as the matching criterion.
  const input = records(); input.bis[0].routeId = 'different-test-id';
  assert.equal(verify5515RouteCrosswalk(input.taims, input.bis).status, 'matched');
});

test('both real history requests used the verified BIS route and returned zero records', () => {
  const verified = fixture('t-data-5515-crosswalk');
  for (const date of ['20260801', '20260701']) {
    const saved = fixture(`t-data-5515-history-${date}`);
    assert.equal(saved.crosswalkFixture, 't-data-5515-crosswalk.json');
    assert.equal(saved.query.routeId, verified.crosswalk.bisRouteId);
    assert.equal(saved.query.stdrDe, date); assert.equal(saved.query.startRow, 1); assert.equal(saved.query.rowCnt, 1000);
    assert.deepEqual(saved.raw, []);
  }
  assert.deepEqual(fixture('t-data-5515-section-20260701').raw, []);
  assert.equal(fixture('t-data-5515-section-20260701').returnedCount, 0);
  // No fake timestamps, stop mapping, time statistics or operating costs inferred.
  assert.deepEqual(loadTDataBusRideSnapshot().snapshot.records, []);
  const original = fixture('t-data-section_time').raw.find(x => x.routeId === '100100252');
  assert.equal(original.tripFcnt, null); assert.equal(original.tripTime, '87');
});

test('history client accepts large bounded pages and rejects mismatched route/date', async () => {
  const env = { T_DATA_API_KEY: 'test', T_DATA_BUS_SECTION_TIME_ENDPOINT: 'https://t-data.seoul.go.kr/section',
    T_DATA_ROUTE_STOP_ENDPOINT: 'https://t-data.seoul.go.kr/stops', T_DATA_BUS_STOP_HISTORY_ENDPOINT: 'https://t-data.seoul.go.kr/history' };
  const query = fixture('t-data-5515-history-20260801').query;
  const client = createTDataClient(env, async () => Response.json([]));
  assert.deepEqual(await client.stopHistory(query), []);
  await assert.rejects(client.stopHistory({ ...query, rowCnt: 1001 }), /INVALID_QUERY/);
  // Transport validation only; these are not claimed to be real history records.
  for (const row of [{ routeId: 'other', stdrDe: query.stdrDe }, { routeId: query.routeId, stdrDe: '20260701' }]) {
    await assert.rejects(createTDataClient(env, async () => Response.json([row])).stopHistory(query), /T_DATA_FILTER_MISMATCH/);
  }
});

test('latest verified-route recheck is still empty and does not create operating costs', () => {
  const saved = fixture('t-data-5515-history-recheck-20260801');
  const verified = fixture('t-data-5515-crosswalk');
  assert.equal(saved.query.routeId, verified.crosswalk.bisRouteId);
  assert.equal(saved.query.stdrDe, '20260801');
  assert.equal(saved.query.startRow, 1); assert.equal(saved.query.rowCnt, 1000);
  assert.deepEqual(saved.raw, []);
  assert.deepEqual(loadTDataBusRideSnapshot().snapshot.records, []);
});
