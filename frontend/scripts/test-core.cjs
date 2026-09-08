const fs = require('node:fs');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Expo 런타임 없이 순수 TS 로직을 검사합니다. 추가 테스트 의존성은 없습니다.
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(compiled.outputText, filename);
};
const { findRoute, alarmDelaySeconds } = require('../src/features/journey/route-service.ts');
const { mockStations } = require('../src/features/stations/stations.ts');
const { parseArrivals, getArrivals } = require('../src/services/seoul-subway.ts');
const { createAlarmManager } = require('../src/features/notifications/alarm-manager.ts');

test('강남→잠실은 누락된 중간역을 포함한 6개 역 이동이며 알림 시점을 역산한다', () => {
  const route = findRoute('mock-2-gangnam', 'mock-2-jamsil');
  assert.equal(route.stops, 6);
  assert.equal(route.transfers, 0);
  assert.equal(route.seconds, 720);
  assert.ok(route.steps.some(step => step.station.name === '잠실새내'));
  assert.equal(alarmDelaySeconds(route, 1), 600);
  assert.equal(alarmDelaySeconds(route, 2), 480);
  assert.equal(alarmDelaySeconds(findRoute('mock-2-gangnam', 'mock-2-yeoksam'), 2), 1);
});

test('모든 검색 가능 역 쌍은 양방향 연결되며 환승을 이동 역 수에서 제외한다', () => {
  for (const from of mockStations) for (const to of mockStations) {
    const route = findRoute(from.id, to.id);
    if (from.id === to.id) { assert.equal(route, null); continue; }
    assert.ok(route);
    assert.equal(route.steps[0].station.id, from.id);
    assert.equal(route.steps.at(-1).station.id, to.id);
    assert.equal(route.seconds, findRoute(to.id, from.id).seconds);
    assert.equal(route.stops + route.transfers, route.steps.length - 1);
  }
  assert.equal(findRoute('missing', 'mock-2-gangnam'), null);
  const transfer = findRoute('mock-1-cityhall', 'mock-2-cityhall');
  assert.equal(transfer.transfers, 1);
  assert.equal(transfer.stops, 0);
});

test('실시간 응답은 호선·생성 시각을 검증하고 지연을 보정한다', () => {
  const now = Date.parse('2026-09-08T12:01:00+09:00');
  const row = { subwayId: '1002', btrainNo: '1234', recptnDt: '2026-09-08 12:00:00', barvlDt: '120', arvlMsg2: '접근 중' };
  const payload = { errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [row, { ...row, subwayId: '1001' }, { ...row, recptnDt: '2026-09-08 11:50:00' }, null] };
  const arrivals = parseArrivals(payload, '2호선', now);
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].seconds, 60);
  assert.equal(parseArrivals({ realtimeArrivalList: [{ ...row, barvlDt: '' }] }, '2호선', now)[0].seconds, null);
  assert.deepEqual(parseArrivals({ errorMessage: { code: 'INFO-200' } }, '2호선', now), []);
  assert.throws(() => parseArrivals({ errorMessage: { code: 'ERROR-300' } }, '2호선', now));
  assert.throws(() => parseArrivals({}, '2호선', now));
});

test('API 미설정 및 HTTP 오류를 명확히 반환한다', async () => {
  const previousBase = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  const previousFetch = global.fetch;
  try {
    delete process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
    await assert.rejects(getArrivals('강남', '2호선'), /설정되지/);
    process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = 'http://localhost:8083';
    global.fetch = async (url) => { assert.ok(url.endsWith('station=%EA%B0%95%EB%82%A8')); return { ok: false }; };
    await assert.rejects(getArrivals('강남', '2호선'), /가져오지/);
  } finally {
    global.fetch = previousFetch;
    if (previousBase === undefined) delete process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
    else process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = previousBase;
  }
});

function setup(overrides = {}) {
  let now = 1000;
  let schedules = 0;
  let cancels = 0;
  const manager = createAlarmManager({
    restoreAlarm: async () => null,
    requestAlarmPermission: async () => {},
    scheduleAlarm: async () => { schedules++; },
    cancelAlarm: async () => { cancels++; },
    ...overrides,
  }, () => now);
  return { manager, counts: () => ({ schedules, cancels }), advance: (value) => { now = value; manager.tick(); } };
}

test('동시 시작은 한 번 예약하고 마감 시 한 번만 알림 상태로 바뀐다', async () => {
  const { manager, counts, advance } = setup();
  await Promise.all([manager.start('잠실', 10, true), manager.start('잠실', 10, true)]);
  assert.equal(counts().schedules, 1);
  assert.equal(manager.getSnapshot().status, 'active');
  advance(11000);
  assert.equal(manager.getSnapshot().status, 'fired');
  const snapshot = manager.getSnapshot();
  advance(12000);
  assert.equal(manager.getSnapshot(), snapshot);
  await manager.cancel();
  advance(20000);
  assert.equal(manager.getSnapshot().status, 'idle');
  await manager.start('강남', 10, false);
  assert.equal(counts().schedules, 2);
});

test('권한 거부·예약 실패·취소 실패·복원·잘못된 시간을 처리한다', async () => {
  const denied = setup({ requestAlarmPermission: async () => { throw new Error('권한 거부'); } });
  await denied.manager.start('잠실', 10, true);
  assert.equal(denied.manager.getSnapshot().status, 'idle');
  assert.equal(denied.manager.getSnapshot().error, '권한 거부');
  assert.equal(denied.counts().schedules, 0);
  const failed = setup({ scheduleAlarm: async () => { throw new Error('예약 실패'); } });
  await failed.manager.start('잠실', 10, true);
  assert.equal(failed.manager.getSnapshot().status, 'idle');
  assert.equal(failed.manager.getSnapshot().busy, false);
  const restored = setup({ restoreAlarm: async () => ({ destination: '잠실', deadline: 5000, demo: true }), cancelAlarm: async () => { throw new Error('취소 실패'); } });
  await restored.manager.initialize();
  assert.equal(restored.manager.getSnapshot().status, 'active');
  await restored.manager.cancel();
  assert.equal(restored.manager.getSnapshot().status, 'active');
  assert.match(restored.manager.getSnapshot().error, /취소/);
  const invalid = setup();
  await invalid.manager.start('잠실', NaN, false);
  assert.equal(invalid.counts().schedules, 0);
});
