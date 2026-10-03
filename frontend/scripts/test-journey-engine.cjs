const fs = require('node:fs');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(compiled.outputText, filename);
};

const { findRoute } = require('../src/features/journey/route-service.ts');
const { createJourneyPlan, selectRideVehicle } = require('../src/features/transit/journey-plan.ts');
const {
  getSubwayCorridor, parseSubwayPositions, mergeSubwayVehicleCandidates,
} = require('../src/services/subway-vehicle-candidates.ts');

test('route adapter preserves ordered ride stops, transfer timing, and planned offsets', () => {
  const route = findRoute('mock-1-seoul', 'mock-2-gangnam');
  assert.ok(route);
  const plan = createJourneyPlan(route);
  assert.equal(plan.totalSeconds, route.seconds);
  assert.equal(plan.legs.filter(leg => leg.kind === 'TRANSFER').length, route.transfers);
  assert.equal(plan.legs.reduce((sum, leg) => sum + leg.planned.durationSeconds, 0), route.seconds);
  const rides = plan.legs.filter(leg => leg.kind === 'RIDE');
  assert.ok(rides.length > 1);
  for (const leg of rides) {
    assert.equal(leg.mode, 'SUBWAY');
    assert.equal(leg.routeId, null);
    assert.equal(leg.providerId, null);
    assert.equal(leg.from, leg.stops[0]);
    assert.equal(leg.to, leg.stops.at(-1));
    assert.deepEqual(leg.stops.map(stop => stop.sequence), leg.stops.map((_, i) => i));
    assert.ok(leg.stops.every(stop => stop.serviceSequence === null));
    assert.ok(leg.stops.every((stop, i) => i === 0 || stop.plannedOffsetSeconds >= leg.stops[i - 1].plannedOffsetSeconds));
  }
});

test('corridor extends only one known direction and does not invent a branch predecessor', () => {
  const route = findRoute('mock-2-gangnam', 'mock-2-samseong');
  const leg = createJourneyPlan(route).legs[0];
  const corridor = getSubwayCorridor(leg, 2);
  assert.deepEqual(corridor.map(stop => [stop.name, stop.relativeStopIndex]), [
    ['서초', -2], ['교대', -1], ['강남', 0], ['역삼', 1], ['선릉', 2],
  ]);
  const ambiguous = { ...leg, stops: [leg.stops[0], { ...leg.stops[1], name: '시청' }] };
  assert.deepEqual(getSubwayCorridor(ambiguous, 3).map(stop => stop.relativeStopIndex), [0, 1]);
});

test('equally long legs on one line retain distinct identities for vehicle and alarm association', () => {
  const first = createJourneyPlan(findRoute('mock-2-gangnam', 'mock-2-yeoksam')).legs[0];
  const second = createJourneyPlan(findRoute('mock-2-yeoksam', 'mock-2-seolleung')).legs[0];
  assert.notEqual(first.id, second.id);
  const candidate = { id: 'train', legId: first.id, mode: 'SUBWAY', selectable: true,
    run: { provider: 'SEOUL_SUBWAY', serviceDate: null, tripId: null, realtimeRunId: '1234', vehicleId: null },
    observedAt: null, matchStatus: 'UNVERIFIED', evidence: [] };
  assert.throws(() => selectRideVehicle(second, candidate, 'PLANNED'));
});

test('fresh observed train positions become candidates without a fabricated Trip match', () => {
  const now = Date.parse('2026-10-02T08:10:00+09:00');
  const route = findRoute('mock-2-gangnam', 'mock-2-samseong');
  const leg = createJourneyPlan(route).legs[0];
  const positions = parseSubwayPositions({
    errorMessage: { code: 'INFO-000' },
    realtimePositionList: [
      { subwayId: '1002', trainNo: '2336', statnNm: '역삼', recptnDt: '2026-10-02 08:09:00', trainSttus: '1' },
      { subwayId: '1002', trainNo: 'old', statnNm: '역삼', recptnDt: '2026-10-02 08:00:00' },
      { subwayId: '1001', trainNo: 'other', statnNm: '역삼', recptnDt: '2026-10-02 08:09:00' },
    ],
  }, '2호선', now);
  assert.equal(positions.length, 1);
  assert.deepEqual(parseSubwayPositions({ RESULT: { CODE: 'INFO-200' } }, '2호선', now), []);
  const arrivals = [{ trainId: '2336', lineId: '1002', direction: '내선', destination: '성수행', message: '전역 출발', seconds: 90, receivedAt: '2026-10-02 08:09:00' }];
  const candidates = mergeSubwayVehicleCandidates(leg, arrivals, positions, new Date(now).toISOString());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].trainId, '2336');
  assert.equal(candidates[0].currentStationName, '역삼');
  assert.equal(candidates[0].relativeStopIndex, 1);
  assert.equal(candidates[0].run.tripId, null);
  assert.equal(candidates[0].run.vehicleId, null);
  assert.equal(candidates[0].matchStatus, 'UNVERIFIED');
  assert.equal(candidates[0].positionAssociation, 'TRAIN_NUMBER_ONLY');
  assert.equal(mergeSubwayVehicleCandidates(leg, [], positions, new Date(now).toISOString())[0].id, candidates[0].id);
  const choice = selectRideVehicle(leg, candidates[0], 'ONBOARD', new Date(now).toISOString());
  assert.equal(choice.status, 'ONBOARD');
  assert.equal(choice.run.tripId, null);
  assert.throws(() => selectRideVehicle({ ...leg, id: 'other-leg' }, candidates[0], 'PLANNED'));
});
