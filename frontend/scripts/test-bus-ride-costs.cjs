const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createBusRideCostProvider } = require('../src/features/transit/bus-ride-costs.ts');

// Synthetic normalized costs exercise the contract; never shipped as real data.
const identity = { providerId: 'test', cityCode: 'test-city', routeId: 'test-route', direction: '0', fromStopId: 'a', fromSequence: 1, toStopId: 'b', toSequence: 2 };
const daily = { ...identity, seconds: 90, source: 'test', statistic: 'test-mean', timeBasis: '2026-08-01', timeZone: 'Asia/Seoul' };
const snapshot = records => ({ version: 1, records });

test('bus costs preserve identity, direction, sequence and return missing without fallback', () => {
  const provider = createBusRideCostProvider(snapshot([daily]));
  assert.equal(provider.rideTime(identity).cost.seconds, 90);
  for (const patch of [{ direction: '1' }, { routeId: 'other' }, { cityCode: 'other' }, { fromSequence: 3 }, { fromStopId: 'b', toStopId: 'a' }]) {
    assert.deepEqual(provider.rideTime({ ...identity, ...patch }), { status: 'missing' });
  }
  assert.deepEqual(createBusRideCostProvider(snapshot([])).rideTime(identity), { status: 'missing' });
});

test('bus hourly costs respect explicit timezone/date and preserve missing hours', () => {
  const records = [daily, { ...daily, seconds: 95, timeBucket: { startHour: 7, endHour: 8 } }, { ...daily, seconds: 131, timeBucket: { startHour: 8, endHour: 9 } }];
  const provider = createBusRideCostProvider(snapshot(records));
  const at = time => provider.rideTime({ ...identity, requestedTime: new Date(time) });
  assert.equal(at('2026-08-01T07:59:00+09:00').cost.seconds, 95);
  assert.equal(at('2026-07-31T23:20:00Z').cost.seconds, 131);
  assert.equal(at('2026-08-01T09:00:00+09:00').status, 'missing');
  assert.equal(at('2026-09-25T08:20:00+09:00').status, 'missing');
  assert.equal(at('invalid').status, 'missing');
  records[1].timeBucket.startHour = 0; records[2].seconds = 999;
  assert.equal(at('2026-08-01T08:20:00+09:00').cost.seconds, 131);
  assert.equal(provider.rideTime(identity).cost.seconds, 90);
  assert.equal(createBusRideCostProvider(snapshot([daily, daily])).rideTime(identity).status, 'missing');
});

test('bus cost snapshots reject invalid numbers and invalid buckets', () => {
  for (const patch of [{ seconds: 0 }, { seconds: null }, { seconds: -1 }, { seconds: NaN }, { seconds: Infinity },
    { fromSequence: 0 }, { toSequence: 1 }, { timeBasis: '2026-02-30' }, { timeZone: 'invalid-zone' }, { sampleCount: 0 },
    { timeBucket: { startHour: 8, endHour: 8 } }, { timeBucket: { startHour: 23, endHour: 25 } }]) {
    assert.throws(() => createBusRideCostProvider(snapshot([{ ...daily, ...patch }])), /INVALID_SNAPSHOT/);
  }
});

test('actual T-Data fixture → guarded snapshot → provider remains missing until verified', async () => {
  const { loadTDataBusRideSnapshot } = await import('../../backend/t-data-snapshot.mjs');
  const result = loadTDataBusRideSnapshot();
  assert.equal(result.rejected.length, 3);
  assert.equal(createBusRideCostProvider(result.snapshot).rideTime(identity).status, 'missing');
});

test('synthetic verified importer → normalized snapshot → exact hourly cost', async () => {
  const { buildTDataBusRideSnapshot } = await import('../../backend/t-data-mapping.mjs');
  const { loadBusSnapshot } = await import('../../backend/bus-snapshot.mjs');
  const topology = loadBusSnapshot(), route = topology.routes[0], direction = route.directions[0];
  const [a, b] = direction.segments[0].stops;
  const target = { providerId: route.providerId, cityCode: route.cityCode, routeId: route.routeId, direction: direction.direction,
    fromStopId: a.stopId, fromSequence: a.sequence, toStopId: b.stopId, toSequence: b.sequence };
  const result = buildTDataBusRideSnapshot({ topology,
    sectionRaw: [{ routeId: '1', fromStaId: '10', toStaId: '11', fromStaSn: '1', toStaSn: '2', stdrDe: '20260801', tripTime08h: '131' }],
    masterRaw: [{ routeId: '1', nodeId: '10', sttnSn: '1' }, { routeId: '1', nodeId: '11', sttnSn: '2' }],
    crosswalk: [{ source: { routeId: '1', fromStopId: '10', toStopId: '11', fromSequence: 1, toSequence: 2 }, target,
      evidence: { route: 'test proof', fromStop: 'test proof', toStop: 'test proof', direction: 'test proof' } }],
    semantics: { unit: 'seconds', statistic: 'test-mean', measure: 'directed-adjacent-travel-time', timeZone: 'Asia/Seoul', evidence: 'test proof' },
  });
  const provider = createBusRideCostProvider(JSON.parse(JSON.stringify(result.snapshot)));
  const found = provider.rideTime({ ...target, requestedTime: new Date('2026-08-01T08:20:00+09:00') });
  assert.equal(found.cost.seconds, 131); assert.equal(found.cost.source, 'seoul-t-data');
  assert.equal(provider.rideTime({ ...target, direction: '1' }).status, 'missing');
  assert.doesNotMatch(JSON.stringify(result.snapshot), /fromStaId|tripTime|nodeId|apikey/);
});

test('cost source modules have no benchmark dependencies or frontend credentials', () => {
  for (const file of ['../../backend/t-data-model.mjs', '../../backend/t-data-mapping.mjs', '../src/features/transit/bus-ride-costs.ts']) {
    const source = fs.readFileSync(`${__dirname}/${file}`, 'utf8');
    assert.doesNotMatch(source, /import[^;]*(?:kakao|benchmark|external-routing)/i);
  }
  assert.doesNotMatch(fs.readFileSync(`${__dirname}/../src/features/transit/bus-ride-costs.ts`, 'utf8'), /T_DATA_API_KEY|apikey|fetch\(/);
});
