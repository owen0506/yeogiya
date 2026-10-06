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
const { findGunpoJourney } = require('../src/features/transit/gunpo-routing.ts');
const { getStation } = require('../src/features/stations/stations.ts');
const destination = getStation('station-사당');
const geumjeong = getStation('station-금정');
const base = Date.parse('2026-10-06T10:00:00+09:00');
const at = seconds => new Date(base + seconds * 1000).toISOString();
const gps = { latitude: 37, longitude: 127, name: '내 위치' };
const stationCoordinates = [
  { stationId: 'station-금정', latitude: 37.01, longitude: 127 },
  { stationId: 'station-산본', latitude: 37.02, longitude: 127 },
];
const stop = (stopId, stopSequence, latitude, directionCode) => ({
  stopId, name: stopId, stopSequence, latitude, longitude: 127,
  ...(directionCode === undefined ? {} : { directionCode }),
});
const route = (routeId, routeNumber, stops) => ({ routeId, routeNumber, routeType: '마을버스', stops });
const network = (routes, rideTimes = []) => ({
  providerId: 'tago', cityCode: '31160', fetchedAt: at(0), routes, rideTimes,
});
const arrival = (stopId, routeId, routeNumber, arrivalSeconds, fetchedAt = at(0)) => ({
  providerId: 'tago', cityCode: '31160', stopId, fetchedAt,
  arrivals: [{ routeId, routeNumber, arrivalSeconds, remainingStops: 1 }],
});
const platform = (station, line = '4호선') => ({
  id: `${station.id}-${line}`, name: station.name, line, stationId: station.id,
});
function subwayRoute(from, to, readyAt, waitSeconds = 300, rideSeconds = 600, official = true) {
  const departureAt = new Date(Date.parse(readyAt) + waitSeconds * 1000).toISOString();
  const arrivalAt = new Date(Date.parse(departureAt) + rideSeconds * 1000).toISOString();
  return {
    steps: [
      { station: platform(from), secondsFromStart: 0, transfer: false },
      { station: platform(to), secondsFromStart: rideSeconds, transfer: false },
    ],
    seconds: rideSeconds, stops: 1, transfers: 0,
    ...(official ? { official: { departureAt, arrivalAt, searchedAt: at(0), fetchedAt: at(0),
      distanceMeters: 1000, firstTrain: '1001', destination: to.name } } : {}),
  };
}
const standardRoute = route('gunpo-1', '30', [
  stop('PRIOR', 10, 36.999), stop('BOARD', 11, 37.0009), stop('ALIGHT', 12, 37.0101),
]);
const standardCosts = [
  { routeId: 'gunpo-1', fromSequence: 10, toSequence: 11, seconds: 45, source: 'observed' },
  { routeId: 'gunpo-1', fromSequence: 11, toSequence: 12, seconds: 240, source: 'observed' },
];
const query = (overrides = {}) => ({
  origin: gps, destination, departureAt: at(0), network: network([standardRoute], standardCosts),
  arrivals: [arrival('BOARD', 'gunpo-1', '30', 60), arrival('BOARD', 'gunpo-1', '30', 180)],
  stationCoordinates,
  getSubwayRoute: async (from, to, _preference, _signal, departureAt) => subwayRoute(from, to, departureAt),
  ...overrides,
});

test('missed arrival is skipped; route-level ETA becomes WAIT, not a fabricated Trip', async () => {
  const calls = [];
  const plan = await findGunpoJourney(query({ getSubwayRoute: async (from, to, preference, signal, readyAt) => {
    calls.push({ from: from.id, to: to.id, preference, readyAt });
    return subwayRoute(from, to, readyAt);
  } }));
  assert.ok(plan);
  assert.deepEqual(plan.legs.map(leg => leg.kind), ['WALK', 'WAIT', 'RIDE', 'WALK', 'TRANSFER', 'WAIT', 'RIDE']);
  const bus = plan.legs.find(leg => leg.kind === 'RIDE' && leg.mode === 'BUS');
  assert.ok(bus);
  assert.equal(bus.planned.departureAt, at(180));
  assert.equal(bus.planned.source, 'ESTIMATE');
  assert.equal(bus.routeId, 'gunpo-1');
  assert.equal(bus.providerId, 'tago');
  assert.equal(bus.cityCode, '31160');
  assert.equal(bus.scheduledTrip, undefined);
  assert.deepEqual(bus.stops.map(s => s.serviceSequence), [11, 12]);
  assert.deepEqual(bus.approachStops.map(s => s.serviceSequence), [10, 11, 12]);
  assert.ok(bus.approachStops[0].plannedOffsetSeconds < bus.from.plannedOffsetSeconds);
  assert.equal(plan.transferCount, 1);
  assert.equal(plan.includesAccessAndWaiting, true);
  assert.ok(plan.notes.some(note => note.includes('정류장 실시간 도착정보')));
  assert.ok(calls.length <= 5);
  assert.ok(calls.some(call => call.from === geumjeong.id &&
    Date.parse(call.readyAt) === Date.parse(bus.planned.arrivalAt) +
      plan.legs[3].planned.durationSeconds * 1000 + 120000));
  assert.equal(plan.legs.reduce((sum, leg) => sum + leg.planned.durationSeconds, 0), plan.totalSeconds);
});

test('later faster bus can overtake a slower earlier bus and dominated station connections are pruned', async () => {
  const slow = route('slow', '30', [stop('A', 1, 37), stop('X', 2, 37.0101)]);
  const fast = route('fast', '31', [stop('B', 1, 37), stop('Y', 2, 37.0101)]);
  const calls = [];
  const plan = await findGunpoJourney(query({
    network: network([slow, fast], [
      { routeId: 'slow', fromSequence: 1, toSequence: 2, seconds: 600, source: 'model' },
      { routeId: 'fast', fromSequence: 1, toSequence: 2, seconds: 60, source: 'model' },
    ]),
    arrivals: [arrival('A', 'slow', '30', 120), arrival('B', 'fast', '31', 240)],
    getSubwayRoute: async (from, to, preference, signal, readyAt) => {
      calls.push(readyAt);
      return subwayRoute(from, to, readyAt);
    },
  }));
  assert.ok(plan);
  assert.equal(plan.legs.find(leg => leg.kind === 'RIDE' && leg.mode === 'BUS').routeId, 'fast');
  assert.ok(calls.length <= 5);
});

test('missing bus costs or ETA fall back to direct walking without dropping GPS access', async () => {
  const nearGeumjeong = { latitude: 37.009, longitude: 127, stationId: geumjeong.id };
  const plan = await findGunpoJourney(query({ origin: nearGeumjeong,
    network: network([standardRoute]), arrivals: [] }));
  assert.ok(plan);
  assert.equal(plan.legs.some(leg => leg.kind === 'RIDE' && leg.mode === 'BUS'), false);
  assert.equal(plan.legs[0].kind, 'WALK');
  assert.ok(plan.legs[0].planned.durationSeconds > 0);
  assert.equal(plan.transferCount, 0);
  assert.equal(plan.notes.some(note => note.includes('버스 대기')), false);
});

test('an explicit station origin has zero GPS access distance', async () => {
  const plan = await findGunpoJourney(query({ origin: { stationId: geumjeong.id },
    network: network([]), arrivals: [] }));
  assert.ok(plan);
  assert.equal(plan.legs[0].kind, 'WAIT');
});

test('direct access considers a nearby supported station outside the bus interchange anchors', async () => {
  const gunpo = getStation('station-군포');
  const calls = [];
  const plan = await findGunpoJourney(query({ network: network([]), arrivals: [],
    stationCoordinates: [
      { stationId: gunpo.id, latitude: 37.0001, longitude: 127 },
      { stationId: geumjeong.id, latitude: 37.05, longitude: 127 },
    ],
    getSubwayRoute: async (from, to, pref, signal, readyAt) => {
      calls.push(from.id);
      return subwayRoute(from, to, readyAt);
    },
  }));
  assert.ok(plan);
  assert.deepEqual(calls, [gunpo.id]);
  assert.ok(plan.legs[0].planned.durationSeconds >= 120);
  assert.equal(plan.legs[0].kind, 'WALK');
});

test('explicit connection station overrides nearest hint and excludes other bus anchors', async () => {
  const gunpo = getStation('station-군포');
  const calls = [];
  const plan = await findGunpoJourney(query({
    origin: { ...gps, stationId: geumjeong.id, connectionStationId: gunpo.id },
    stationCoordinates: [
      { stationId: geumjeong.id, latitude: 37.01, longitude: 127 },
      { stationId: gunpo.id, latitude: 37.02, longitude: 127 },
    ],
    getSubwayRoute: async (from, to, pref, signal, readyAt) => {
      calls.push(from.id);
      return subwayRoute(from, to, readyAt);
    },
  }));
  assert.ok(plan);
  assert.deepEqual(calls, [gunpo.id]);
  assert.equal(plan.legs.some(leg => leg.kind === 'RIDE' && leg.mode === 'BUS'), false);
  assert.equal(plan.legs[0].kind, 'WALK');
  assert.ok(plan.legs[0].planned.durationSeconds > 120);
});

test('no bus cost and no station within direct walking reach returns no route', async () => {
  const plan = await findGunpoJourney(query({ network: network([]), arrivals: [],
    stationCoordinates: [{ stationId: geumjeong.id, latitude: 37.05, longitude: 127 }],
  }));
  assert.equal(plan, null);
});

test('direction boundaries and repeated boarding stop IDs are not joined to anonymous ETA', async () => {
  const boundary = route('turn', '30', [stop('BOARD', 1, 37, '0'), stop('MID', 2, 37.005, '0'),
    stop('ALIGHT', 3, 37.0101, '1')]);
  const repeated = route('loop', '31', [stop('BOARD', 1, 37), stop('MID', 2, 37.005),
    stop('BOARD', 3, 37), stop('ALIGHT', 4, 37.0101)]);
  const model = ({ routeId, fromStop, toStop }) => 60;
  const boundaryPlan = await findGunpoJourney(query({ network: network([boundary]),
    arrivals: [arrival('BOARD', 'turn', '30', 180)], rideSeconds: model }));
  const repeatedPlan = await findGunpoJourney(query({ network: network([repeated]),
    arrivals: [arrival('BOARD', 'loop', '31', 180)], rideSeconds: model }));
  assert.ok(boundaryPlan);
  assert.ok(repeatedPlan);
  assert.equal(boundaryPlan.legs.some(leg => leg.kind === 'RIDE' && leg.mode === 'BUS'), false);
  assert.equal(repeatedPlan.legs.some(leg => leg.kind === 'RIDE' && leg.mode === 'BUS'), false);
});

test('fixed bus disambiguates a repeated stop; onboard recomputation has no boarding walk or wait', async () => {
  const repeated = route('loop', '31', [stop('BOARD', 1, 37), stop('MID', 2, 37.005),
    stop('BOARD', 3, 37), stop('CURRENT', 4, 37.006), stop('ALIGHT', 5, 37.0101)]);
  const common = { network: network([repeated]), arrivals: [], rideSeconds: () => 60 };
  const planned = await findGunpoJourney(query({ ...common, fixedBus: {
    status: 'PLANNED', routeId: 'loop', boardSequence: 3, alightSequence: 5,
    departureAt: at(180), vehicleNumber: '경기00가0000',
  } }));
  assert.ok(planned);
  const plannedBus = planned.legs.find(leg => leg.kind === 'RIDE' && leg.mode === 'BUS');
  assert.deepEqual(plannedBus.stops.map(s => s.serviceSequence), [3, 4, 5]);
  assert.equal(plannedBus.boardingSequence, 3);
  assert.ok(planned.notes.some(note => note.includes('실차 위치')));
  assert.equal(planned.notes.some(note => note.includes('버스 대기는 정류장')), false);
  const onboard = await findGunpoJourney(query({ ...common, fixedBus: {
    status: 'ONBOARD', routeId: 'loop', boardSequence: plannedBus.boardingSequence, alightSequence: 5,
    currentSequence: 4, observedAt: at(-5), legId: plannedBus.id, vehicleNumber: '경기00가0000',
  } }));
  assert.ok(onboard);
  assert.equal(onboard.legs[0].kind, 'RIDE');
  assert.equal(onboard.legs[0].id, plannedBus.id);
  assert.equal(onboard.legs[0].boardingSequence, 3);
  assert.deepEqual(onboard.legs[0].stops.map(s => s.serviceSequence), [4, 5]);
  assert.equal(onboard.legs.some(leg => leg.kind === 'WAIT' && leg.to.id.includes('bus-stop')), false);
  assert.ok(onboard.notes.some(note => note.includes('최근 위치')));
  assert.equal(onboard.notes.some(note => note.includes('버스 대기')), false);
});

test('same-station destination skips the subway call, and a premature subway departure is rejected', async () => {
  const directAtStation = await findGunpoJourney(query({
    origin: { latitude: 37.01, longitude: 127 }, destination: geumjeong,
    network: network([]), arrivals: [], getSubwayRoute: async () => { throw new Error('SHOULD_NOT_CALL'); },
  }));
  assert.ok(directAtStation);
  assert.equal(directAtStation.totalSeconds, 0);
  await assert.rejects(findGunpoJourney(query({ getSubwayRoute: async (from, to, pref, signal, readyAt) => {
    const route = subwayRoute(from, to, readyAt);
    return { ...route, official: { ...route.official, departureAt: at(60), arrivalAt: at(660) } };
  } })), /GUNPO_SUBWAY_DEPARTS_BEFORE_TRANSFER/);
});

test('average subway fallback states that subway waiting is excluded', async () => {
  const plan = await findGunpoJourney(query({ getSubwayRoute: async (from, to, pref, signal, readyAt) =>
    subwayRoute(from, to, readyAt, 0, 600, false) }));
  assert.ok(plan);
  assert.equal(plan.includesAccessAndWaiting, false);
  assert.ok(plan.notes.some(note => note.includes('지하철 시간표')));
});

test('captured Gunpo route topology can form a one-way bus to rail connection', async () => {
  const captured = JSON.parse(fs.readFileSync(require.resolve('../../backend/data/gunpo-bus-network.json'), 'utf8'));
  const route30 = captured.routes.find(item => item.routeNumber === '30');
  const first = route30.stops.slice(0, 10).find(stop =>
    route30.stops.filter(item => item.stopId === stop.stopId).length === 1);
  assert.ok(first);
  const plan = await findGunpoJourney(query({
    origin: { latitude: first.latitude, longitude: first.longitude, name: first.name },
    network: captured,
    arrivals: [arrival(first.stopId, route30.routeId, route30.routeNumber, 180)],
    stationCoordinates: require('../src/features/stations/station-locations.json').points
      .filter(item => item.stationId === 'station-금정' || item.stationId === 'station-산본'),
    rideSeconds: () => 60,
  }));
  assert.ok(plan);
  const bus = plan.legs.find(item => item.kind === 'RIDE' && item.mode === 'BUS');
  assert.ok(bus);
  assert.equal(bus.routeId, route30.routeId);
  assert.ok(bus.to.serviceSequence > bus.from.serviceSequence);
});
