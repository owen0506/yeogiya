import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTagoBusClient } from './tago-bus-client.mjs';
import { fetchBusVehicles, server } from './seoul-proxy.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/tago-bus-locations.json', import.meta.url), 'utf8'));
const config = {
  TAGO_BUS_API_KEY: 'test%2Bkey',
  TAGO_BUS_LOCATION_ENDPOINT: 'https://apis.data.go.kr/test/LOCATION',
};
const query = new URLSearchParams({ cityCode: '23', routeId: 'ICB161000002', nearSequence: '12' });
const ok = raw => ({ ok: true, json: async () => raw });

test('LOCATION-only client does not require unrelated TAGO endpoints', async () => {
  const client = createTagoBusClient(config, async () => ok(fixture.raw), { services: ['LOCATION'] });
  assert.deepEqual(Object.keys(client), ['locations']);
  assert.equal((await client.locations({ cityCode: '23', routeId: 'ICB161000002' })).response.body.totalCount, 3);
  assert.throws(() => createTagoBusClient(config, () => {}, { services: ['UNKNOWN'] }), /TAGO_BUS_INVALID_SERVICES/);
});

test('bus candidates contain only observed vehicles near the requested stop', async () => {
  let calls = 0;
  const result = await fetchBusVehicles(query, config, async url => {
    calls += 1;
    assert.equal(url.origin + url.pathname, 'https://apis.data.go.kr/test/LOCATION/getRouteAcctoBusLcList');
    assert.equal(url.searchParams.get('serviceKey'), 'test+key');
    assert.equal(url.searchParams.get('cityCode'), '23');
    assert.equal(url.searchParams.get('routeId'), 'ICB161000002');
    assert.equal(url.searchParams.get('pageNo'), '1');
    assert.equal(url.searchParams.get('numOfRows'), '100');
    return ok(fixture.raw);
  }, () => new Date('2026-10-02T00:00:00.000Z'));
  assert.equal(calls, 1);
  assert.deepEqual(result.sequenceRange, { from: 4, to: 20 });
  assert.equal(result.fetchedAt, '2026-10-02T00:00:00.000Z');
  assert.deepEqual(result.coverage, { totalCount: 3, pagesFetched: 1, loadedCount: 3, partial: false });
  assert.deepEqual(result.vehicles.map(vehicle => vehicle.stopSequence), [12]);
  assert.equal(result.vehicles[0].vehicleNumber, '인천70바4028');
  assert.equal(result.vehicles[0].routeId, 'ICB161000002');
  assert.equal(result.vehicles[0].cityCode, '23');
  assert.equal('tripId' in result.vehicles[0], false);
  assert.doesNotMatch(JSON.stringify(result), /test\+key|serviceKey/);
});

test('pagination is bounded and explicitly marks incomplete coverage', async () => {
  const base = fixture.raw.response.body.items.item[0];
  const fetchImpl = async url => {
    const pageNo = Number(url.searchParams.get('pageNo'));
    return ok({ response: {
      header: { resultCode: '00' },
      body: {
        pageNo, numOfRows: 100, totalCount: 400,
        items: { item: Array.from({ length: 100 }, (_, index) => ({
          ...base, nodeord: pageNo === 1 ? index + 1 : 100 * (pageNo - 1) + index + 1,
          vehicleno: `BUS-${pageNo}-${index}`,
        })) },
      },
    } });
  };
  const result = await fetchBusVehicles(query, config, fetchImpl);
  assert.equal(result.coverage.pagesFetched, 3);
  assert.equal(result.coverage.loadedCount, 300);
  assert.equal(result.coverage.totalCount, 400);
  assert.equal(result.coverage.partial, true);
  assert.deepEqual(result.vehicles.map(vehicle => vehicle.stopSequence), Array.from({ length: 17 }, (_, index) => index + 4));
});

test('dense nearby vehicle reports are capped and marked partial', async () => {
  const base = fixture.raw.response.body.items.item[0];
  const raw = { response: {
    header: { resultCode: '00' },
    body: {
      pageNo: 1, totalCount: 40,
      items: { item: Array.from({ length: 40 }, (_, index) => ({ ...base, nodeord: 12, vehicleno: `BUS-${index}` })) },
    },
  } };
  const result = await fetchBusVehicles(query, config, async () => ok(raw));
  assert.equal(result.vehicles.length, 30);
  assert.equal(result.coverage.partial, true);
});

test('invalid query and missing configuration fail before contacting TAGO', async () => {
  const never = () => assert.fail('must not fetch');
  for (const params of [
    new URLSearchParams({ cityCode: '0', routeId: 'ICB161000002', nearSequence: '12' }),
    new URLSearchParams({ cityCode: '23', routeId: 'not a route', nearSequence: '12' }),
    new URLSearchParams({ cityCode: '23', routeId: 'ICB161000002', nearSequence: '0' }),
    new URLSearchParams('cityCode=23&cityCode=24&routeId=ICB161000002&nearSequence=12'),
  ]) await assert.rejects(fetchBusVehicles(params, config, never), /BUS_VEHICLES_INVALID_QUERY/);
  await assert.rejects(fetchBusVehicles(query, {}, never), /TAGO_BUS_MISSING_TAGO_BUS_API_KEY/);
  await assert.rejects(fetchBusVehicles(query, { TAGO_BUS_API_KEY: 'secret' }, never), /TAGO_BUS_MISSING_TAGO_BUS_LOCATION_ENDPOINT/);
});

test('malformed location data and mismatched pages are rejected', async () => {
  const badLocation = structuredClone(fixture.raw);
  badLocation.response.body.items.item[0].nodeord = 0;
  await assert.rejects(fetchBusVehicles(query, config, async () => ok(badLocation)), /TAGO_BUS_INVALID_DATA/);
  const wrongPage = structuredClone(fixture.raw);
  wrongPage.response.body.pageNo = 2;
  await assert.rejects(fetchBusVehicles(query, config, async () => ok(wrongPage)), /TAGO_BUS_INVALID_DATA/);
});

test('HTTP endpoint validates the request and does not echo secrets', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/bus-vehicles?cityCode=23&routeId=bad%20route&nearSequence=12`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_QUERY' });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
