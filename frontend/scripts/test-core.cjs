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
const { findRoute, getRouteStops, getRouteLegs, alarmDelaySeconds } = require('../src/features/journey/route-service.ts');
const { mockStations, stations, stationPlatforms, getStation, getStationByName, stationsOnLine, searchStations } = require('../src/features/stations/stations.ts');
const { sanitizeJourneys } = require('../src/features/journey/journey-storage.ts');
const { parseArrivals, getArrivals } = require('../src/services/seoul-subway.ts');
const { createAlarmManager } = require('../src/features/notifications/alarm-manager.ts');
const { getMapLayout } = require('../src/features/journey/map-layout.ts');
const { parseOfficialRoute, getOfficialRoute } = require('../src/services/official-route.ts');
const { createRouteCostProvider, compareRouteCosts } = require('../src/features/journey/route-costs.ts');

const officialFixture = name => JSON.parse(fs.readFileSync(`${__dirname}/fixtures/${name}.json`, 'utf8'));

require('./test-bus-ride-costs.cjs');

test('실제 버스 snapshot → 독립 topology는 방향·순번·승하차를 보존한다', async () => {
  const { loadBusSnapshot } = await import('../../backend/bus-snapshot.mjs');
  const { getTransitBusGraph } = require('../src/features/transit/bus-graph.ts');
  const snapshot = loadBusSnapshot();
  const graph = getTransitBusGraph(JSON.parse(JSON.stringify(snapshot)));
  const counts = Object.fromEntries(['BUS_STOP', 'BUS_SERVICE_STATE', 'BUS_RIDE', 'BOARD', 'ALIGHT'].map(type =>
    [type, [...graph.nodes, ...graph.edges].filter(item => item.type === type).length]));
  assert.deepEqual(counts, { BUS_STOP: 6, BUS_SERVICE_STATE: 6, BUS_RIDE: 4, BOARD: 6, ALIGHT: 6 });
  assert.equal(snapshot.routes[0].partial, true);
  const states = graph.nodes.filter(n => n.type === 'BUS_SERVICE_STATE');
  assert.deepEqual(states.map(n => [n.service.direction, n.stopSequence]), [['0', 1], ['0', 2], ['0', 3], ['1', 28], ['1', 29], ['1', 30]]);
  const rides = graph.edges.filter(e => e.type === 'BUS_RIDE');
  assert.deepEqual(rides.map(e => [states.find(n => n.id === e.from).stopSequence, states.find(n => n.id === e.to).stopSequence]), [[1, 2], [2, 3], [28, 29], [29, 30]]);
  for (const state of states) {
    const stop = graph.nodes.find(n => n.type === 'BUS_STOP' && n.stopId === state.stopId);
    assert.ok(graph.edges.some(e => e.type === 'BOARD' && e.from === stop.id && e.to === state.id));
    assert.ok(graph.edges.some(e => e.type === 'ALIGHT' && e.from === state.id && e.to === stop.id));
  }
  for (const edge of graph.edges) {
    assert.equal('seconds' in edge, false);
    assert.equal('transferCount' in edge, false);
    assert.equal('transfer' in edge, false);
    assert.equal('patternId' in edge.service, false);
  }
  assert.ok(rides.every(e => !rides.some(reverse => reverse.from === e.to && reverse.to === e.from)));
  console.log('Bus graph:', counts);
});

test('버스 정류장 재사용·재방문·동명이역·부분 구간과 잘못된 순번을 처리한다', async () => {
  const { loadBusSnapshot } = await import('../../backend/bus-snapshot.mjs');
  const { getTransitBusGraph } = require('../src/features/transit/bus-graph.ts');
  // Fixture-derived variants exercise identity; no invented route/stop IDs.
  const repeat = loadBusSnapshot();
  const stops = repeat.routes[0].directions[0].segments[0].stops;
  stops[2] = { ...stops[0], sequence: stops[2].sequence };
  let graph = getTransitBusGraph(repeat);
  assert.equal(graph.nodes.filter(n => n.type === 'BUS_STOP').length, 5);
  assert.equal(graph.nodes.filter(n => n.type === 'BUS_SERVICE_STATE').length, 6);
  const visits = graph.nodes.filter(n => n.type === 'BUS_SERVICE_STATE' && n.stopId === stops[0].stopId);
  assert.equal(visits.length, 2); assert.notEqual(visits[0].id, visits[1].id);
  const twins = loadBusSnapshot();
  const t = twins.routes[0].directions[0].segments[0].stops;
  Object.assign(t[1], { name: t[0].name, latitude: t[0].latitude, longitude: t[0].longitude });
  assert.equal(getTransitBusGraph(twins).nodes.filter(n => n.type === 'BUS_STOP').length, 6);
  const split = loadBusSnapshot();
  const direction = split.routes[0].directions[0];
  direction.segments = [{ stops: direction.segments[0].stops.slice(0, 1) }, { stops: direction.segments[0].stops.slice(1) }];
  assert.equal(getTransitBusGraph(split).edges.filter(e => e.type === 'BUS_RIDE').length, 3);
  const outbound = loadBusSnapshot(); outbound.routes[0].directions.pop(); outbound.routes[0].loadedStops = 3;
  assert.equal(getTransitBusGraph(outbound).edges.filter(e => e.type === 'BUS_RIDE').length, 2);
  const spaced = loadBusSnapshot(); spaced.routes[0].directions[0].segments[0].stops[2].sequence = 7;
  assert.equal(getTransitBusGraph(spaced).edges.filter(e => e.type === 'BUS_RIDE').length, 4);
  for (const sequence of [1, 0, -1, 1.5, NaN]) {
    const bad = loadBusSnapshot(); bad.routes[0].directions[0].segments[0].stops[1].sequence = sequence;
    assert.throws(() => getTransitBusGraph(bad), /BUS_GRAPH_INVALID_DATA/);
  }
  const reversed = loadBusSnapshot(); reversed.routes[0].directions[0].segments[0].stops.reverse();
  assert.throws(() => getTransitBusGraph(reversed), /BUS_GRAPH_INVALID_DATA/);
});

test('Transit adapter는 전체 플랫폼 참조와 모든 방향별 간선을 1:1 보존한다', () => {
  const { getSubwayGraph } = require('../src/features/journey/route-service.ts');
  const { getTransitSubwayGraph } = require('../src/features/transit/subway-adapter.ts');
  const before = findRoute('mock-2-gangnam', 'mock-2-jamsil');
  const source = getSubwayGraph(), graph = getTransitSubwayGraph();
  assert.equal(graph.nodes.length, source.platforms.length);
  assert.equal(new Set(graph.nodes.map(n => n.id)).size, source.platforms.length);
  graph.nodes.forEach((node, i) => {
    assert.equal(node.type, 'SUBWAY_PLATFORM');
    assert.equal(node.platformId, source.platforms[i].id);
    assert.equal(node.id, source.platforms[i].id);
    assert.strictEqual(node.platform, source.platforms[i]);
  });
  assert.deepEqual(graph.edges, source.edges.map(edge => ({ from: edge.from, to: edge.to, type: edge.kind === 'ride' ? 'SUBWAY_RIDE' : 'TRANSFER', transfer: edge.transfer })));
  assert.equal(graph.edges.filter(e => e.type === 'SUBWAY_RIDE').length, source.edges.filter(e => e.kind === 'ride').length);
  assert.equal(graph.edges.filter(e => e.type === 'TRANSFER').length, source.edges.filter(e => e.kind === 'transfer').length);
  const ids = new Set(graph.nodes.map(n => n.id));
  assert.ok(graph.edges.every(e => ids.has(e.from) && ids.has(e.to)));
  assert.ok(Object.isFrozen(graph.nodes) && Object.isFrozen(graph.edges));
  assert.deepEqual(findRoute('mock-2-gangnam', 'mock-2-jamsil'), before);
  console.log(`Transit graph: ${graph.nodes.length} platforms; ${graph.edges.filter(e => e.type === 'SUBWAY_RIDE').length} rides; ${graph.edges.filter(e => e.type === 'TRANSFER').length} transfers`);
});

test('Transit adapter는 성수·신도림 지선, 응암 단방향, 금정 환승을 보존한다', () => {
  const { getTransitSubwayGraph } = require('../src/features/transit/subway-adapter.ts');
  const graph = getTransitSubwayGraph();
  const has = (from, to, type) => graph.edges.some(e => e.from === from && e.to === to && e.type === type);
  for (const [junction, branchStop] of [['성수', '용답'], ['신도림', '도림천']]) {
    const main = `seoul-2호선-${junction}`, branch = `${main}-branch`;
    assert.equal(graph.nodes.filter(n => n.id === main || n.id === branch).length, 2);
    assert.notStrictEqual(graph.nodes.find(n => n.id === main).platform, graph.nodes.find(n => n.id === branch).platform);
    assert.ok(has(main, branch, 'TRANSFER') && has(branch, main, 'TRANSFER'));
    assert.ok(has(branch, `seoul-2호선-${branchStop}`, 'SUBWAY_RIDE'));
    assert.equal(has(main, `seoul-2호선-${branchStop}`, 'SUBWAY_RIDE'), false);
  }
  const loop = ['응암', '역촌', '불광', '독바위', '연신내', '구산', '응암'];
  loop.slice(1).forEach((name, i) => {
    const from = `seoul-6호선-${loop[i]}`, to = `seoul-6호선-${name}`;
    assert.ok(has(from, to, 'SUBWAY_RIDE'));
    assert.equal(has(to, from, 'SUBWAY_RIDE'), false);
  });
  const a = 'seoul-1호선-금정', b = 'seoul-4호선-금정';
  assert.equal(graph.nodes.filter(n => n.id === a || n.id === b).length, 2);
  assert.ok(has(a, b, 'TRANSFER') && has(b, a, 'TRANSFER'));
});

test('실제 fixture 적재는 4개 방향만 허용하고 성수 지선·주행 간선·수치를 검증한다', async () => {
  const { buildSegmentSnapshot, loadSegmentSnapshot } = await import('../../backend/segment-snapshot.mjs');
  const snapshot = loadSegmentSnapshot();
  assert.equal(snapshot.rides.length, 4);
  assert.deepEqual(snapshot.rides.map(r => r.seconds), [60, 90, 180, 180]);
  assert.equal(snapshot.rides[3].toPlatformId, 'seoul-2호선-성수-branch');
  assert.equal(snapshot.rides.some(r => r.fromPlatformId === 'mock-2-yeoksam' && r.toPlatformId === 'mock-2-gangnam'), false);
  for (const invalid of [-1, 0, NaN, Infinity, 1.5, '60', null, 999]) {
    const fixture = officialFixture('gangnam-jamsil');
    fixture.body.paths = [fixture.body.paths[0]];
    fixture.body.paths[0].reqHr = invalid;
    assert.equal(buildSegmentSnapshot([fixture]).rides.length, 0);
  }
  const branch = officialFixture('yongdap-konkuk');
  branch.body.paths = [branch.body.paths[0]];
  branch.body.paths[0].arvlStn.brlnNm = null; // 용답 → 성수 본선 간선은 없음
  assert.equal(buildSegmentSnapshot([branch]).rides.length, 0);
  const wrongLine = officialFixture('gangnam-jamsil');
  wrongLine.body.paths = [wrongLine.body.paths[0]];
  wrongLine.body.paths[0].arvlStn.lineNm = '4호선';
  assert.equal(buildSegmentSnapshot([wrongLine]).rides.length, 0);
});

test('snapshot HTTP endpoint → frontend loader → fallback 탐색이 실제 시간을 사용한다', async () => {
  const { once } = require('node:events');
  const { loadSegmentTimes } = require('../src/services/segment-times.ts');
  const oldPort = process.env.PORT, oldBase = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  let server;
  process.env.PORT = '0';
  try {
    ({ server } = await import('../../backend/seoul-proxy.mjs'));
    if (!server.listening) {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = base;
    const response = await fetch(`${base}/segment-times`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.version, 1);
    assert.equal(data.rides.length, 4);
    const provider = await loadSegmentTimes();
    assert.equal(findRoute('mock-2-gangnam', 'mock-2-seolleung', 'fastest', provider).seconds, 150);
    assert.equal(findRoute('mock-2-yeoksam', 'mock-2-gangnam', 'fastest', provider).seconds, 120);
    assert.equal(findRoute('station-금정', 'station-범계', 'fastest', provider).seconds, 180);
    const route = findRoute('station-용답', 'station-건대입구', 'fastest', provider);
    assert.deepEqual(route.steps.map(s => s.secondsFromStart), [0, 180, 480, 600]);
    assert.equal(route.transfers, 1);
    process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = `${base}/missing`;
    const fallback = await loadSegmentTimes();
    assert.equal(fallback.rideTime('mock-2-gangnam', 'mock-2-yeoksam'), 120);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
    if (oldBase === undefined) delete process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL; else process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = oldBase;
  }
});

test('호선 바는 탑승 구간 시간 비율을 사용하고 환승 대기는 별도로 분리한다', () => {
  const route = parseOfficialRoute(officialFixture('myeonghak-beomgye'), getStationByName('명학'), getStationByName('범계'));
  const result = getRouteLegs(route);
  assert.deepEqual(result.legs.map(leg => leg.seconds), [120, 180]);
  assert.equal(result.transferSeconds, 210);
  assert.equal(result.legs.reduce((sum, leg) => sum + leg.seconds, result.transferSeconds), route.seconds);
  const example = structuredClone(route);
  [0, 19 * 60, 21 * 60, 35 * 60].forEach((seconds, i) => { example.steps[i].secondsFromStart = seconds; });
  assert.deepEqual(getRouteLegs(example).legs.map(leg => leg.seconds / 60), [19, 14]);
  const direct = parseOfficialRoute(officialFixture('gangnam-jamsil'), getStationByName('강남'), getStationByName('잠실'));
  assert.deepEqual(getRouteLegs(direct).legs.map(leg => leg.seconds), [690]);
  const branch = parseOfficialRoute(officialFixture('yongdap-konkuk'), getStationByName('용답'), getStationByName('건대입구'));
  assert.deepEqual(getRouteLegs(branch).legs.map(leg => leg.seconds), [180, 90]);
});

test('공식 응답의 실제 구간 거리와 정차 시간을 포함하며 탑승 전 대기는 제외한다', () => {
  const data = officialFixture('gangnam-jamsil');
  const route = parseOfficialRoute(data, getStationByName('강남'), getStationByName('잠실'));
  assert.equal(route.official.distanceMeters, 6700);
  assert.equal(route.seconds, 690); // 구간 운행 510초 + 중간역 정차 180초
  assert.equal(route.stops, 6);
  assert.equal(route.official.departureAt, '2026-09-24T00:03:30.000Z');
  assert.equal(route.official.arrivalAt, '2026-09-24T00:15:00.000Z');
  assert.deepEqual(route.steps.map(step => step.secondsFromStart), [0, 60, 180, 330, 450, 570, 690]);
  assert.equal(alarmDelaySeconds(route, 1), 570);
  assert.equal(route.steps[1].distanceMeters, 800);
});

test('금정·이수 공식 역명과 호선별 환승·지선 대기 시간을 보존한다', () => {
  for (const [fixture, from, to, seconds, meters, transfers] of [
    ['geumjeong-isu', '금정', '이수', 1590, 17100, 0],
    ['myeonghak-beomgye', '명학', '범계', 510, 4136, 1],
    ['yongdap-konkuk', '용답', '건대입구', 540, 1223, 1],
  ]) {
    const route = parseOfficialRoute(officialFixture(fixture), getStationByName(from), getStationByName(to));
    assert.equal(route.seconds, seconds);
    assert.equal(route.official.distanceMeters, meters);
    assert.equal(route.transfers, transfers);
    assert.equal(getRouteStops(route).length, route.stops + 1);
    if (from === '명학') assert.equal(route.steps[2].secondsFromStart, 330); // 120 + 환승 113 + 대기 97
  }
});

test('자정 통과 시간표를 계산하고 누락·불연속·합계 불일치를 공식 경로로 표시하지 않는다', () => {
  const data = officialFixture('gangnam-jamsil');
  const from = getStationByName('강남'), to = getStationByName('잠실');
  const overnight = structuredClone(data);
  overnight.searchedAt = '2026-09-24T14:59:00.000Z';
  for (const p of overnight.body.paths) for (const field of ['trainDptreTm', 'trainArvlTm']) {
    const [h,m,s] = p[field].split(':').map(Number);
    const shifted = ((h * 3600 + m * 60 + s) + 14 * 3600 + 56 * 60) % 86400;
    p[field] = [Math.floor(shifted / 3600), Math.floor(shifted / 60) % 60, shifted % 60].map(n => String(n).padStart(2,'0')).join(':');
  }
  const route = parseOfficialRoute(overnight, from, to);
  assert.equal(route.seconds, 690);
  assert.equal(route.official.arrivalAt, '2026-09-24T15:11:00.000Z');
  const changes = [
    d => { d.body.paths[0].reqHr = null; },
    d => { d.body.paths[1].dptreStn.stnNm = '삼성'; },
    d => { d.body.paths[0].trainArvlTm = null; },
    d => { d.body.totalDstc++; },
    d => { d.body.totalReqHr++; d.body.totalReqHr++; },
    d => { d.body.paths[0].nonstopYn = 'Y'; },
    d => { d.body.paths[0].dptreStn.lineNm = '미지원선'; },
  ];
  for (const change of changes) { const invalid = structuredClone(data); change(invalid); assert.throws(() => parseOfficialRoute(invalid, from, to)); }
  assert.throws(() => parseOfficialRoute(data, getStationByName('금정'), to));
});

test('공식 경로 클라이언트는 비공개 키 없이 중계 서버를 사용하고 실패를 전달한다', async () => {
  const oldFetch = global.fetch, oldBase = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = 'http://localhost:8083';
  try {
    let expectedDepartureAt = null;
    global.fetch = async (url) => {
      const request = new URL(url);
      assert.equal(request.pathname, '/route');
      assert.equal(request.searchParams.get('from'), '금정');
      assert.equal(request.searchParams.get('to'), '이수');
      assert.equal(request.searchParams.get('preference'), 'fewest-transfers');
      assert.equal(request.searchParams.has('serviceKey'), false);
      assert.equal(request.searchParams.get('departureAt'), expectedDepartureAt);
      return { ok: true, json: async () => officialFixture('geumjeong-isu') };
    };
    assert.equal((await getOfficialRoute(getStationByName('금정'),getStationByName('이수'),'fewest-transfers')).seconds, 1590);
    expectedDepartureAt = '2026-10-06T15:05:00.000Z';
    assert.equal((await getOfficialRoute(getStationByName('금정'),getStationByName('이수'),'fewest-transfers', undefined, expectedDepartureAt)).seconds, 1590);
    global.fetch = async () => ({ ok: false });
    await assert.rejects(getOfficialRoute(getStationByName('금정'),getStationByName('이수'),'fastest'));
  } finally {
    global.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL; else process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL = oldBase;
  }
});

test('공식 중계 요청은 한국 시간·검색 조건을 사용하고 원본 오류의 인증키를 노출하지 않는다', async () => {
  const { fetchOfficialRoute } = await import('../../backend/route-provider.mjs');
  const env = { SUBWAY_API_KEY: 'test%2Bkey%3D', SUBWAY_API_BASE_URL: 'https://apis.data.go.kr/B553766/path2' };
  const fakeFetch = async (url) => {
    assert.equal(url.searchParams.get('serviceKey'), 'test+key=');
    assert.equal(url.searchParams.get('searchDt'), '2026-09-24 09:00:00');
    assert.equal(url.searchParams.get('searchType'), 'transfer');
    assert.equal(url.searchParams.get('schInclYn'), 'Y');
    return { ok: true, json: async () => ({ header: { resultCode: '00' }, body: officialFixture('myeonghak-beomgye').body }) };
  };
  const data = await fetchOfficialRoute({from:'명학',to:'범계',preference:'fewest-transfers'},env,fakeFetch,new Date('2026-09-24T00:00:00Z'));
  assert.equal(data.body.totalDstc,4136);
  await assert.rejects(fetchOfficialRoute({from:'명학',to:'범계'},env, async () => { throw new Error('private serviceKey=test+key='); }), {message:'ROUTE_API_UNAVAILABLE'});
  await assert.rejects(fetchOfficialRoute({from:'명학',to:'범계'},{...env,SUBWAY_API_BASE_URL:'https://example.com'},fakeFetch), {message:'ROUTE_API_INVALID_ENDPOINT'});
});

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

const stationId = (name, line) => stationPlatforms.find(station => station.name === name && station.line === line).id;

test('방향별 검증 시간을 주입하고 누락된 구간은 기본 시간을 사용한다', () => {
  const a = stationId('강남', '2호선'), b = stationId('역삼', '2호선'), c = stationId('선릉', '2호선');
  const provider = createRouteCostProvider({ rides: [
    { fromPlatformId: a, toPlatformId: b, seconds: 90 },
    { fromPlatformId: b, toPlatformId: a, seconds: 110 },
  ] });
  assert.equal(findRoute(a, b, 'fastest', provider).seconds, 90);
  assert.equal(findRoute(b, a, 'fastest', provider).seconds, 110);
  assert.equal(findRoute(b, c, 'fastest', provider).seconds, 120);
  assert.equal(findRoute(a, c, 'fastest', provider).seconds, 210);
  assert.equal(findRoute(a, b).seconds, 120); // 다른 탐색과 데이터가 섞이지 않음
});

test('검증 데이터가 보조 데이터보다 우선하고 잘못된 수치는 fallback하며 입력은 스냅샷이다', () => {
  const rides = [{ fromPlatformId: 'a', toPlatformId: 'b', seconds: 90 }];
  const provider = createRouteCostProvider({ rides, transfers: [{ stationId: 's', fromPlatformId: 'a', toPlatformId: 'b', seconds: 0 }] }, {
    rides: [{ fromPlatformId: 'a', toPlatformId: 'b', seconds: 80 }, { fromPlatformId: 'b', toPlatformId: 'a', seconds: 110 }],
    transfers: [{ stationId: 's', fromPlatformId: 'a', toPlatformId: 'b', seconds: 30 }],
  });
  rides[0].seconds = 999;
  assert.equal(provider.rideTime('a', 'b'), 90);
  assert.equal(provider.rideTime('b', 'a'), 110);
  assert.equal(provider.rideTime('b', 'c'), 120);
  assert.equal(provider.transferTime('s', 'a', 'b'), 0);
  assert.equal(provider.transferTime('s', 'b', 'a'), 300);
  assert.equal(provider.transferTime('other', 'a', 'b'), 300);
  for (const invalid of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '90']) {
    const p = createRouteCostProvider({ rides: [{ fromPlatformId: 'a', toPlatformId: 'b', seconds: invalid }] });
    assert.equal(p.rideTime('a', 'b'), 120);
  }
  const fallbackToSecondary = createRouteCostProvider({ rides: [{ fromPlatformId: 'a', toPlatformId: 'b', seconds: -1 }] }, { rides: [{ fromPlatformId: 'a', toPlatformId: 'b', seconds: 80 }] });
  assert.equal(fallbackToSecondary.rideTime('a', 'b'), 80);
});

test('주행시간 주입으로 빠른 경로가 달라진다', () => {
  const from = stationId('강남', '2호선'), to = stationId('잠실', '2호선');
  const baseline = findRoute(from, to);
  const provider = createRouteCostProvider({ rides: [{ fromPlatformId: from, toPlatformId: stationId('역삼', '2호선'), seconds: 3600 }] });
  const changed = findRoute(from, to, 'fastest', provider);
  assert.equal(baseline.steps[1].station.name, '역삼');
  assert.notEqual(changed.steps[1].station.name, '역삼');
  assert.ok(changed.seconds < 3600);
  assert.equal(changed.seconds, changed.steps.at(-1).secondsFromStart);
});

test('최소 환승은 사전식 비교를 노드 선택과 경로 갱신에 일관되게 적용한다', () => {
  const cost = (transfers, minutes) => ({ transferCount: transfers, totalSeconds: minutes * 60 });
  assert.ok(compareRouteCosts(cost(1, 50), cost(2, 20), 'fewest-transfers') < 0);
  assert.ok(compareRouteCosts(cost(1, 40), cost(1, 50), 'fewest-transfers') < 0);
  assert.ok(compareRouteCosts(cost(1, 50), cost(2, 20), 'fastest') > 0);
  // 실제 연결망 안에 비용이 다른 세 경로를 지정합니다. 나머지 간선은 큰 양의 시간입니다.
  const line = (n, names) => names.split('|').map(name => stationId(name, `${n}호선`));
  const a = [...line(1, '서울역|시청'), ...line(2, '시청|을지로입구|을지로3가|을지로4가|동대문역사문화공원|신당|상왕십리|왕십리|한양대|뚝섬|성수|건대입구|구의|강변|잠실나루|잠실|잠실새내|종합운동장|삼성|선릉|역삼|강남')];
  const b = [...line(1, '서울역'), ...line(4, '서울역|숙대입구|삼각지|신용산|이촌|동작|총신대입구(이수)|사당'), ...line(2, '사당|방배|서초|교대|강남')];
  const c = [...line(1, '서울역|남영|용산|노량진|대방|신길|영등포|신도림'), ...line(2, '신도림|대림|구로디지털단지|신대방|신림|봉천|서울대입구|낙성대|사당|방배|서초|교대|강남')];
  function scenario(paths, totals) {
    const weights = new Map();
    paths.forEach((path, index) => path.slice(1).forEach((to, i) => weights.set(JSON.stringify([path[i], to]), i === 0 ? totals[index] : 0)));
    const lookup = (from, to) => weights.get(JSON.stringify([from, to])) ?? 1_000_000;
    return { rideTime: lookup, transferTime: (_station, from, to) => lookup(from, to) };
  }
  const provider = scenario([a, b], [3000, 1200]);
  const fast = findRoute(a[0], a.at(-1), 'fastest', provider);
  const fewer = findRoute(a[0], a.at(-1), 'fewest-transfers', provider);
  assert.deepEqual([fast.transfers, fast.seconds], [2, 1200]);
  assert.deepEqual([fewer.transfers, fewer.seconds], [1, 3000]);
  const tie = findRoute(a[0], a.at(-1), 'fewest-transfers', scenario([a, b, c], [3000, 1200, 2400]));
  assert.deepEqual([tie.transfers, tie.seconds], [1, 2400]);
  assert.equal(tie.steps[1].station.name, '남영');
  const large = findRoute(a[0], a.at(-1), 'fewest-transfers', scenario([a, b], [200_000, 1200]));
  assert.deepEqual([large.transfers, large.seconds], [1, 200_000]); // 예전 +100_000 방식은 실패
});

test('역별 방향별 환승 시간과 누적 시간·색상 바·알림 계약을 보존한다', () => {
  const from = stationId('명학', '1호선'), a = stationId('금정', '1호선'), b = stationId('금정', '4호선'), to = stationId('범계', '4호선');
  const provider = createRouteCostProvider({ rides: [{ fromPlatformId: from, toPlatformId: a, seconds: 90 }], transfers: [
    { stationId: 'station-금정', fromPlatformId: a, toPlatformId: b, seconds: 80 },
    { stationId: 'station-금정', fromPlatformId: b, toPlatformId: a, seconds: 100 },
  ] });
  const route = findRoute(from, to, 'fastest', provider);
  assert.deepEqual(route.steps.map(step => step.secondsFromStart), [0, 90, 170, 290]);
  assert.deepEqual(route.steps.map(step => step.transfer), [false, false, true, false]);
  assert.deepEqual([route.seconds, route.stops, route.transfers], [290, 2, 1]);
  const parts = getRouteLegs(route);
  assert.deepEqual(parts.legs.map(leg => leg.seconds), [90, 120]);
  assert.equal(parts.transferSeconds, 80);
  assert.deepEqual(getRouteStops(route).map(stop => stop.station.name), ['명학', '금정', '범계']);
  assert.equal(alarmDelaySeconds(route, 1), 170);
  assert.equal(findRoute(to, from, 'fastest', provider).seconds, 340);
  for (const preference of ['fastest', 'fewest-transfers']) {
    for (const target of [from, to]) {
      assert.equal(findRoute('station-금정', target, preference, provider).transfers, 0);
      assert.equal(findRoute(target, 'station-금정', preference, provider).transfers, 0);
    }
  }
});

test('성수·신도림 지선 플랫폼 ID와 단방향 순환은 시간 주입 후에도 유지한다', () => {
  for (const [junction, branchStation, mainStation] of [['성수', '용답', '건대입구'], ['신도림', '도림천', '대림']]) {
    const main = stationId(junction, '2호선'), branch = `${main}-branch`;
    const provider = createRouteCostProvider({ transfers: [{ stationId: getStation(main).id, fromPlatformId: branch, toPlatformId: main, seconds: 45 }] });
    const route = findRoute(stationId(branchStation, '2호선'), stationId(mainStation, '2호선'), 'fastest', provider);
    assert.deepEqual(route.steps.map(step => step.station.id), [stationId(branchStation, '2호선'), branch, main, stationId(mainStation, '2호선')]);
    assert.deepEqual([route.transfers, route.seconds], [1, 285]);
    assert.equal(findRoute(main, stationId(branchStation, '2호선'), 'fastest', provider).transfers, 0);
    assert.equal(findRoute(stationId(branchStation, '2호선'), main, 'fastest', provider).transfers, 0);
  }
  const from = stationId('역촌', '6호선'), to = stationId('응암', '6호선');
  const provider = createRouteCostProvider({ rides: [{ fromPlatformId: from, toPlatformId: to, seconds: 1 }] });
  const route = findRoute(from, to, 'fastest', provider);
  assert.deepEqual(route.steps.map(step => step.station.name), ['역촌', '불광', '독바위', '연신내', '구산', '응암']);
  assert.equal(route.seconds, 600); // 금지된 역방향 간선은 데이터가 있어도 생성하지 않음
});

test('잘못된 사용자 정의 provider 비용과 합계 overflow는 다익스트라에 들어가지 않는다', () => {
  const from = stationId('강남', '2호선'), to = stationId('선릉', '2호선');
  for (const seconds of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => findRoute(from, to, 'fastest', { rideTime: () => seconds, transferTime: () => seconds }), /비음수 안전 정수/);
  }
});

test('1~9호선 검색과 별칭을 지원하고 입력이 빈 경우 결과를 숨긴다', () => {
  for (let line = 1; line <= 9; line++) assert.ok(stations.some(station => station.lines.includes(`${line}호선`)));
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
  for (const station of stationPlatforms) {
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
  assert.deepEqual(sanitizeJourneys([null, 1, {}, valid, valid, { fromId: valid.fromId, toId: 'missing' }, { fromId: valid.fromId, toId: valid.fromId }]), [{ fromId: 'station-강남', toId: 'station-잠실' }]);
  assert.deepEqual(sanitizeJourneys({}), []);
});

test('환승역은 검색과 선택에서 하나이며 이수·총신대입구 별칭도 같은 역을 반환한다', () => {
  const isu = getStationByName('이수');
  assert.deepEqual(isu.lines, ['4호선', '7호선']);
  for (const query of ['이수', '총신대입구', '총신대 입구역', '총신대입구(이수)', '이수(총신대 입구)역']) {
    assert.deepEqual(searchStations(query), [isu]);
  }
  assert.equal(getStationByName('이수(총신대입구)'), isu);
  assert.equal(getStation(stationId('총신대입구(이수)', '4호선')), isu);
  assert.equal(getStation(stationId('이수', '7호선')), isu);
  assert.deepEqual(searchStations('금정').map(station => station.lines), [['1호선', '4호선']]);
  assert.deepEqual(searchStations('종로3가').map(station => station.lines), [['1호선', '3호선', '5호선']]);
  for (const line of ['1호선', '4호선']) {
    assert.equal(stationsOnLine(line).filter(station => station.name === '금정').length, 1);
  }
  assert.equal(new Set(stations.map(station => station.id)).size, stations.length);
});

test('기존 노선의 누락 구간과 금정 주변 역 순서를 연결한다', () => {
  const cases = [
    ['1호선', ['명학', '금정', '군포', '당정', '의왕']],
    ['4호선', ['평촌', '범계', '금정', '산본', '수리산']],
    ['1호선', ['연천', '전곡', '청산', '소요산']],
    ['1호선', ['병점', '서동탄']],
    ['1호선', ['금천구청', '광명']],
    ['1호선', ['동인천', '인천']],
    ['1호선', ['아산', '탕정', '배방', '온양온천', '신창']],
    ['3호선', ['대화', '주엽', '정발산', '마두', '백석', '대곡']],
    ['4호선', ['진접', '오남', '별내별가람', '불암산']],
    ['4호선', ['초지', '안산', '신길온천', '정왕', '오이도']],
    ['5호선', ['상일동', '강일', '미사', '하남풍산', '하남시청', '하남검단산']],
    ['7호선', ['온수', '까치울', '부천종합운동장', '춘의', '신중동', '부천시청', '상동', '삼산체육관', '굴포천', '부평구청', '산곡', '석남']],
    ['8호선', ['별내', '다산', '동구릉', '구리', '장자호수공원', '암사역사공원', '암사']],
    ['신분당선', ['청계산입구', '판교', '정자', '미금', '동천', '수지구청', '성복', '상현', '광교중앙', '광교']],
  ];
  for (const [line, names] of cases) {
    const route = findRoute(stationId(names[0], line), stationId(names.at(-1), line));
    assert.deepEqual(route.steps.map(step => step.station.name), names, line);
    assert.equal(route.transfers, 0);
  }
});

test('통합 역에서 출발·도착할 때 적절한 호선을 사용하고 환승을 추가하지 않는다', () => {
  for (const [from, to, line] of [['금정', '명학', '1호선'], ['금정', '범계', '4호선'], ['이수', '사당', '4호선'], ['이수', '남성', '7호선']]) {
    const origin = getStationByName(from), destination = getStationByName(to);
    for (const [a, b] of [[origin, destination], [destination, origin]]) {
      const route = findRoute(a.id, b.id);
      assert.equal(route.stops, 1);
      assert.equal(route.transfers, 0);
      assert.equal(route.seconds, 120);
      assert.ok(route.steps.every(step => step.station.line === line));
    }
  }
  assert.equal(findRoute(getStationByName('이수').id, getStationByName('총신대입구').id), null);
});

test('환승 경로에는 금정·이수를 한 번 표시하면서 환승 소요 시간을 유지한다', () => {
  for (const [from, via, to, lines] of [['명학', '금정', '범계', ['1호선', '4호선']], ['남성', '이수', '동작', ['7호선', '4호선']]]) {
    const route = findRoute(getStationByName(from).id, getStationByName(to).id);
    const stops = getRouteStops(route);
    assert.equal(route.transfers, 1);
    assert.equal(route.stops, 2);
    assert.equal(route.seconds, 540);
    assert.deepEqual(stops.map(stop => stop.station.id), [from, via, to].map(name => getStationByName(name).id));
    assert.deepEqual(stops[1].lines, lines);
    assert.equal(stops[1].transfer, true);
    assert.equal(alarmDelaySeconds(route, 1), 420);
  }
});

test('기존 호선별 저장 경로를 통합하고 같은 환승역 간 경로·중복을 제거한다', () => {
  const first = { fromId: stationId('총신대입구(이수)', '4호선'), toId: stationId('강남', '2호선') };
  const duplicate = { fromId: stationId('이수', '7호선'), toId: stationId('강남', '신분당선') };
  const canonical = { fromId: 'station-이수', toId: 'station-강남' };
  assert.deepEqual(sanitizeJourneys([first, duplicate, canonical, { fromId: first.fromId, toId: duplicate.fromId }]), [canonical]);
});

test('노선도에서 본선·지선의 모든 역을 선택할 수 있고 접점은 중복 표시하지 않는다', () => {
  const counts = { '1호선': 102, '2호선': 51, '3호선': 44, '4호선': 51, '5호선': 56, '6호선': 39, '7호선': 53, '8호선': 24, '9호선': 38, '신분당선': 16 };
  for (const [line, count] of Object.entries(counts)) {
    const layout = getMapLayout(line);
    assert.equal(layout.stations.length, count, line);
    assert.deepEqual(new Set(layout.stations.map(point => point.station.id)), new Set(stationsOnLine(line).map(station => station.id)));
    assert.equal(new Set(layout.stations.map(point => point.station.id)).size, layout.stations.length);
    assert.ok(layout.stations.every(point => point.y + 60 < layout.height && point.x > 40 && point.x < 950));
  }
  const two = getMapLayout('2호선');
  assert.ok(two.stations.some(point => point.station.name === '을지로입구'));
  assert.ok(two.stations.some(point => point.station.name === '신정네거리'));
  assert.equal(two.stations.filter(point => point.station.name === '성수').length, 1);
  assert.equal(getMapLayout('6호선').connections.filter(connection => connection.oneWay).length, 6);
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
