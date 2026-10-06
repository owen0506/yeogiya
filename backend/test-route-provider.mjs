import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOfficialRoute, parseRouteDepartureAt } from './route-provider.mjs';
import { server } from './seoul-proxy.mjs';

const env = { SUBWAY_API_KEY: 'unit-private-key' };
const response = () => Response.json({ header: { resultCode: '00' }, body: { paths: [{}], schInclYn: 'Y' } });

test('official subway search starts when the preceding bus arrives, including Korean midnight', async () => {
  const now = new Date('2026-10-06T14:50:00Z');
  let called;
  const result = await fetchOfficialRoute({ from: '금정', to: '어린이대공원', departureAt: '2026-10-06T15:05:00.000Z' }, env,
    async url => { called = url; return response(); }, now);
  assert.equal(called.searchParams.get('searchDt'), '2026-10-07 00:05:00');
  assert.equal(result.searchedAt, '2026-10-06T15:05:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /unit-private-key|serviceKey/);
});

test('an omitted departure preserves current-time behavior and a Korean ISO instant is equivalent', async () => {
  const now = new Date('2026-10-06T00:00:00Z');
  const seen = [];
  const fetcher = async url => { seen.push(url.searchParams.get('searchDt')); return response(); };
  const current = await fetchOfficialRoute({ from: '금정', to: '이수' }, env, fetcher, now);
  const future = await fetchOfficialRoute({ from: '금정', to: '이수', departureAt: '2026-10-06T09:30:00+09:00' }, env, fetcher, now);
  assert.deepEqual(seen, ['2026-10-06 09:00:00', '2026-10-06 09:30:00']);
  assert.equal(current.searchedAt, now.toISOString());
  assert.equal(future.searchedAt, '2026-10-06T00:30:00.000Z');
});

test('ambiguous dates, invalid calendar rollover, and malformed times never reach the provider', async () => {
  for (const value of ['', null, '2026-10-06', '2026-10-06 09:00:00', '2026-02-30T00:00:00Z',
    '2026-10-06T24:00:00Z', '2026-10-06T09:60:00Z', '2026-10-06T09:00:00', '2026-10-06T09:00:00+25:00']) {
    assert.throws(() => parseRouteDepartureAt(value), /ROUTE_API_INVALID_DEPARTURE_AT/);
    await assert.rejects(fetchOfficialRoute({ from: '금정', to: '이수', departureAt: value }, env,
      () => assert.fail('must not call the provider')), /ROUTE_API_INVALID_DEPARTURE_AT/);
  }
});

test('HTTP route rejects duplicated or invalid departure times without forwarding requests', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const base = `http://127.0.0.1:${address.port}/route?from=금정&to=이수`;
    for (const query of ['&departureAt=', '&departureAt=2026-02-30T00%3A00%3A00Z',
      '&departureAt=2026-10-06T00%3A00%3A00Z&departureAt=2026-10-06T01%3A00%3A00Z', '&from=금정']) {
      const result = await fetch(base + query);
      assert.equal(result.status, 400);
      assert.doesNotMatch(JSON.stringify(await result.json()), /unit-private-key|serviceKey/);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
