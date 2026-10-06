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

const { subwayServiceMatchesLeg } = require('../src/services/subway-service-direction.ts');
const { mergeSubwayVehicleCandidates, getSubwayCorridor, getSubwayVehicleCandidates,
  normalizeSubwayArrivalStatus } = require('../src/services/subway-vehicle-candidates.ts');
const { parseArrivals } = require('../src/services/seoul-subway.ts');
const { findRoute } = require('../src/features/journey/route-service.ts');
const { createJourneyPlan } = require('../src/features/transit/journey-plan.ts');
const { getStationByName } = require('../src/features/stations/stations.ts');

function leg(from, to, line) {
  const route = findRoute(getStationByName(from).id, getStationByName(to).id);
  return createJourneyPlan(route).legs.find(item => item.kind === 'RIDE' && item.line === line);
}
const stamp = '2026-10-03T08:10:00+09:00';
const observedAt = new Date(stamp).toISOString();
const receivedAt = '2026-10-03 08:10:00';
function position(trainId, direction, stationName, destination, lineId = '1004', status = '2') {
  return { trainId, lineId, direction, stationName, destination, status, observedAt, express: false };
}
function arrival(trainId, direction, destination, seconds = 60, lineId = '1004', arrivalCode = '99') {
  return { trainId, direction, destination, seconds, lineId, arrivalCode, receivedAt, message: '' };
}

test('금정→이수는 상행만, 금정→산본은 하행만 표시하며 단축 운행을 제외한다', () => {
  const north = leg('금정', '이수', '4호선'), south = leg('금정', '산본', '4호선');
  const positions = [position('up', '0', '금정', '진접'), position('down', '1', '금정', '오이도'),
    position('short', '0', '금정', '사당'), position('unknown', null, '금정', null)];
  assert.deepEqual(mergeSubwayVehicleCandidates(north, [], positions, observedAt).map(item => item.trainId), ['up']);
  assert.deepEqual(mergeSubwayVehicleCandidates(south, [], positions, observedAt).map(item => item.trainId), ['down']);
  assert.equal(subwayServiceMatchesLeg(north, '상행', '총신대입구(이수)행'), true);
  assert.equal(subwayServiceMatchesLeg(north, '0', null), false);
  assert.equal(subwayServiceMatchesLeg(north, '0', '상행방면'), false);
});

test('금정→어린이대공원은 오이도→이수와 석남→어린이대공원을 하차역까지 표시한다', () => {
  const journey = createJourneyPlan(findRoute(getStationByName('금정').id, getStationByName('어린이대공원').id));
  const rides = journey.legs.filter(item => item.kind === 'RIDE');
  assert.deepEqual(rides.map(item => item.line), ['4호선', '7호선']);
  for (const [line, first, excluded] of [['4호선', '오이도', '동작'], ['7호선', '석남', '군자']]) {
    const wanted = rides.find(item => item.line === line);
    const corridor = getSubwayCorridor(wanted);
    assert.equal(corridor[0].name, first);
    assert.equal(corridor.at(-1).name, wanted.to.name);
    assert.equal(corridor.at(-1).relativeStopIndex, wanted.stops.length - 1);
    assert.ok(!corridor.some(stop => stop.name === excluded));
    assert.equal(corridor.find(stop => stop.relativeStopIndex === 0).name, wanted.from.name);
    assert.deepEqual(corridor.filter(stop => stop.onLeg).map(stop => stop.name), wanted.stops.map(stop => stop.name));
    assert.ok(corridor.every(stop => stop.stationId !== null));
  }
});

test('승차역에서 멀리 떨어진 앞 열차를 포함하고 하차역을 지난 열차는 제외한다', () => {
  const north = leg('금정', '이수', '4호선');
  const positions = [position('origin', '0', '오이도', '진접', '1004', '2'),
    position('far', '0', '안산', '진접', '1004', '3'),
    position('beyond', '0', '동작', '진접', '1004', '1'),
    position('opposite', '1', '안산', '오이도', '1004', '2')];
  const candidates = mergeSubwayVehicleCandidates(north, [], positions, observedAt);
  assert.deepEqual(candidates.map(item => item.trainId), ['origin', 'far']);
  assert.ok(candidates.every(item => item.relativeStopIndex < -3));
  const seven = leg('이수', '어린이대공원', '7호선');
  assert.deepEqual(mergeSubwayVehicleCandidates(seven, [], [
    position('west', '0', '석남', '장암', '1007'), position('east', '0', '군자', '장암', '1007'),
  ], observedAt).map(item => item.trainId), ['west']);
});

test('지선의 연결된 앞 구간은 포함하고 갈라지는 시작점은 임의로 고르지 않는다', () => {
  const five = getSubwayCorridor(leg('둔촌동', '마천', '5호선'));
  assert.equal(five[0].name, '방화');
  assert.equal(five.at(-1).name, '마천');
  assert.ok(five.some(stop => stop.name === '강동'));
  assert.ok(!five.some(stop => stop.name === '길동'));
  const one = getSubwayCorridor(leg('금정', '수원', '1호선'));
  assert.equal(one[0].name, '연천');
  assert.equal(one.at(-1).name, '수원');
  const ambiguous = getSubwayCorridor(leg('금정', '안양', '1호선'));
  assert.equal(ambiguous[0].name, '병점');
  assert.ok(!ambiguous.some(stop => stop.name === '신창' || stop.name === '서동탄'));
});

test('이수→어린이대공원은 7호선 상행과 하차역까지 가는 종착역만 허용한다', () => {
  const wanted = leg('이수', '어린이대공원', '7호선');
  assert.equal(subwayServiceMatchesLeg(wanted, '0', '장암'), true);
  assert.equal(subwayServiceMatchesLeg(wanted, '상행', '도봉산행 - 장암방면'), true);
  assert.equal(subwayServiceMatchesLeg(wanted, '1', '석남'), false);
  assert.equal(subwayServiceMatchesLeg(wanted, '0', '건대입구'), false);
});

test('2호선 내외선과 성수·신도림 지선은 경로 정차 순서와 종착역을 함께 확인한다', () => {
  const outer = leg('강남', '삼성', '2호선'), inner = leg('강남', '교대', '2호선');
  assert.equal(subwayServiceMatchesLeg(outer, '외선', '외선순환'), true);
  assert.equal(subwayServiceMatchesLeg(outer, '외선', null), false);
  assert.equal(subwayServiceMatchesLeg(outer, '외선', '내선순환'), false);
  assert.equal(subwayServiceMatchesLeg(outer, '내선', '내선순환'), false);
  assert.equal(subwayServiceMatchesLeg(inner, '내선', '내선순환'), true);
  assert.equal(subwayServiceMatchesLeg(outer, '1', '선릉'), false);
  assert.equal(subwayServiceMatchesLeg(outer, '1', '성수'), true);
  assert.equal(subwayServiceMatchesLeg(outer, '1', '신설동'), false);
  for (const [from, to, terminal] of [['용답', '신답', '신설동'], ['도림천', '양천구청', '까치산']]) {
    const spur = leg(from, to, '2호선');
    assert.equal(subwayServiceMatchesLeg(spur, '0', terminal), true);
    assert.equal(subwayServiceMatchesLeg(spur, '1', terminal), true); // Ring code is not applied to spur order.
    assert.equal(subwayServiceMatchesLeg(spur, '0', '내선순환'), false);
    assert.equal(subwayServiceMatchesLeg(spur, '1', null), false);
  }
});

test('1·5호선 지선 종착역이나 급행이 경로 정차를 보장하지 않으면 제외한다', () => {
  const main = leg('금정', '수원', '1호선');
  assert.equal(subwayServiceMatchesLeg(main, '1', '신창'), true);
  assert.equal(subwayServiceMatchesLeg(main, '1', '광명'), false);
  assert.equal(subwayServiceMatchesLeg(main, '1', '신창', true), false);
  const five = leg('천호', '상일동', '5호선');
  assert.equal(subwayServiceMatchesLeg(five, '1', '하남검단산'), true);
  assert.equal(subwayServiceMatchesLeg(five, '1', '마천'), false);
});

test('동일 번호의 반대 방향 관측을 도착 후보의 위치로 연결하지 않는다', () => {
  const wanted = leg('금정', '이수', '4호선');
  const candidates = mergeSubwayVehicleCandidates(wanted, [arrival('same', '상행', '진접')],
    [position('same', '1', '금정', '오이도')], observedAt);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].currentStationName, null);
  assert.equal(candidates[0].positionAssociation, 'NONE');
  assert.equal(candidates[0].matchStatus, 'UNVERIFIED');
  assert.equal(candidates[0].routeDirectionMatched, true);
});

test('승차역 출발 상태를 위치 없는 후보에도 보존한다', () => {
  const wanted = leg('금정', '산본', '4호선');
  const candidate = mergeSubwayVehicleCandidates(wanted, [arrival('departed', '하행', '오이도', 0, '1004', '2')], [], observedAt)[0];
  assert.equal(candidate.boardingPhase, 'DEPARTING');
  assert.equal(candidate.relativeStopIndex, null);
});

test('다음역 ETA는 승차역 ETA와 분리하고 번호·호선·방향·종착역을 확인한다', () => {
  const wanted = leg('금정', '산본', '4호선');
  const stop = getSubwayCorridor(wanted).find(item => item.name === '산본');
  const positions = [position('chosen', '1', '금정', '오이도')];
  const base = [arrival('chosen', '하행', '오이도', 0)];
  const segments = [{ stop, arrivals: [arrival('chosen', '하행', '오이도', 90)], fetchedAt: observedAt }];
  const candidate = mergeSubwayVehicleCandidates(wanted, base, positions, observedAt, segments)[0];
  assert.equal(candidate.etaSeconds, 0);
  assert.equal(candidate.segmentArrival.seconds, 90);
  assert.equal(candidate.segmentArrival.relativeStopIndex, 1);
  assert.equal(candidate.segmentArrival.phase, 'RUNNING');
  for (const wrong of [arrival('other', '하행', '오이도'), arrival('chosen', '상행', '진접'),
    arrival('chosen', '하행', '오이도', 90, '1007'), arrival('chosen', '하행', '안산'),
    arrival('chosen', '하행', '오이도', 90, '1004', '4'), arrival('chosen', '하행', '오이도', 90, '1004', '5')]) {
    assert.equal(mergeSubwayVehicleCandidates(wanted, base, positions, observedAt,
      [{ stop, arrivals: [wrong], fetchedAt: observedAt }])[0].segmentArrival, null);
  }
});

test('도착 API 상태·종착역·급행 및 지연 보정값을 보존한다', () => {
  assert.deepEqual(['0', '1', '2', '3', '4', '5', '99', '9'].map(normalizeSubwayArrivalStatus),
    ['ARRIVING', 'STOPPED', 'DEPARTING', 'RUNNING', 'UNKNOWN', 'UNKNOWN', 'RUNNING', 'UNKNOWN']);
  const rows = parseArrivals({ realtimeArrivalList: [{ subwayId: '1004', btrainNo: '4444', updnLine: '하행',
    trainLineNm: '오이도행 - 산본방면', bstatnNm: '오이도', barvlDt: '90', arvlCd: '3', btrainSttus: '일반', recptnDt: receivedAt }] },
  '4호선', Date.parse(stamp) + 20_000);
  assert.equal(rows[0].seconds, 70);
  assert.equal(rows[0].arrivalCode, '3');
  assert.equal(rows[0].terminalName, '오이도');
  assert.equal(rows[0].express, false);
});

test('다음역 조회는 차량마다 호출하지 않고 역별로 합쳐 조회하며 실패해도 위치 후보를 유지한다', async () => {
  const oldFetch = global.fetch, oldBase = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  const currentReceived = new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const wanted = leg('금정', '산본', '4호선');
  const calls = [];
  process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = 'http://localhost:8083';
  try {
    global.fetch = async url => {
      const request = new URL(url), station = request.searchParams.get('station');
      calls.push(`${request.pathname}:${station ?? ''}`);
      if (request.pathname === '/positions') return { ok: true, json: async () => ({ realtimePositionList:
        ['one', 'two'].map(trainNo => ({ subwayId: '1004', trainNo, statnNm: '금정', updnLine: '1',
          statnTnm: '오이도', trainSttus: '2', directAt: '0', recptnDt: currentReceived })) }) };
      if (station === '산본') throw new Error('Optional next-station lookup failed');
      return { ok: true, json: async () => ({ errorMessage: { code: 'INFO-200' } }) };
    };
    const candidates = await getSubwayVehicleCandidates(wanted);
    assert.equal(candidates.length, 2);
    assert.deepEqual(calls.sort(), ['/arrivals:금정', '/arrivals:산본', '/positions:']);
    assert.ok(candidates.every(candidate => candidate.segmentArrival === null));
  } finally {
    global.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
    else process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = oldBase;
  }
});
