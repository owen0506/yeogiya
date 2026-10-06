const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getBusCorridorStops, getBusVehicleCandidates, parseBusVehicleCandidates } = require('../src/services/bus-vehicles.ts');

const stop = (serviceSequence, providerStopId = `S${serviceSequence}`, plannedOffsetSeconds = (serviceSequence - 12) * 150) => ({
  id: providerStopId, name: `정류장 ${serviceSequence}`, platformId: null,
  providerStopId, serviceSequence, sequence: serviceSequence - 12, plannedOffsetSeconds,
});

const leg = {
  id: 'ride:bus:1', kind: 'RIDE', mode: 'BUS', providerId: 'tago', cityCode: '23',
  routeId: 'ICB161000002', routeType: null, line: '6777', direction: null,
  from: { id: 'start', name: '출발', platformId: null, providerStopId: 'A', serviceSequence: 12, sequence: 0, plannedOffsetSeconds: 0 },
  to: { id: 'end', name: '하차', platformId: null, providerStopId: 'B', serviceSequence: 20, sequence: 8, plannedOffsetSeconds: 1200 },
  approachStops: [stop(9, 'X'), stop(10), stop(11)],
  stops: Array.from({ length: 9 }, (_, index) => stop(index + 12,
    index === 0 ? 'A' : index === 8 ? 'B' : index === 4 ? 'Y' : undefined)),
  planned: { startOffsetSeconds: 0, endOffsetSeconds: 1200, durationSeconds: 1200,
    departureAt: null, arrivalAt: null, source: 'ESTIMATE' },
};

const response = {
  providerId: 'tago', cityCode: '23', routeId: 'ICB161000002',
  fetchedAt: '2026-10-02T00:00:00.000Z', coverage: { partial: false },
  vehicles: [
    { providerId: 'tago', cityCode: '23', routeId: 'ICB161000002', vehicleNumber: '버스-앞', stopId: 'X', stopSequence: 9 },
    { providerId: 'tago', cityCode: '23', routeId: 'ICB161000002', vehicleNumber: '버스-탑승', stopId: 'Y', stopSequence: 16 },
    { providerId: 'tago', cityCode: '23', routeId: 'ICB161000002', vehicleNumber: '버스-지남', stopId: 'Z', stopSequence: 22 },
  ],
};

const onboardLeg = {
  ...leg, boardingSequence: 12, from: leg.stops[4], stops: leg.stops.slice(4),
  approachStops: [...leg.approachStops, ...leg.stops],
};

test('real positions stay scoped and distinguish boardable from already-onboard vehicles', () => {
  const candidates = parseBusVehicleCandidates(response, leg);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].vehicleNumber, '버스-앞');
  assert.deepEqual([candidates[0].canBoardHere, candidates[0].canBeOnboard], [true, false]);
  assert.deepEqual([candidates[1].canBoardHere, candidates[1].canBeOnboard], [false, true]);
  assert.equal(candidates[0].run.tripId, null);
  assert.equal(candidates[0].run.vehicleId, '버스-앞');
  assert.equal(candidates[0].run.serviceDate, '2026-10-02');
  assert.equal(candidates[0].evidence[0].freshness, 'UNKNOWN');
  assert.equal(candidates[0].etaSeconds, 450);
  assert.equal(candidates[0].etaSource, 'POSITION_ESTIMATE');
  assert.equal(candidates[0].routeDirectionMatched, true);
  assert.equal(candidates[1].etaSeconds, null);
  assert.equal(candidates[1].etaSource, null);
});

test('mismatched route and malformed response cannot create selectable vehicles', () => {
  assert.throws(() => parseBusVehicleCandidates({ ...response, routeId: 'other' }, leg));
  assert.deepEqual(parseBusVehicleCandidates({ ...response, vehicles: [{ ...response.vehicles[0], routeId: 'other' }] }, leg), []);
  assert.deepEqual(parseBusVehicleCandidates(response, { ...leg, cityCode: null }), []);
});

test('stop occurrence and corridor scope reject opposite direction and repeated-stop mismatches', () => {
  const vehicle = response.vehicles[0];
  for (const mismatched of [
    { ...vehicle, stopId: 'Y' },
    { ...vehicle, stopSequence: 10 },
    { ...vehicle, stopId: 'outside', stopSequence: 1 },
    { ...vehicle, stopId: 'B', stopSequence: 20 },
    { ...vehicle, stopId: 'A', stopSequence: 50 },
  ]) assert.deepEqual(parseBusVehicleCandidates({ ...response, vehicles: [mismatched] }, leg), []);
  assert.deepEqual(parseBusVehicleCandidates(response, { ...leg, approachStops: [] }).map(item => item.vehicleNumber), ['버스-탑승']);
  assert.deepEqual(parseBusVehicleCandidates(response, { ...leg, stops: [...leg.stops].reverse() }), []);
  assert.deepEqual(parseBusVehicleCandidates(response, { ...leg, to: leg.from }), []);
});

test('a through-alighting approach corridor merges identical occurrences and rejects conflicting duplicates', () => {
  const through = { ...leg, approachStops: [...leg.approachStops, ...leg.stops] };
  assert.equal(getBusCorridorStops(through).length, 12);
  assert.equal(parseBusVehicleCandidates(response, through).length, 2);
  const conflict = { ...through, approachStops: through.approachStops.map(item =>
    item.serviceSequence === 16 ? { ...item, providerStopId: 'wrong-direction-stop' } : item) };
  assert.deepEqual(getBusCorridorStops(conflict), []);
  assert.deepEqual(parseBusVehicleCandidates(response, conflict), []);
  const repeated = { ...leg, approachStops: leg.approachStops.map(item =>
    item.serviceSequence === 9 ? { ...item, providerStopId: 'A' } : item) };
  assert.equal(parseBusVehicleCandidates({ ...response, vehicles: [{ ...response.vehicles[0], stopId: 'A' }] }, repeated).length, 1);
});

test('provider coordinates are retained without inventing a between-stop position', () => {
  const base = response.vehicles[0];
  const valid = parseBusVehicleCandidates({ ...response, vehicles: [{ ...base, latitude: 37.365, longitude: 126.946 }] }, leg)[0];
  assert.equal(valid.latitude, 37.365);
  assert.equal(valid.longitude, 126.946);
  assert.equal(valid.relativeStopIndex, -3);
  const invalid = parseBusVehicleCandidates({ ...response, vehicles: [{ ...base, latitude: 91, longitude: 126.946 }] }, leg)[0];
  assert.equal(invalid.latitude, null);
  assert.equal(invalid.longitude, null);
});

test('a route-level arrival cannot supply a particular vehicle ETA when segment timing is missing', () => {
  const withoutTiming = { ...leg, approachStops: leg.approachStops.map(item => ({ ...item, plannedOffsetSeconds: null })) };
  const candidates = parseBusVehicleCandidates({ ...response, arrivals: [{ routeId: leg.routeId, arrivalSeconds: 60 }] }, withoutTiming);
  assert.equal(candidates[0].etaSeconds, null);
  assert.equal(candidates[0].etaSource, null);
  assert.equal(candidates[0].matchStatus, 'UNVERIFIED');
  assert.equal(candidates[0].run.tripId, null);
});

test('a complete upstream response still discloses a narrower stop-sequence lookup range', () => {
  const scoped = parseBusVehicleCandidates({ ...response, sequenceRange: { from: 10, to: 19 } }, leg);
  assert.equal(scoped.every(candidate => candidate.coveragePartial), true);
  const complete = parseBusVehicleCandidates({ ...response, sequenceRange: { from: 1, to: 30 } }, leg);
  assert.equal(complete.every(candidate => !candidate.coveragePartial), true);
});

test('an onboard replan keeps the original boarding point for eligibility and ETA', () => {
  const afterOriginalBoard = { ...response.vehicles[1], vehicleNumber: '승차지점-지남', stopId: 'S14', stopSequence: 14 };
  const candidates = parseBusVehicleCandidates({ ...response, vehicles: [...response.vehicles, afterOriginalBoard] }, onboardLeg);
  const approaching = candidates.find(candidate => candidate.vehicleNumber === '버스-앞');
  assert.equal(approaching.etaSeconds, 450);
  assert.equal(approaching.relativeStopIndex, -7);
  const passed = candidates.find(candidate => candidate.vehicleNumber === '승차지점-지남');
  assert.equal(passed.canBoardHere, false);
  assert.equal(passed.canBeOnboard, true);
  assert.equal(passed.etaSeconds, null);
  assert.equal(passed.relativeStopIndex, -2);
  const current = candidates.find(candidate => candidate.vehicleNumber === '버스-탑승');
  assert.equal(current.canBoardHere, false);
  assert.equal(current.canBeOnboard, true);
  assert.equal(current.relativeStopIndex, 0);
  assert.deepEqual(parseBusVehicleCandidates(response, { ...onboardLeg, boardingSequence: 17 }), []);
  assert.deepEqual(parseBusVehicleCandidates(response, { ...onboardLeg, approachStops: [] }), []);
});

test('the vehicle request covers the chosen ride through its alighting sequence', async (t) => {
  const oldBase = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = 'https://proxy.example.test';
  let queried;
  t.mock.method(globalThis, 'fetch', async (url) => {
    queried = new URL(url);
    return { ok: true, json: async () => response };
  });
  try {
    await getBusVehicleCandidates(leg);
    assert.equal(queried.pathname, '/bus-vehicles');
    assert.equal(queried.searchParams.get('nearSequence'), '12');
    assert.equal(queried.searchParams.get('toSequence'), '20');
    assert.equal(queried.searchParams.get('routeId'), leg.routeId);
    await getBusVehicleCandidates(onboardLeg);
    assert.equal(queried.searchParams.get('nearSequence'), '12');
    assert.equal(queried.searchParams.get('toSequence'), '20');
  } finally {
    if (oldBase === undefined) delete process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
    else process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = oldBase;
  }
});
