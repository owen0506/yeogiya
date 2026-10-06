const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { parsePlaceSearchResponse, searchPlaces } = require('../src/services/places.ts');
const place = { provider: 'kakao', providerPlaceId: '12345', name: '세종대학교', address: '서울 광진구 능동로 209',
  latitude: 37.5508, longitude: 127.0747, kind: 'PLACE', category: '학교' };
const payload = { provider: 'kakao', places: [place] };

function mockRequest(t, fetch) {
  const originalFetch = global.fetch;
  const originalBase = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  global.fetch = fetch;
  process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = 'http://192.168.0.31:8083/';
  t.after(() => {
    global.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
    else process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = originalBase;
  });
}

test('place response preserves only endpoint display fields and accepts address results', () => {
  assert.deepEqual(parsePlaceSearchResponse({ ...payload, places: [{ ...place, debug: 'private' }] }), [place]);
  const address = { ...place, providerPlaceId: 'address:127:37', kind: 'ADDRESS', category: undefined };
  const parsed = parsePlaceSearchResponse({ provider: 'kakao', places: [address] });
  assert.equal(parsed[0].kind, 'ADDRESS');
  assert.equal('category' in parsed[0], false);
  assert.deepEqual(parsePlaceSearchResponse({ provider: 'kakao', places: [] }), []);
  const extendedAddress = { ...place, kind: 'ADDRESS', name: '가'.repeat(500), address: '나'.repeat(500), category: '다'.repeat(300) };
  assert.deepEqual(parsePlaceSearchResponse({ provider: 'kakao', places: [extendedAddress] }), [extendedAddress]);
});

test('place response rejects corrupt coordinates, unsupported identities and excessive results', () => {
  for (const patch of [ { latitude: NaN }, { longitude: 181 }, { latitude: '37' }, { name: '' },
    { address: '' }, { provider: 'google' }, { kind: 'STATION' }, { providerPlaceId: '' } ]) {
    assert.throws(() => parsePlaceSearchResponse({ ...payload, places: [{ ...place, ...patch }] }));
  }
  assert.throws(() => parsePlaceSearchResponse({ ...payload, places: [place, { ...place, providerPlaceId: ' 12345 ' }] }));
  assert.throws(() => parsePlaceSearchResponse({ ...payload, places: Array.from({ length: 11 }, (_, i) => ({ ...place, providerPlaceId: String(i) })) }));
});

test('place query uses the existing backend address and encoded, trimmed search text', async t => {
  mockRequest(t, async (url, options) => {
    const request = new URL(url);
    assert.equal(request.origin, 'http://192.168.0.31:8083');
    assert.equal(request.pathname, '/places/search');
    assert.equal(request.searchParams.get('query'), '세종대학교 & 광진');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers, undefined);
    return { ok: true, status: 200, json: async () => payload };
  });
  assert.deepEqual(await searchPlaces('  세종대학교 & 광진  '), [place]);
});

test('short queries and already cancelled requests never contact the backend', async t => {
  mockRequest(t, async () => { assert.fail('must not request'); });
  await assert.rejects(searchPlaces(' 세 '), /2~100/);
  await assert.rejects(searchPlaces('a'.repeat(101)), /2~100/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchPlaces('세종대학교', controller.signal), { name: 'AbortError' });
});

test('old backend and upstream errors have actionable messages without exposing response data', async t => {
  let status = 404;
  mockRequest(t, async () => ({ ok: false, status, json: async () => { assert.fail('error bodies are not displayed'); } }));
  await assert.rejects(searchPlaces('세종대학교'), /다시 실행/);
  status = 503;
  await assert.rejects(searchPlaces('세종대학교'), /설정/);
  status = 429;
  await assert.rejects(searchPlaces('세종대학교'), /잠시 후/);
  status = 502;
  await assert.rejects(searchPlaces('세종대학교'), /서버가 응답/);
});

test('network failures and invalid JSON are sanitized', async t => {
  let invalidJson = false;
  mockRequest(t, async () => {
    if (!invalidJson) throw new Error('secret-key-leak https://private.invalid');
    return { ok: true, status: 200, json: async () => { throw new Error('private JSON'); } };
  });
  await assert.rejects(searchPlaces('세종대학교'), error => error.message.includes('연결할 수 없어요') && !error.message.includes('secret'));
  invalidJson = true;
  await assert.rejects(searchPlaces('세종대학교'), error => error.message.includes('검색 결과') && !error.message.includes('private'));
});

test('cancel during a response prevents obsolete place results even when transport ignores abort', async t => {
  let release;
  mockRequest(t, async () => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => payload }); }));
  const controller = new AbortController();
  const request = searchPlaces('세종대학교', controller.signal);
  controller.abort();
  release();
  await assert.rejects(request, { name: 'AbortError' });
});
