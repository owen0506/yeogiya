const fs = require('node:fs');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(compiled.outputText, filename);
};
const { findPlaceJourney, endpointName, endpointCoordinate, isCoordinateEndpoint, canSearchEndpoints } =
  require('../src/features/transit/place-routing.ts');
const { getStation } = require('../src/features/stations/stations.ts');
const base = Date.parse('2026-10-06T10:00:00+09:00');
const at = seconds => new Date(base + seconds * 1000).toISOString();
const station = name => getStation(`station-${name}`);
const field = name => ({ query: name, station: station(name) });
const point = (name, latitude, longitude = 127) => ({ stationId: station(name).id, latitude, longitude });
const place = (name, latitude, longitude = 127) => ({ query: name, station: null,
  place: { provider: 'kakao', providerPlaceId: name, name, address: '서울특별시 테스트 주소',
    kind: 'PLACE', latitude, longitude } });
const gps = (latitude, extra = {}) => ({ query: '내 위치', station: null,
  currentLocation: { latitude, longitude: 127, accuracyMeters: 10, observedAt: at(0), distanceMeters: 0 }, ...extra });
const platform = value => ({ id: `${value.id}-platform`, name: value.name, line: '4호선', stationId: value.id });
function subway(from, to, readyAt, seconds = 600, waitSeconds = 60, transfers = 0) {
  const departureAt = new Date(Date.parse(readyAt) + waitSeconds * 1000).toISOString();
  const steps = [{ station: platform(from), secondsFromStart: 0, transfer: false }];
  if (transfers) steps.push({ station: { ...platform(from), id: `${from.id}-other`, line: '7호선' },
    secondsFromStart: 120, transfer: true });
  steps.push({ station: { ...platform(to), line: transfers ? '7호선' : '4호선' }, secondsFromStart: seconds, transfer: false });
  return { steps, seconds, stops: 1, transfers, official: { departureAt,
    arrivalAt: new Date(Date.parse(departureAt) + seconds * 1000).toISOString(),
    searchedAt: at(0), fetchedAt: at(0), distanceMeters: 1000, firstTrain: '1001', destination: to.name } };
}
const emptyNetwork = { providerId: 'tago', cityCode: '31160', fetchedAt: at(0), routes: [] };
const query = overrides => ({ originField: field('금정'), destinationField: place('세종대학교', 37.6001),
  network: emptyNetwork, arrivals: [], departureAt: at(0), stationCoordinates: [
    point('금정', 37), point('산본', 37.0005), point('어린이대공원', 37.6), point('군자', 37.604), point('건대입구', 37.609),
  ], getSubwayRoute: async (from, to, _preference, _signal, readyAt) => subway(from, to, readyAt), ...overrides });

test('destination stations are compared by transit plus final walking time, not geographic proximity', async () => {
  const calls = [];
  const plan = await findPlaceJourney(query({ getSubwayRoute: async (from, to, preference, signal, readyAt) => {
    calls.push([from.id, to.id]);
    return subway(from, to, readyAt, to.id === station('군자').id ? 300 : 1800);
  } }));
  assert.ok(plan);
  const ride = plan.legs.find(leg => leg.kind === 'RIDE');
  assert.equal(ride.to.id, station('군자').id);
  assert.equal(plan.legs.at(-1).to.name, '세종대학교');
  assert.equal(plan.legs.at(-1).to.id, 'place:["kakao","세종대학교"]');
  assert.equal(plan.legs.at(-1).kind, 'WALK');
  assert.ok(plan.notes.some(note => note.includes('실제 보행 경로·출입구')));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([from]) => from === station('금정').id), 'station origin must remain at the selected station');
  assert.equal(plan.legs.reduce((sum, leg) => sum + leg.planned.durationSeconds, 0), plan.totalSeconds);
});

test('a place origin retains its identity and can use a farther, faster boarding station', async () => {
  const plan = await findPlaceJourney(query({ originField: { ...place('산본 래미안 하이어스', 37), station: station('금정') },
    destinationField: field('사당'), stationCoordinates: [point('금정', 37.001), point('산본', 37.002), point('사당', 37.1)],
    getSubwayRoute: async (from, to, _pref, _signal, readyAt) => subway(from, to, readyAt,
      from.id === station('산본').id ? 120 : 1200),
  }));
  assert.ok(plan);
  const access = plan.legs[0];
  assert.equal(access.kind, 'WALK');
  assert.equal(access.from.id, 'place:["kakao","산본 래미안 하이어스"]');
  assert.equal(access.from.name, '산본 래미안 하이어스');
  assert.equal(access.to.id, station('산본').id);
  assert.ok(access.planned.durationSeconds > 120, 'place access must include platform entry time');
  assert.equal(plan.legs.at(-1).to.id, station('사당').id);
});

test('an explicitly chosen destination connection station remains selected', async () => {
  const destinationField = gps(37.001);
  destinationField.station = station('금정');
  destinationField.currentLocation.connectionStationSelected = true;
  const calls = [];
  const plan = await findPlaceJourney(query({ originField: field('사당'), destinationField,
    stationCoordinates: [point('금정', 37), point('산본', 37.0015), point('사당', 37.1)],
    getSubwayRoute: async (from, to, _p, _s, readyAt) => { calls.push(to.id); return subway(from, to, readyAt); },
  }));
  assert.deepEqual(calls, [station('금정').id]);
  assert.equal(plan.legs.at(-1).to.id, 'current-location:destination');
  assert.equal(plan.legs.at(-1).to.name, '내 위치');
});

test('GPS-to-place timing includes initial access, waiting and final walk in one global schedule', async () => {
  const plan = await findPlaceJourney(query({ originField: gps(37), destinationField: place('공공기관', 37.1),
    stationCoordinates: [point('금정', 37.001), point('사당', 37.101)],
    getSubwayRoute: async (from, to, _p, _s, readyAt) => subway(from, to, readyAt, 600, 240),
  }));
  assert.deepEqual(plan.legs.map(leg => leg.kind), ['WALK', 'WAIT', 'RIDE', 'WALK']);
  assert.equal(plan.legs[0].from.id, 'current-location:origin');
  assert.equal(plan.legs[1].planned.durationSeconds, 240);
  let elapsed = 0;
  for (const leg of plan.legs) {
    assert.equal(leg.planned.startOffsetSeconds, elapsed);
    assert.equal(leg.planned.departureAt, at(elapsed));
    elapsed += leg.planned.durationSeconds;
    assert.equal(leg.planned.endOffsetSeconds, elapsed);
    assert.equal(leg.planned.arrivalAt, at(elapsed));
    assert.equal(leg.to.plannedOffsetSeconds, elapsed);
  }
  assert.equal(plan.totalSeconds, elapsed);
  assert.equal(plan.arrivalAt, at(elapsed));
});

test('fewest transfers compares the complete alternatives using the requested preference', async () => {
  const plan = await findPlaceJourney(query({ preference: 'fewest-transfers',
    getSubwayRoute: async (from, to, _p, _s, readyAt) => subway(from, to, readyAt,
      to.id === station('어린이대공원').id ? 300 : 900, 60, to.id === station('어린이대공원').id ? 1 : 0),
  }));
  assert.ok(plan);
  assert.equal(plan.transferCount, 0);
  assert.notEqual(plan.legs.find(leg => leg.kind === 'RIDE').to.id, station('어린이대공원').id);
});

test('nearby place-to-place routing offers a direct estimated walk even outside rail coverage', async () => {
  const plan = await findPlaceJourney(query({ originField: place('집', 36), destinationField: place('학교', 36.005),
    stationCoordinates: [], getSubwayRoute: async () => { throw new Error('must not call rail without station candidates'); },
  }));
  assert.ok(plan);
  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0].kind, 'WALK');
  assert.equal(plan.legs[0].from.name, '집');
  assert.equal(plan.legs[0].to.name, '학교');
  assert.ok(plan.totalSeconds > 0);
  assert.equal(plan.includesAccessAndWaiting, true);
});

test('uncovered destination returns null; a provider error is retained when no alternative exists', async () => {
  const uncovered = await findPlaceJourney(query({ destinationField: place('미지원 지역', 36), stationCoordinates: [point('금정', 37)] }));
  assert.equal(uncovered, null);
  await assert.rejects(findPlaceJourney(query({ getSubwayRoute: async () => { throw new Error('RAIL_UNAVAILABLE'); } })), /RAIL_UNAVAILABLE/);
});

test('a failed destination candidate does not discard another valid route', async () => {
  const plan = await findPlaceJourney(query({ getSubwayRoute: async (from, to, _p, _s, readyAt) => {
    if (to.id === station('어린이대공원').id) throw new Error('RAIL_UNAVAILABLE');
    return subway(from, to, readyAt);
  } }));
  assert.ok(plan);
  assert.notEqual(plan.legs.find(leg => leg.kind === 'RIDE').to.id, station('어린이대공원').id);
});

test('cancellation prevents stale candidate results from returning', async () => {
  const controller = new AbortController();
  let release;
  let started;
  const begin = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const result = findPlaceJourney(query({ signal: controller.signal, getSubwayRoute: async (from, to, _p, _s, readyAt) => {
    started();
    await gate;
    return subway(from, to, readyAt);
  } }));
  await begin;
  controller.abort();
  release();
  await assert.rejects(result, /PLACE_ROUTING_ABORTED/);
});

test('coordinate endpoint helpers distinguish places, GPS and unresolved text', () => {
  const school = { ...place('세종대학교', 37.1), station: station('사당') };
  assert.equal(endpointName(school), '세종대학교');
  assert.equal(isCoordinateEndpoint(school), true);
  assert.deepEqual(endpointCoordinate(school, [point('사당', 38)]), { latitude: 37.1, longitude: 127 });
  assert.equal(endpointName(gps(37)), '내 위치');
  assert.equal(canSearchEndpoints(field('금정'), school), true);
  assert.equal(canSearchEndpoints(field('금정'), field('금정')), false);
  assert.equal(canSearchEndpoints(school, school), false);
  assert.equal(canSearchEndpoints({ query: '검색 중', station: null }, school), false);
  assert.equal(canSearchEndpoints({ ...school, place: { ...school.place, latitude: NaN } }, field('금정')), false);
});

test('selecting a particular bus replans to the original place, preserving the chosen ride', async () => {
  const makeStop = (stopId, stopSequence, latitude) => ({ stopId, name: stopId, stopSequence, latitude, longitude: 127 });
  const q = query({ originField: place('아파트', 37), destinationField: place('도서관', 37.1),
    stationCoordinates: [point('금정', 37.01), point('사당', 37.1005)],
    network: { ...emptyNetwork, routes: [{ routeId: 'pilot-30', routeNumber: '30', stops: [
      makeStop('BOARD', 1, 37), makeStop('ALIGHT', 2, 37.01),
    ] }], rideTimes: [{ routeId: 'pilot-30', fromSequence: 1, toSequence: 2, seconds: 120, source: 'observed' }] },
    arrivals: [{ providerId: 'tago', cityCode: '31160', stopId: 'BOARD', fetchedAt: at(0),
      arrivals: [{ routeId: 'pilot-30', routeNumber: '30', arrivalSeconds: 60, remainingStops: 1 }] }],
  });
  const initial = await findPlaceJourney(q);
  const bus = initial.legs.find(leg => leg.kind === 'RIDE' && leg.mode === 'BUS');
  assert.ok(bus);
  const replanned = await findPlaceJourney({ ...q, fixedBus: { legId: bus.id, routeId: bus.routeId,
    boardSequence: 1, alightSequence: 2, status: 'PLANNED', departureAt: at(90) } });
  assert.ok(replanned);
  const selected = replanned.legs.find(leg => leg.kind === 'RIDE' && leg.mode === 'BUS');
  assert.equal(selected.id, bus.id);
  assert.equal(selected.planned.departureAt, at(90));
  assert.equal(replanned.legs.at(-1).to.id, 'place:["kakao","도서관"]');
  assert.equal(replanned.legs.at(-1).to.name, '도서관');
  assert.equal(replanned.legs.reduce((sum, leg) => sum + leg.planned.durationSeconds, 0), replanned.totalSeconds);
});

test('an exact station origin may take a bus to another rail connection without changing its direct boarding station', async () => {
  const calls = [];
  const makeStop = (stopId, stopSequence, latitude) => ({ stopId, name: stopId, stopSequence, latitude, longitude: 127 });
  const plan = await findPlaceJourney(query({ originField: field('산본'), destinationField: place('도서관', 37.1),
    stationCoordinates: [point('산본', 37), point('금정', 37.01), point('사당', 37.1005)],
    network: { ...emptyNetwork, routes: [{ routeId: 'pilot-30', routeNumber: '30', stops: [
      makeStop('BOARD', 1, 37), makeStop('ALIGHT', 2, 37.01),
    ] }], rideTimes: [{ routeId: 'pilot-30', fromSequence: 1, toSequence: 2, seconds: 120, source: 'observed' }] },
    arrivals: [{ providerId: 'tago', cityCode: '31160', stopId: 'BOARD', fetchedAt: at(0),
      arrivals: [{ routeId: 'pilot-30', routeNumber: '30', arrivalSeconds: 60, remainingStops: 1 }] }],
    getSubwayRoute: async (from, to, _pref, _signal, readyAt) => {
      calls.push({ from: from.id, readyAt });
      return subway(from, to, readyAt, from.id === station('금정').id ? 120 : 1200);
    },
  }));
  assert.ok(plan);
  assert.equal(plan.legs.find(leg => leg.kind === 'RIDE' && leg.mode === 'BUS').routeId, 'pilot-30');
  assert.equal(plan.legs.find(leg => leg.kind === 'RIDE' && leg.mode === 'SUBWAY').from.id, station('금정').id);
  assert.equal(plan.legs.at(-1).to.name, '도서관');
  assert.equal(calls.find(call => call.from === station('산본').id).readyAt, at(0));
  assert.equal(calls.find(call => call.from === station('금정').id).readyAt, at(300));
  assert.equal(calls.length, 2, 'a walk from the selected origin station to another direct station must not be proposed');
});
