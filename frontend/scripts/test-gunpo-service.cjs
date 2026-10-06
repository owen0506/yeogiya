const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { parseGunpoNetwork, parseGunpoArrivals, nearbyGunpoStopIds, estimateGunpoRideSeconds } = require('../src/services/gunpo-bus.ts');
const { busColor } = require('../src/features/transit/transit-colors.ts');
const network = JSON.parse(fs.readFileSync(`${__dirname}/../../backend/data/gunpo-bus-network.json`, 'utf8'));
const NOW = Date.parse('2026-10-06T08:10:00Z');

test('actual Gunpo pilot snapshot preserves both routes and repeated stop occurrences without invented times', () => {
  const parsed = parseGunpoNetwork(network);
  assert.deepEqual(parsed.routes.map(route => route.routeNumber), ['30', '31']);
  assert.deepEqual(parsed.routes.map(route => route.stops.length), [96, 75]);
  assert.equal(parsed.rideTimes, undefined);
  assert.ok(parsed.routes.every(route => route.stops.every(stop => stop.directionCode === undefined)));
  for (const route of parsed.routes) assert.equal(new Set(route.stops.map(s => s.stopSequence)).size, route.stops.length);
  assert.ok(new Set(parsed.routes[0].stops.map(s => s.stopId)).size < 96);
});

test('network parsing rejects foreign scope, duplicate routes and invalid service occurrences', () => {
  assert.throws(() => parseGunpoNetwork({ ...network, cityCode: '23' }));
  assert.throws(() => parseGunpoNetwork({ ...network, routes: [network.routes[0], network.routes[0]] }));
  const bad = structuredClone(network);
  bad.routes[0].stops[1].stopSequence = bad.routes[0].stops[0].stopSequence;
  assert.throws(() => parseGunpoNetwork(bad));
  bad.routes[0].stops[1].stopSequence = 2;
  bad.routes[0].stops[1].latitude = 91;
  assert.throws(() => parseGunpoNetwork(bad));
});

test('boarding discovery is bounded, excludes ambiguous occurrences, and finds actual Gunpo neighborhoods', () => {
  const near = nearbyGunpoStopIds(network, network.routes[0].stops[8]);
  assert.ok(near.length > 0 && near.length <= 6);
  assert.ok(near.includes(network.routes[0].stops[8].stopId));
  assert.deepEqual(nearbyGunpoStopIds(network, { latitude: 37.5665, longitude: 126.978 }), []);
  const repeat = network.routes[0].stops.find(s => network.routes[0].stops.filter(other => other.stopId === s.stopId).length > 1);
  const oneRoute = { ...network, routes: [network.routes[0]] };
  assert.ok(!nearbyGunpoStopIds(oneRoute, repeat).includes(repeat.stopId));
});

test('arrival parsing keeps route ETA separate from vehicle identity and rejects stale or mismatched data', () => {
  const snapshot = { providerId: 'tago', cityCode: '31160', stopId: 'GGB225000233', fetchedAt: new Date(NOW).toISOString(),
    arrivals: [{ routeId: network.routes[0].routeId, routeNumber: '30', arrivalSeconds: 240, remainingStops: 3 }] };
  assert.equal(parseGunpoArrivals(snapshot, snapshot.stopId, NOW).arrivals[0].arrivalSeconds, 240);
  assert.equal('vehicleNumber' in snapshot.arrivals[0], false);
  assert.throws(() => parseGunpoArrivals(snapshot, 'wrong', NOW));
  assert.throws(() => parseGunpoArrivals(snapshot, snapshot.stopId, NOW + 91_000));
  assert.throws(() => parseGunpoArrivals(snapshot, snapshot.stopId, NOW - 11_000));
  assert.throws(() => parseGunpoArrivals({ ...snapshot, arrivals: [{ ...snapshot.arrivals[0], arrivalSeconds: -1 }] }, snapshot.stopId, NOW));
});

test('pilot movement model is explicit and finite, and Gyeonggi general buses use green', () => {
  const seconds = estimateGunpoRideSeconds({ fromStop: network.routes[0].stops[0], toStop: network.routes[0].stops[1] });
  assert.ok(Number.isSafeInteger(seconds) && seconds >= 45);
  assert.equal(estimateGunpoRideSeconds({ fromStop: network.routes[0].stops[0], toStop: network.routes[0].stops[0] }), 45);
  assert.equal(busColor('일반버스'), busColor('마을버스'));
  assert.notEqual(busColor('일반버스'), busColor('광역급행버스'));
});
