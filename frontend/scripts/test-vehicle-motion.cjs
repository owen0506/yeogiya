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
const { createJourneyPlan } = require('../src/features/transit/journey-plan.ts');
const { getStationByName } = require('../src/features/stations/stations.ts');
const { getSubwayCorridor, parseSubwayPositions, mergeSubwayVehicleCandidates, normalizeSubwayPositionStatus } = require('../src/services/subway-vehicle-candidates.ts');
const { getVehicleMotion } = require('../src/features/transit/vehicle-motion.ts');
const { canPlanSubwayVehicle, canBeOnboardSubwayVehicle } = require('../src/features/transit/subway-ride-state.ts');

const at = Date.parse('2026-10-03T08:10:00+09:00');
const leg = createJourneyPlan(findRoute('mock-2-gangnam', 'mock-2-samseong')).legs[0];
const corridor = getSubwayCorridor(leg);
function candidate(status = '2', direction = '1', stationName = '강남', stamp = at) {
  // Motion fixtures are independent of the route eligibility filter.
  const stop = corridor.find(item => item.name === stationName);
  return { id: 'train-1234', legId: leg.id, mode: 'SUBWAY', trainId: '1234',
    destination: null, direction, etaSeconds: null, message: null,
    currentStationName: stationName, relativeStopIndex: stop?.relativeStopIndex ?? null,
    positionStatus: status, positionPhase: normalizeSubwayPositionStatus(status),
    positionObservedAt: new Date(stamp).toISOString(), positionDirection: direction,
    positionDestination: null, positionIsExpress: false, positionAssociation: 'POSITION_ONLY',
    run: { provider: 'SEOUL_SUBWAY', serviceDate: '2026-10-03', tripId: null, realtimeRunId: '1234', vehicleId: null },
    observedAt: new Date(stamp).toISOString(), matchStatus: 'UNVERIFIED', selectable: true, evidence: [] };
}

test('normalizes only documented position statuses and preserves position observation independently of arrivals', () => {
  assert.deepEqual(['0', '1', '2', '3', '99', null].map(normalizeSubwayPositionStatus),
    ['ARRIVING', 'STOPPED', 'DEPARTING', 'RUNNING', 'UNKNOWN', 'UNKNOWN']);
  const positions = parseSubwayPositions({ realtimePositionList: [{ subwayId: '1002', trainNo: '1234', statnNm: '강남',
    recptnDt: '2026-10-03 08:09:45', trainSttus: '2', updnLine: '1', statnTnm: '외선순환', directAt: '0' }] }, '2호선', at);
  const arrival = { trainId: '1234', lineId: '1002', direction: '외선', destination: '외선순환', message: '전역 출발',
    seconds: 90, receivedAt: '2026-10-03 08:10:00' };
  const merged = mergeSubwayVehicleCandidates(leg, [arrival], positions, new Date(at).toISOString())[0];
  assert.equal(merged.observedAt, new Date(at).toISOString());
  assert.equal(merged.positionObservedAt, new Date(at - 15_000).toISOString());
  assert.equal(merged.positionPhase, 'DEPARTING');
  assert.equal(merged.positionDirection, '1');
  assert.equal(merged.positionDestination, '외선순환');
  assert.equal(merged.positionIsExpress, false);
});

test('entry is just before the reported station; only confirmed arrival is on its dot', () => {
  const entry = getVehicleMotion(candidate('0', '1', '역삼'), leg, corridor, at);
  assert.ok(entry.relativeStopIndex >= 0.88 && entry.relativeStopIndex < 1);
  assert.equal(entry.displayLabel, '다음 역 진입');
  const arrived = getVehicleMotion(candidate('1', '1', '역삼', at + 30_000), leg, corridor, at + 30_000, entry);
  assert.equal(arrived.relativeStopIndex, 1);
  assert.equal(arrived.estimated, false);
  assert.equal(arrived.moving, false);
});

test('departure moves between neighboring stops without mutating observations or restarting repeated snapshots', () => {
  const observed = candidate();
  const snapshot = JSON.stringify(observed);
  const first = getVehicleMotion(observed, leg, corridor, at);
  const later = getVehicleMotion(observed, leg, corridor, at + 30_000, first);
  const repeated = getVehicleMotion(candidate('2', '1', '강남', at + 31_000), leg, corridor, at + 31_000, later);
  assert.equal(first.travelSign, 1);
  assert.ok(first.relativeStopIndex > 0 && first.relativeStopIndex < 1);
  assert.ok(later.relativeStopIndex > first.relativeStopIndex && later.relativeStopIndex < 1);
  assert.ok(repeated.relativeStopIndex >= later.relativeStopIndex);
  assert.equal(repeated.motionStartedAtMs, at);
  assert.equal(later.estimated, true);
  assert.equal(JSON.stringify(observed), snapshot);
  const delayed = getVehicleMotion(observed, leg, corridor, at + 179_000, later);
  assert.ok(delayed.relativeStopIndex < 1); // An estimate never claims arrival or proceeds to a second segment.
});

test('opposite inner/outer trains move in their own direction instead of following the searched journey', () => {
  const inner = getVehicleMotion(candidate('2', '0'), leg, corridor, at + 10_000);
  const outer = getVehicleMotion(candidate('2', '1'), leg, corridor, at + 10_000);
  assert.equal(inner.travelSign, -1);
  assert.ok(inner.relativeStopIndex < 0 && inner.relativeStopIndex > -1);
  assert.equal(outer.travelSign, 1);
  assert.ok(outer.relativeStopIndex > 0 && outer.relativeStopIndex < 1);
});

test('previous-station departure stays in the preceding segment while unknown statuses remain still', () => {
  const running = getVehicleMotion(candidate('3', '1', '역삼'), leg, corridor, at + 10_000);
  assert.equal(running.phase, 'RUNNING');
  assert.ok(running.relativeStopIndex > 0 && running.relativeStopIndex < 1);
  const unknown = getVehicleMotion(candidate('99'), leg, corridor, at + 10_000);
  assert.equal(unknown.phase, 'UNKNOWN');
  assert.equal(unknown.relativeStopIndex, 0);
  assert.equal(unknown.estimated, false);
});

test('departure and previous-station departure on the same segment preserve progress in both directions', () => {
  for (const [direction, nextStation] of [['1', '역삼'], ['0', '교대']]) {
    const start = getVehicleMotion(candidate('2', direction), leg, corridor, at);
    const departing = getVehicleMotion(candidate('2', direction), leg, corridor, at + 30_000, start);
    const running = getVehicleMotion(candidate('3', direction, nextStation, at + 31_000), leg, corridor, at + 31_000, departing);
    assert.equal(running.motionStartedAtMs, at);
    assert.ok(Math.abs(running.relativeStopIndex) >= Math.abs(departing.relativeStopIndex));
    assert.ok(Math.abs(running.relativeStopIndex) < 1);
    const refreshed = getVehicleMotion(candidate('3', direction, nextStation, at + 60_000), leg, corridor, at + 60_000, running);
    assert.equal(refreshed.motionStartedAtMs, at);
    assert.ok(Math.abs(refreshed.relativeStopIndex) >= Math.abs(running.relativeStopIndex));
    const arrived = getVehicleMotion(candidate('1', direction, nextStation, at + 61_000), leg, corridor, at + 61_000, refreshed);
    assert.equal(arrived.estimated, false);
    const nextDeparture = getVehicleMotion(candidate('2', direction, nextStation, at + 62_000), leg, corridor, at + 62_000, arrived);
    assert.equal(nextDeparture.motionStartedAtMs, at + 62_000);
  }
});

test('stale observations freeze the last displayed estimate and new real arrivals correct it', () => {
  const observed = candidate();
  const last = getVehicleMotion(observed, leg, corridor, at + 30_000);
  const stale = getVehicleMotion(observed, leg, corridor, at + 181_000, last);
  const stillStale = getVehicleMotion(observed, leg, corridor, at + 240_000, stale);
  assert.equal(stale.phase, 'STALE');
  assert.equal(stale.relativeStopIndex, last.relativeStopIndex);
  assert.equal(stillStale.relativeStopIndex, stale.relativeStopIndex);
  assert.equal(stale.moving, false);
  const arrived = getVehicleMotion(candidate('1', '1', '역삼', at + 241_000), leg, corridor, at + 241_000, stillStale);
  assert.equal(arrived.relativeStopIndex, 1);
  assert.equal(arrived.phase, 'STOPPED');
  assert.equal(arrived.estimated, false);
});

test('express, ambiguous branches, and unknown directions do not invent movement', () => {
  const noDirection = getVehicleMotion(candidate('2', null), leg, corridor, at + 10_000);
  assert.equal(noDirection.relativeStopIndex, null);
  assert.equal(noDirection.travelSign, null);
  const express = getVehicleMotion({ ...candidate(), positionIsExpress: true }, leg, corridor, at + 10_000);
  assert.equal(express.estimated, false);
  const branchLeg = createJourneyPlan(findRoute(getStationByName('신도림').id, getStationByName('문래').id)).legs[0];
  const branchCandidate = { ...candidate(), id: 'branch', legId: branchLeg.id, currentStationName: '신도림' };
  const branch = getVehicleMotion(branchCandidate, branchLeg, getSubwayCorridor(branchLeg), at + 10_000);
  assert.equal(branch.travelSign, null);
  assert.equal(branch.estimated, false);
});

test('a partial position failure freezes and restores the same interval without restarting progress', () => {
  const initial = getVehicleMotion(candidate(), leg, corridor, at);
  const progressed = getVehicleMotion(candidate(), leg, corridor, at + 30_000, initial);
  const noPosition = { ...candidate(), positionObservedAt: null, relativeStopIndex: null,
    currentStationName: null, positionPhase: 'UNKNOWN', positionDirection: null };
  const failed = getVehicleMotion(noPosition, leg, corridor, at + 31_000, progressed);
  const repeated = getVehicleMotion(noPosition, leg, corridor, at + 40_000, failed);
  assert.equal(repeated.phase, 'STALE');
  assert.equal(repeated.relativeStopIndex, progressed.relativeStopIndex);
  assert.equal(repeated.observedStopIndex, progressed.observedStopIndex);
  assert.equal(repeated.motionStartedAtMs, at);
  const recovered = getVehicleMotion(candidate('3', '1', '역삼', at + 60_000), leg, corridor, at + 60_000, repeated);
  assert.equal(recovered.motionStartedAtMs, at);
  assert.ok(recovered.relativeStopIndex >= progressed.relativeStopIndex);
  assert.ok(recovered.relativeStopIndex < 1);
});

test('a confirmed arrival remains on its dot after stale information and a repeated entry status', () => {
  const stopped = getVehicleMotion(candidate('1', '1', '역삼'), leg, corridor, at);
  const stale = getVehicleMotion(candidate('1', '1', '역삼'), leg, corridor, at + 181_000, stopped);
  const recovered = getVehicleMotion(candidate('0', '1', '역삼', at + 182_000), leg, corridor, at + 182_000, stale);
  assert.equal(recovered.phase, 'STOPPED');
  assert.equal(recovered.relativeStopIndex, 1);
  assert.equal(recovered.estimated, false);
});

test('successive adjacent observations supply direction on a line with no verified static direction mapping', () => {
  const otherLeg = createJourneyPlan(findRoute(getStationByName('교대').id, getStationByName('양재').id)).legs[0];
  const otherCorridor = getSubwayCorridor(otherLeg);
  const firstCandidate = { ...candidate(), id: 'other', legId: otherLeg.id, positionDirection: '1', currentStationName: otherLeg.from.name };
  const first = getVehicleMotion(firstCandidate, otherLeg, otherCorridor, at);
  assert.equal(first.travelSign, null);
  const secondCandidate = { ...firstCandidate, relativeStopIndex: 1, currentStationName: otherLeg.stops[1].name,
    positionObservedAt: new Date(at + 60_000).toISOString() };
  const second = getVehicleMotion(secondCandidate, otherLeg, otherCorridor, at + 70_000, first);
  assert.equal(second.travelSign, 1);
  assert.ok(second.relativeStopIndex > 1 && second.relativeStopIndex < 2);
  const reversedCode = getVehicleMotion({ ...secondCandidate, positionDirection: '0' }, otherLeg, otherCorridor, at + 75_000, second);
  assert.equal(reversedCode.travelSign, null);
  assert.equal(reversedCode.estimated, false);
});

test('corridor boundaries keep vehicles inside visible rails instead of placing them beyond an unseen stop', () => {
  const edge = getVehicleMotion({ ...candidate('2', '1', '삼성'), routeDirectionMatched: true }, leg, corridor, at + 10_000);
  assert.equal(edge.relativeStopIndex, null);
  assert.equal(edge.displayLabel, '화면 밖 구간 운행');
  assert.equal(edge.estimated, false);
  assert.equal(edge.moving, false);
  const stopped = getVehicleMotion(candidate('1', '1', '삼성'), leg, corridor, at + 10_000);
  assert.equal(stopped.relativeStopIndex, 3);
});

test('first departure observation starts a local estimate, not a fake departure at the API update timestamp', () => {
  const result = getVehicleMotion(candidate('2', '1', '강남', at - 60_000), leg, corridor, at);
  assert.equal(result.motionStartedAtMs, at);
  assert.equal(result.relativeStopIndex, 0.12);
  const inTransit = getVehicleMotion(candidate('3', '1', '역삼'), leg, corridor, at);
  assert.equal(inTransit.relativeStopIndex, 0.45);
});

test('matched route direction supports a four-line segment without guessing from a line array', () => {
  const fourLeg = createJourneyPlan(findRoute(getStationByName('금정').id, getStationByName('산본').id)).legs.find(item => item.kind === 'RIDE');
  assert.equal(fourLeg.line, '4호선');
  const four = { ...candidate(), legId: fourLeg.id, currentStationName: '금정', routeDirectionMatched: true };
  const result = getVehicleMotion(four, fourLeg, getSubwayCorridor(fourLeg), at);
  assert.equal(result.travelSign, 1);
  assert.ok(result.relativeStopIndex > 0 && result.relativeStopIndex < 1);
});

test('next-stop ETA separates recently departed and nearly arriving trains and only subtracts time since fetch', () => {
  const duration = leg.stops[1].plannedOffsetSeconds - leg.stops[0].plannedOffsetSeconds;
  function withEta(seconds, fetched = at) {
    return { ...candidate(), routeDirectionMatched: true, segmentArrival: {
      relativeStopIndex: 1, seconds, phase: 'UNKNOWN', observedAt: new Date(at).toISOString(), fetchedAt: new Date(fetched).toISOString(),
    } };
  }
  const early = getVehicleMotion(withEta(duration * 0.9), leg, corridor, at);
  const late = getVehicleMotion(withEta(duration * 0.1), leg, corridor, at);
  assert.ok(early.relativeStopIndex < 0.25);
  assert.ok(late.relativeStopIndex >= 0.85 && late.relativeStopIndex < 1);
  assert.match(late.displayLabel, /도착 접근/);
  const fetchedLater = withEta(duration * 0.5, at + 30_000);
  const exact = getVehicleMotion(fetchedLater, leg, corridor, at + 30_000);
  assert.equal(exact.relativeStopIndex, 0.5);
  const later = getVehicleMotion(fetchedLater, leg, corridor, at + 40_000, exact);
  assert.ok(Math.abs(later.relativeStopIndex - (0.5 + 10 / duration)) < 0.00001);
  const zero = getVehicleMotion(withEta(0), leg, corridor, at);
  assert.equal(zero.relativeStopIndex, 0.94);
  assert.notEqual(zero.phase, 'STOPPED');
});

test('newer next-stop entry stays before its dot and only a confirmed arrival moves onto it', () => {
  const first = getVehicleMotion(candidate(), leg, corridor, at);
  const entryCandidate = { ...candidate(), segmentArrival: { relativeStopIndex: 1, seconds: 5, phase: 'ARRIVING',
    observedAt: new Date(at + 30_000).toISOString(), fetchedAt: new Date(at + 30_000).toISOString() } };
  const entry = getVehicleMotion(entryCandidate, leg, corridor, at + 30_000, first);
  assert.equal(entry.phase, 'ARRIVING');
  assert.ok(entry.relativeStopIndex >= 0.88 && entry.relativeStopIndex < 1);
  const arrivedCandidate = { ...entryCandidate, segmentArrival: { ...entryCandidate.segmentArrival, phase: 'STOPPED', seconds: 0,
    observedAt: new Date(at + 31_000).toISOString(), fetchedAt: new Date(at + 31_000).toISOString() } };
  const arrived = getVehicleMotion(arrivedCandidate, leg, corridor, at + 31_000, entry);
  assert.equal(arrived.relativeStopIndex, 1);
  assert.equal(arrived.estimated, false);
  const older = getVehicleMotion(candidate('3', '1', '역삼', at + 20_000), leg, corridor, at + 32_000, arrived);
  assert.equal(older.relativeStopIndex, 1);
  const repeatedEntry = getVehicleMotion(candidate('0', '1', '역삼', at + 33_000), leg, corridor, at + 33_000, arrived);
  assert.equal(repeatedEntry.relativeStopIndex, 1);
});

test('refreshes and ETA corrections never move a train backwards within the same directed interval', () => {
  const initial = getVehicleMotion(candidate('3', '1', '역삼'), leg, corridor, at);
  const before = getVehicleMotion(candidate('3', '1', '역삼'), leg, corridor, at + 30_000, initial);
  const refreshed = { ...candidate('3', '1', '역삼', at + 31_000), segmentArrival: {
    relativeStopIndex: 1, seconds: 600, phase: 'UNKNOWN', observedAt: new Date(at + 31_000).toISOString(), fetchedAt: new Date(at + 31_000).toISOString(),
  } };
  const after = getVehicleMotion(refreshed, leg, corridor, at + 31_000, before);
  assert.equal(after.motionStartedAtMs, at);
  assert.ok(after.relativeStopIndex >= before.relativeStopIndex);
  assert.ok(after.relativeStopIndex < 1);
});

test('boarding eligibility uses observed intervals: departure has left, entry at the alighting station is still onboard', () => {
  assert.equal(canPlanSubwayVehicle(candidate('2')), false);
  assert.equal(canPlanSubwayVehicle(candidate('1')), true);
  assert.equal(canPlanSubwayVehicle(candidate('0')), true);
  assert.equal(canBeOnboardSubwayVehicle(candidate('3', '1', '역삼'), 2), true);
  assert.equal(canBeOnboardSubwayVehicle(candidate('0', '1', '역삼'), 2), true);
  assert.equal(canBeOnboardSubwayVehicle(candidate('1', '1', '역삼'), 2), false);
  assert.equal(canBeOnboardSubwayVehicle(candidate('3', '1', '강남'), 2), false);
  assert.equal(canPlanSubwayVehicle({ ...candidate(), relativeStopIndex: null, boardingPhase: 'DEPARTING' }), false);
  const newerDeparture = { ...candidate('1', '1', '교대'), boardingPhase: 'DEPARTING',
    observedAt: new Date(at + 30_000).toISOString() };
  assert.equal(canPlanSubwayVehicle(newerDeparture), false);
  const newerPosition = { ...candidate('1', '1', '강남', at + 60_000), boardingPhase: 'DEPARTING',
    observedAt: new Date(at + 30_000).toISOString() };
  assert.equal(canPlanSubwayVehicle(newerPosition), true);
});
