const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBusVehicleCandidates } = require('../src/services/bus-vehicles.ts');

const leg = {
  id: 'ride:bus:1', kind: 'RIDE', mode: 'BUS', providerId: 'tago', cityCode: '23',
  routeId: 'ICB161000002', routeType: null, line: '6777', direction: null,
  from: { id: 'start', name: '출발', platformId: null, providerStopId: 'A', serviceSequence: 12, sequence: 0, plannedOffsetSeconds: 0 },
  to: { id: 'end', name: '하차', platformId: null, providerStopId: 'B', serviceSequence: 20, sequence: 8, plannedOffsetSeconds: 1200 },
  stops: [], planned: { startOffsetSeconds: 0, endOffsetSeconds: 1200, durationSeconds: 1200,
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
});

test('mismatched route and malformed response cannot create selectable vehicles', () => {
  assert.throws(() => parseBusVehicleCandidates({ ...response, routeId: 'other' }, leg));
  assert.deepEqual(parseBusVehicleCandidates({ ...response, vehicles: [{ ...response.vehicles[0], routeId: 'other' }] }, leg), []);
  assert.deepEqual(parseBusVehicleCandidates(response, { ...leg, cityCode: null }), []);
});
