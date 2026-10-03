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

const { findEarliestArrival } = require('../src/features/transit/timetable-engine.ts');
const at = (clock) => `2026-10-02T${clock}+09:00`;
const stop = (stopId, sequence, arrival, departure = arrival) => ({
  stopId, sequence, arrivalAt: at(arrival), departureAt: at(departure),
});
const trip = (tripId, mode, routeId, stopTimes) => ({
  tripId, mode, routeId, serviceDate: '2026-10-02', stopTimes,
});
const query = (fromStopId, toStopId, departure = '14:00:00', minBoardingSeconds = 0) => ({
  fromStopId, toStopId, departureAt: at(departure), minBoardingSeconds,
});

test('boarding wait is included and the same trip continues through a short dwell', () => {
  const network = { trips: [trip('T1', 'SUBWAY', '2', [
    stop('A', 1, '14:04:00', '14:05:00'),
    stop('B', 2, '14:07:00', '14:07:30'),
    stop('C', 3, '14:10:00'),
  ])], footpaths: [] };
  const journey = findEarliestArrival(network, query('A', 'C', '14:02:00', 120));
  assert.ok(journey);
  assert.equal(journey.totalSeconds, 480);
  assert.equal(journey.segments.length, 1);
  assert.deepEqual([journey.segments[0].boardSequence, journey.segments[0].alightSequence], [1, 3]);
  assert.equal(journey.segments[0].tripId, 'T1');
  assert.equal(findEarliestArrival(network, query('A', 'C', '14:04:00', 120)), null);
});

test('a later express wins when it reaches the destination earlier', () => {
  const network = { trips: [
    trip('local', 'SUBWAY', '2', [stop('A', 1, '14:00:00', '14:01:00'), stop('C', 2, '14:30:00')]),
    trip('express', 'SUBWAY', '2X', [stop('A', 1, '14:04:00', '14:05:00'), stop('C', 2, '14:15:00')]),
  ], footpaths: [] };
  const result = findEarliestArrival(network, query('A', 'C'));
  assert.equal(result.arrivalAt, new Date(at('14:15:00')).toISOString());
  assert.equal(result.segments[0].tripId, 'express');
});

test('bus, walking transfer, subway, and final walk share one search', () => {
  const network = { trips: [
    trip('bus-run', 'BUS', '721', [stop('BUS_A', 1, '14:02:00', '14:03:00'), stop('BUS_B', 2, '14:08:00')]),
    trip('train-run', 'SUBWAY', '2', [stop('RAIL_C', 1, '14:11:00', '14:12:00'), stop('RAIL_D', 2, '14:18:00')]),
  ], footpaths: [
    { kind: 'WALK', fromStopId: 'HOME', toStopId: 'BUS_A', seconds: 60 },
    { kind: 'TRANSFER', fromStopId: 'BUS_B', toStopId: 'RAIL_C', seconds: 120 },
    { kind: 'WALK', fromStopId: 'RAIL_D', toStopId: 'GOAL', seconds: 60 },
  ] };
  const result = findEarliestArrival(network, query('HOME', 'GOAL'));
  assert.ok(result);
  assert.equal(result.arrivalAt, new Date(at('14:19:00')).toISOString());
  assert.deepEqual(result.segments.map(segment => segment.kind), ['WALK', 'RIDE', 'TRANSFER', 'RIDE', 'WALK']);
  assert.deepEqual(result.segments.filter(segment => segment.kind === 'RIDE').map(segment => segment.mode), ['BUS', 'SUBWAY']);
});

test('missing services return no route and invalid schedules are rejected', () => {
  assert.equal(findEarliestArrival({ trips: [], footpaths: [] }, query('A', 'B')), null);
  assert.throws(() => findEarliestArrival({ trips: [trip('bad', 'BUS', '721', [
    stop('A', 1, '14:05:00'), stop('B', 2, '14:04:00'),
  ])], footpaths: [] }, query('A', 'B')), /TIMETABLE_INVALID_STOP_TIME/);
  assert.throws(() => findEarliestArrival({ trips: [], footpaths: [
    { kind: 'WALK', fromStopId: 'A', toStopId: 'B', seconds: -1 },
  ] }, query('A', 'B')), /TIMETABLE_INVALID_FOOTPATH/);
  assert.throws(() => findEarliestArrival({ trips: [], footpaths: [] }, {
    ...query('A', 'B'), departureAt: '14:00',
  }), /TIMETABLE_INVALID_TIME/);
  assert.throws(() => findEarliestArrival({ trips: [
    { ...trip('bad-day', 'BUS', '721', [stop('A', 1, '14:00:00'), stop('B', 2, '14:02:00')]), serviceDate: '2026-02-30' },
  ], footpaths: [] }, query('A', 'B')), /TIMETABLE_INVALID_TRIP/);
  assert.throws(() => findEarliestArrival({ trips: [], footpaths: [] }, {
    ...query('A', 'B'), departureAt: '2026-02-30T14:00:00+09:00',
  }), /TIMETABLE_INVALID_TIME/);
});

test('absolute times support service trips after midnight', () => {
  const next = (clock) => `2026-10-03T${clock}+09:00`;
  const network = { trips: [{
    tripId: 'late', mode: 'BUS', routeId: 'N721', serviceDate: '2026-10-02',
    stopTimes: [
      { stopId: 'A', sequence: 1, arrivalAt: at('23:59:00'), departureAt: next('00:05:00') },
      { stopId: 'B', sequence: 2, arrivalAt: next('00:15:00'), departureAt: next('00:15:00') },
    ],
  }], footpaths: [] };
  const result = findEarliestArrival(network, query('A', 'B', '23:58:00'));
  assert.equal(result.totalSeconds, 17 * 60);
  assert.equal(result.segments[0].serviceDate, '2026-10-02');
});
