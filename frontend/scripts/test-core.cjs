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
const { mockStations, stations, searchStations } = require('../src/features/stations/stations.ts');
const { sanitizeJourneys } = require('../src/features/journey/journey-storage.ts');
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

const stationId = (name, line) => stations.find(station => station.name === name && station.line === line).id;

test('1~9호선 검색과 별칭을 지원하고 입력이 빈 경우 결과를 숨긴다', () => {
  for (let line = 1; line <= 9; line++) assert.ok(stations.some(station => station.line === `${line}호선`));
  assert.ok(stations.length > 300);
  assert.ok(searchStations(' 강 남 역 ').some(station => station.name === '강남'));
  assert.ok(searchStations('역삼').some(station => station.name === '역삼'));
  assert.ok(searchStations('당고개').some(station => station.name === '불암산'));
  assert.ok(searchStations('뚝섬유원지').some(station => station.name === '자양'));
  assert.equal(searchStations('강남', '2호선').length, 1);
  assert.deepEqual(searchStations(''), []);
  assert.deepEqual(searchStations('없는지하철역'), []);
});

test('확장한 모든 역은 서울역에서 접근 가능하고 순환선·지선을 연결한다', () => {
  const origin = stationId('서울역', '1호선');
  for (const station of stations) {
    if (station.id === origin) continue;
    const route = findRoute(origin, station.id);
    assert.ok(route, `${station.name} ${station.line}`);
    assert.equal(route.steps.at(-1).station.id, station.id);
    assert.equal(route.stops + route.transfers, route.steps.length - 1);
  }
  assert.equal(findRoute(stationId('시청', '2호선'), stationId('충정로', '2호선')).stops, 1);
  assert.equal(findRoute(stationId('용답', '2호선'), stationId('신설동', '2호선')).stops, 3);
  assert.equal(findRoute(stationId('총신대입구(이수)', '4호선'), stationId('이수', '7호선')).transfers, 1);
});

test('6호선 응암 순환은 단방향이며 반대 방향으로 지름길을 만들지 않는다', () => {
  const forward = findRoute(stationId('구산', '6호선'), stationId('역촌', '6호선'));
  const reverse = findRoute(stationId('역촌', '6호선'), stationId('구산', '6호선'));
  assert.deepEqual(forward.steps.map(step => step.station.name), ['구산', '응암', '역촌']);
  assert.deepEqual(reverse.steps.map(step => step.station.name), ['역촌', '불광', '독바위', '연신내', '구산']);
});

test('2호선 지선은 본선으로 갈 때 갈아타고, 지선에서 출발할 때는 불필요한 환승을 세지 않는다', () => {
  const through = findRoute(stationId('용답', '2호선'), stationId('건대입구', '2호선'));
  assert.equal(through.transfers, 1);
  assert.equal(through.stops, 2);
  assert.equal(through.seconds, 540);
  const start = findRoute(stationId('성수', '2호선'), stationId('용답', '2호선'));
  const end = findRoute(stationId('용답', '2호선'), stationId('성수', '2호선'));
  assert.equal(start.transfers, 0);
  assert.equal(end.transfers, 0);
  assert.equal(start.seconds, 120);
  assert.equal(end.seconds, 120);
  assert.equal(start.steps[0].station.id, stationId('성수', '2호선'));
  assert.equal(end.steps.at(-1).station.id, stationId('성수', '2호선'));
  assert.equal(findRoute(stationId('도림천', '2호선'), stationId('대림', '2호선')).transfers, 1);
});

test('최소 환승은 소요 시간보다 환승 수를 우선하고 실제 시간을 별도로 반환한다', () => {
  const fast = findRoute('mock-1-seoul', 'mock-2-gangnam');
  const fewer = findRoute('mock-1-seoul', 'mock-2-gangnam', 'fewest-transfers');
  assert.ok(fewer.transfers < fast.transfers);
  assert.ok(fewer.seconds >= fast.seconds);
  assert.equal(fewer.seconds, fewer.stops * 120 + fewer.transfers * 300);
  assert.equal(alarmDelaySeconds(findRoute('mock-2-gangnam', 'mock-2-jamsil'), 3), 360);
});

test('저장한 경로를 복원할 때 손상된 데이터·중복·삭제된 역을 걸러낸다', () => {
  const valid = { fromId: 'mock-2-gangnam', toId: 'mock-2-jamsil' };
  assert.deepEqual(sanitizeJourneys([null, 1, {}, valid, valid, { fromId: valid.fromId, toId: 'missing' }, { fromId: valid.fromId, toId: valid.fromId }]), [valid]);
  assert.deepEqual(sanitizeJourneys({}), []);
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
