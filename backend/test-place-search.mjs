import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaceSearch, parsePlaceSearchQuery, placeSearchError } from './kakao-places.mjs';
import { server } from './seoul-proxy.mjs';

const config = { KAKAO_REST_API_KEY: 'test-private-key' };
const params = (query, extra = {}) => new URLSearchParams({ query, ...extra });
const ok = documents => ({ ok: true, json: async () => ({ documents }) });
const keywordPlace = (id = '1001', extra = {}) => ({
  id, place_name: '세종대학교', address_name: '서울 광진구 군자동 98',
  road_address_name: '서울 광진구 능동로 209', category_name: '교육,학문 > 학교 > 대학교',
  x: '127.073134', y: '37.550255', ...extra,
});
const addressPlace = (extra = {}) => ({
  address_name: '서울 광진구 군자동 98', address_type: 'REGION_ADDR', x: '127.073134', y: '37.550255',
  road_address: { address_name: '서울 광진구 능동로 209', building_name: '세종대학교' }, ...extra,
});
const keywordOnly = documents => async url => ok(url.pathname.endsWith('/keyword.json') ? documents : []);

test('place search uses fixed HTTPS URLs and returns only normalized public fields', async () => {
  const calls = [];
  const result = await fetchPlaceSearch(params('  세종대학교  ', { latitude: '37.35', longitude: '126.93' }), config, async (url, options) => {
    calls.push(url.pathname);
    assert.equal(url.origin, 'https://dapi.kakao.com');
    assert.equal(url.searchParams.get('query'), '세종대학교');
    assert.equal(url.searchParams.get('size'), '10');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.has('key'), false);
    assert.equal(options.headers.Authorization, 'KakaoAK test-private-key');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname.endsWith('/keyword.json')) {
      assert.equal(url.searchParams.get('x'), '126.93');
      assert.equal(url.searchParams.get('y'), '37.35');
      assert.equal(url.searchParams.has('radius'), false);
      return ok([keywordPlace('1001', { phone: '010-secret', place_url: 'https://secret.example', debug: config })]);
    }
    assert.equal(url.pathname, '/v2/local/search/address.json');
    assert.equal(url.searchParams.has('x'), false);
    return ok([]);
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { provider: 'kakao', places: [{
    provider: 'kakao', providerPlaceId: '1001', name: '세종대학교', address: '서울 광진구 능동로 209',
    latitude: 37.550255, longitude: 127.073134, kind: 'PLACE', category: '교육,학문 > 학교 > 대학교',
  }] });
  assert.doesNotMatch(JSON.stringify(result), /test-private-key|Authorization|phone|debug|secret/);
});

test('road and lot addresses resolve without keyword POIs and receive stable distinct IDs', async () => {
  const fetchImpl = async url => ok(url.pathname.endsWith('/address.json') ? [addressPlace()] : []);
  const road = await fetchPlaceSearch(params('서울 광진구 능동로 209'), config, fetchImpl);
  const lot = await fetchPlaceSearch(params('서울 광진구 군자동 98'), config, fetchImpl);
  assert.deepEqual(road, lot);
  assert.equal(road.places[0].kind, 'ADDRESS');
  assert.equal(road.places[0].name, '세종대학교');
  assert.match(road.places[0].providerPlaceId, /^address:[a-f0-9]{24}$/);
  const missingBuilding = await fetchPlaceSearch(params('서울 광진구 군자동 99'), config,
    async url => ok(url.pathname.endsWith('/address.json') ? [addressPlace({ road_address: null })] : []));
  assert.equal(missingBuilding.places[0].name, '서울 광진구 군자동 98');
  assert.notEqual(missingBuilding.places[0].providerPlaceId, road.places[0].providerPlaceId);
});

test('empty matches succeed and duplicate provider IDs are removed before a ten-result limit', async () => {
  assert.deepEqual(await fetchPlaceSearch(params('없는 장소'), config, async () => ok([])), { provider: 'kakao', places: [] });
  const results = await fetchPlaceSearch(params('대학교'), config, keywordOnly([
    keywordPlace('1'), keywordPlace('1'), ...Array.from({ length: 12 }, (_, index) => keywordPlace(String(index + 2))),
  ]));
  assert.equal(results.places.length, 10);
  assert.deepEqual(results.places.map(place => place.providerPlaceId), Array.from({ length: 10 }, (_, index) => String(index + 1)));
});

test('a valid address remains selectable when ten keyword building matches fill the result limit', async () => {
  const result = await fetchPlaceSearch(params('서울 광진구 능동로 209'), config, async url => {
    return ok(url.pathname.endsWith('/keyword.json')
      ? Array.from({ length: 10 }, (_, index) => keywordPlace(String(index + 1), { place_name: `세종대학교 건물 ${index + 1}` }))
      : [addressPlace()]);
  });
  assert.equal(result.places.length, 10);
  assert.deepEqual(result.places.slice(0, 9).map(place => place.providerPlaceId), Array.from({ length: 9 }, (_, index) => String(index + 1)));
  assert.equal(result.places[9].kind, 'ADDRESS');
  assert.equal(result.places[9].address, '서울 광진구 능동로 209');
});

test('query validation rejects ambiguous, empty, malformed, or out-of-range inputs before fetching', async () => {
  const never = () => assert.fail('must not contact Kakao');
  for (const input of [
    new URLSearchParams(), params('역'), params('  '), params('가'.repeat(101)), params('학교\n서울'),
    new URLSearchParams('query=학교&query=주소'), params('학교', { latitude: '37.5' }),
    params('학교', { longitude: '127' }), params('학교', { latitude: '', longitude: '127' }),
    params('학교', { latitude: '91', longitude: '127' }), params('학교', { latitude: '37', longitude: '181' }),
    params('학교', { latitude: 'NaN', longitude: '127' }), params('학교', { latitude: '1e2', longitude: '127' }),
    params('학교', { endpoint: 'https://untrusted.example' }),
    new URLSearchParams('query=학교&latitude=37&latitude=38&longitude=127'),
  ]) await assert.rejects(fetchPlaceSearch(input, config, never), /^Error: PLACES_INVALID_QUERY$/);
  assert.deepEqual(parsePlaceSearchQuery(params('학교', { latitude: '0', longitude: '-180' })), { query: '학교', latitude: 0, longitude: -180 });
  await assert.rejects(fetchPlaceSearch(params('대학교'), {}, never), /^Error: PLACES_NOT_CONFIGURED$/);
  await assert.rejects(fetchPlaceSearch(params('대학교'), { KAKAO_REST_API_KEY: 'bad\nkey' }, never), /^Error: PLACES_NOT_CONFIGURED$/);
});

test('malformed provider responses never become selectable places', async () => {
  for (const raw of [null, {}, { documents: {} }, { documents: [null] },
    { documents: [keywordPlace('1', { x: '', y: '37' })] },
    { documents: [keywordPlace('1', { x: '181' })] },
    { documents: [keywordPlace('1', { place_name: '' })] },
    { documents: [keywordPlace('bad id')] },
    { documents: [keywordPlace('1', { category_name: {} })] },
    { documents: Array.from({ length: 16 }, () => keywordPlace()) },
  ]) {
    await assert.rejects(fetchPlaceSearch(params('대학교'), config, async url => url.pathname.endsWith('/keyword.json')
      ? { ok: true, json: async () => raw } : ok([])), /^Error: PLACES_INVALID_DATA$/);
  }
  await assert.rejects(fetchPlaceSearch(params('서울 주소'), config, async url => url.pathname.endsWith('/address.json')
    ? ok([addressPlace({ address_name: '', road_address: null })]) : ok([])), /^Error: PLACES_INVALID_DATA$/);
});

test('HTTP failures, parse errors, and transport failures expose only stable error codes', async () => {
  await assert.rejects(fetchPlaceSearch(params('대학교'), config, async () => ({ ok: false, status: 401,
    json: async () => ({ message: 'test-private-key' }) })), /^Error: PLACES_UPSTREAM_ERROR$/);
  await assert.rejects(fetchPlaceSearch(params('대학교'), config, async () => { throw new Error('https://example.test/test-private-key'); }), /^Error: PLACES_UNAVAILABLE$/);
  await assert.rejects(fetchPlaceSearch(params('대학교'), config, async () => ({ ok: true,
    json: async () => { throw new Error('test-private-key'); } })), /^Error: PLACES_INVALID_DATA$/);
  assert.deepEqual(placeSearchError(new Error('test-private-key')), [502, 'PLACES_UNAVAILABLE']);
  assert.deepEqual(placeSearchError(new Error('PLACES_NOT_CONFIGURED')), [503, 'PLACES_NOT_CONFIGURED']);
  assert.deepEqual(placeSearchError(new Error('PLACES_INVALID_QUERY')), [400, 'INVALID_QUERY']);
});

test('successful candidates survive a failure in the other search operation', async () => {
  const result = await fetchPlaceSearch(params('대학교'), config, async url => {
    if (url.pathname.endsWith('/keyword.json')) return ok([keywordPlace()]);
    throw new Error('test-private-key');
  });
  assert.equal(result.places.length, 1);
  const addressFallback = await fetchPlaceSearch(params('서울 광진구 능동로 209'), config, async url => {
    if (url.pathname.endsWith('/address.json')) return ok([addressPlace()]);
    return { ok: false };
  });
  assert.equal(addressFallback.places[0].kind, 'ADDRESS');
});

test('caller cancellation remains a failure even when a fetch implementation ignores its signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchPlaceSearch(params('대학교'), config, keywordOnly([keywordPlace()]), { signal: controller.signal }), /^Error: PLACES_UNAVAILABLE$/);
  await assert.rejects(fetchPlaceSearch(params('대학교'), config, async (_, { signal }) => {
    assert.equal(signal.aborted, true);
    throw new DOMException('test-private-key', 'AbortError');
  }, { signal: controller.signal }), /^Error: PLACES_UNAVAILABLE$/);
});

test('the HTTP endpoint preserves validation and sanitized error responses', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}/places/search`;
    const invalid = await fetch(`${base}?query=역`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'INVALID_QUERY' });
    assert.equal(invalid.headers.get('cache-control'), 'no-store');
    const duplicate = await fetch(`${base}?query=학교&query=주소`);
    assert.equal(duplicate.status, 400);
    assert.deepEqual(await duplicate.json(), { error: 'INVALID_QUERY' });
    const method = await fetch(`${base}?query=대학교`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.deepEqual(await method.json(), { error: 'METHOD_NOT_ALLOWED' });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
