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
const { findTimetableJourneyPlan } = require('../src/features/transit/timetable-plan.ts');
const at = (time) => `2026-10-03T${time}:00+09:00`;
const stopTime = (stopId, sequence, time) => ({ stopId, sequence, arrivalAt: at(time), departureAt: at(time) });
const network = {
  trips: [
    { tripId: 'bus-run-1', routeId: 'bus-721', mode: 'BUS', serviceDate: '2026-10-03',
      stopTimes: [stopTime('a', 1, '10:02'), stopTime('b', 2, '10:05'), stopTime('a', 3, '10:07'), stopTime('c', 4, '10:10')] },
    { tripId: 'train-run-1', routeId: 'line-2', mode: 'SUBWAY', serviceDate: '2026-10-03',
      stopTimes: [stopTime('m', 1, '10:15'), stopTime('n', 2, '10:20')] },
  ],
  footpaths: [
    { fromStopId: 'c', toStopId: 'm', seconds: 120, kind: 'TRANSFER' },
    { fromStopId: 'n', toStopId: 'home', seconds: 180, kind: 'WALK' },
  ],
};
const catalog = {
  stops: ['a', 'b', 'c', 'm', 'n', 'home'].map(stopId => ({ stopId, name: `정차지 ${stopId}`, providerStopId: `provider-${stopId}` })),
  services: [
    { routeId: 'bus-721', mode: 'BUS', line: '721', providerRouteId: 'tago-route-987', providerId: 'tago', cityCode: '11', routeType: '간선' },
    { routeId: 'line-2', mode: 'SUBWAY', line: '2호선' },
  ],
  // This bus Trip starts at the provider route's twelfth stop, and visits a twice.
  tripStopSequences: [1, 2, 3, 4].map((sequence) => ({
    tripId: 'bus-run-1', serviceDate: '2026-10-03', sequence, providerSequence: sequence + 11,
  })),
};
const query = { fromStopId: 'a', toStopId: 'home', departureAt: at('10:00') };

test('a mixed timetable route becomes displayable legs with wait proportions and real service identifiers', () => {
  const plan = findTimetableJourneyPlan(network, query, catalog);
  assert.ok(plan);
  assert.deepEqual(plan.legs.map(leg => leg.kind), ['WAIT', 'RIDE', 'TRANSFER', 'WAIT', 'RIDE', 'WALK']);
  assert.equal(plan.totalSeconds, 23 * 60);
  assert.equal(plan.legs.reduce((sum, leg) => sum + leg.planned.durationSeconds, 0), plan.totalSeconds);
  const bus = plan.legs[1];
  assert.equal(bus.mode, 'BUS');
  assert.equal(bus.routeId, 'tago-route-987');
  assert.equal(bus.providerId, 'tago');
  assert.equal(bus.routeType, '간선');
  assert.deepEqual(bus.stops.map(stop => stop.id), ['a', 'b', 'a', 'c']);
  assert.deepEqual(bus.stops.map(stop => stop.sequence), [0, 1, 2, 3]);
  assert.deepEqual(bus.stops.map(stop => stop.serviceSequence), [12, 13, 14, 15]);
  assert.equal(bus.from.providerStopId, 'provider-a');
  assert.equal(bus.scheduledTrip.tripId, 'bus-run-1');
  assert.equal(bus.scheduledTrip.routeId, 'bus-721');
  assert.equal(plan.legs[4].routeId, null);
  assert.deepEqual(plan.legs[4].stops.map(stop => stop.serviceSequence), [null, null]);
  assert.equal(plan.source, 'TIMETABLE');
  assert.equal(Date.parse(plan.arrivalAt), Date.parse(at('10:23')));
});

test('missing provider IDs and sequence mappings remain unknown instead of reusing internal IDs', () => {
  const unlinked = { ...catalog, services: catalog.services.map(service => ({
    ...service, providerRouteId: undefined,
  })), tripStopSequences: undefined };
  const plan = findTimetableJourneyPlan(network, query, unlinked);
  assert.ok(plan);
  const bus = plan.legs[1];
  assert.equal(bus.routeId, null);
  assert.equal(bus.scheduledTrip.routeId, 'bus-721');
  assert.deepEqual(bus.stops.map(stop => stop.serviceSequence), [null, null, null, null]);
});

test('provider stop mapping rejects duplicates, unknown trip stops, and invalid or reversed sequence values', () => {
  const mapping = catalog.tripStopSequences[0];
  const findWith = tripStopSequences => findTimetableJourneyPlan(network, query, { ...catalog, tripStopSequences });
  assert.throws(() => findWith([...catalog.tripStopSequences, mapping]), /DUPLICATE_PROVIDER_SEQUENCE/);
  assert.throws(() => findWith([{ ...mapping, sequence: 99 }]), /INVALID_PROVIDER_SEQUENCE/);
  assert.throws(() => findWith([{ ...mapping, tripId: 'unknown' }]), /INVALID_PROVIDER_SEQUENCE/);
  assert.throws(() => findWith([{ ...mapping, providerSequence: 0 }]), /INVALID_PROVIDER_SEQUENCE/);
  assert.throws(() => findWith([{ ...mapping, providerSequence: 1.5 }]), /INVALID_PROVIDER_SEQUENCE/);
  assert.throws(() => findWith([
    { ...mapping, providerSequence: 13 },
    { ...catalog.tripStopSequences[1], providerSequence: 12 },
  ]), /INVALID_PROVIDER_SEQUENCE/);
  assert.throws(() => findWith([
    mapping,
    { ...catalog.tripStopSequences[1], providerSequence: mapping.providerSequence },
  ]), /INVALID_PROVIDER_SEQUENCE/);
});

test('missing names or service metadata fail instead of producing a misleading vehicle query', () => {
  assert.throws(() => findTimetableJourneyPlan(network, query, { ...catalog, stops: catalog.stops.slice(1) }), /MISSING_STOP/);
  assert.throws(() => findTimetableJourneyPlan(network, query, { ...catalog, services: [] }), /MISSING_SERVICE/);
  assert.equal(findTimetableJourneyPlan(network, { ...query, toStopId: 'unknown' }, catalog), null);
});
