const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(compiled.outputText, filename);
};

const { distanceMetersBetween, findNearbyStations, formatNearbyDistance } = require('../src/features/stations/nearby-stations.ts');
const { getStationByName, stations } = require('../src/features/stations/stations.ts');
const catalog = require('../src/features/stations/station-locations.json');
const { buildCatalog, parseCsv } = require('./build-station-locations.cjs');

// Synthetic coordinates exercise geographic matching independently of the catalog.
const origin = { latitude: 37, longitude: 127 };
const stationPoint = (name, latitude, longitude = 127) => ({ stationId: getStationByName(name).id, latitude, longitude });

test('geographic distances are finite, symmetric and reject invalid GPS coordinates', () => {
  assert.equal(distanceMetersBetween(origin, origin), 0);
  const oneDegree = distanceMetersBetween({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
  assert.ok(oneDegree > 111000 && oneDegree < 111300);
  const other = { latitude: 37.01, longitude: 127.02 };
  assert.equal(distanceMetersBetween(origin, other), distanceMetersBetween(other, origin));
  assert.throws(() => findNearbyStations({ latitude: NaN, longitude: 127 }, []));
  assert.throws(() => distanceMetersBetween(origin, { latitude: 91, longitude: 127 }));
});

test('nearby station selection sorts by distance and merges interchange platforms', () => {
  const points = [stationPoint('금정', 37.003), stationPoint('산본', 37.002),
    stationPoint('금정', 37.001), stationPoint('범계', 37.009), stationPoint('수원', 37.004)];
  const result = findNearbyStations(origin, points);
  assert.deepEqual(result.map(item => item.station.name), ['금정', '산본', '수원']);
  assert.ok(result[0].distanceMeters < 120);
  assert.equal(new Set(result.map(item => item.station.id)).size, result.length);
  assert.deepEqual(result[0].station.lines, ['1호선', '4호선']);
});

test('unsupported, malformed and faraway stations cannot become GPS connections', () => {
  const points = [stationPoint('금정', 38), stationPoint('산본', NaN),
    { stationId: 'unknown-station', latitude: 37, longitude: 127 }];
  assert.deepEqual(findNearbyStations(origin, points), []);
  assert.deepEqual(findNearbyStations(origin, [stationPoint('금정', 37.001)], 3, 50), []);
  assert.throws(() => findNearbyStations(origin, [], 0));
});

test('nearby distances are presented as approximate meters or kilometers', () => {
  assert.equal(formatNearbyDistance(347), '350m');
  assert.equal(formatNearbyDistance(1234), '1.2km');
});

test('the official coordinate catalog covers every supported physical station', () => {
  const supported = new Set(stations.map(station => station.id));
  const covered = new Set(catalog.points.map(point => point.stationId));
  assert.deepEqual(covered, supported);
  assert.deepEqual(catalog.missingStationIds, []);
  assert.equal(catalog.coverage.coveredStationCount, stations.length);
  assert.equal(catalog.coverage.coordinateCount, catalog.points.length);
  assert.equal(new Set(catalog.points.map(point => point.sourceStationId)).size, catalog.points.length);
  for (const point of catalog.points) {
    assert.ok(point.latitude >= 36 && point.latitude <= 39);
    assert.ok(point.longitude >= 125 && point.longitude <= 129);
    assert.ok(point.sourceStationId && point.sourceStationName && point.sourceLine);
  }
});

test('real coordinates locate the requested journey stations and renamed stations', () => {
  const examples = [
    ['금정', 37.372221, 126.943429],
    ['산본', 37.358101, 126.933274],
    ['이수', 37.485196, 126.981605],
    ['어린이대공원', 37.548014, 127.074658],
    ['석남', 37.5062285, 126.6762813],
  ];
  for (const [name, latitude, longitude] of examples) {
    const nearest = findNearbyStations({ latitude, longitude }, catalog.points)[0];
    assert.equal(nearest.station.id, getStationByName(name).id, name);
    assert.equal(nearest.distanceMeters, 0);
  }
  for (const [id, currentName] of [['2730', '자양'], ['1723', '평택지제'], ['0409', '불암산']]) {
    assert.equal(catalog.points.find(point => point.sourceStationId === id)?.stationId,
      getStationByName(currentName).id, currentName);
  }
});

test('unsupported railways cannot leak into matching through shared station names', () => {
  assert.ok(!catalog.points.some(point => point.sourceLine.startsWith('인천') ||
    point.sourceLine === '공항철도1호선' || point.sourceLine === '수도권 광역급행철도'));
  assert.deepEqual(catalog.points.filter(point => point.sourceLine === '중앙선').map(point => point.sourceStationId), ['1015']);
  assert.equal(catalog.points.find(point => point.sourceStationId === '1015').stationId, getStationByName('회기').id);
  // The 경원선 infrastructure name also includes stations outside passenger Line 1.
  assert.ok(!catalog.points.some(point => point.sourceStationId === '1008'));
  const geumjeong = findNearbyStations({ latitude: 37.372221, longitude: 126.943429 }, catalog.points);
  assert.equal(geumjeong.filter(item => item.station.id === getStationByName('금정').id).length, 1);
});

test('the checked-in catalog is reproducible from its unchanged official CSV snapshot', () => {
  const bytes = fs.readFileSync(path.resolve(__dirname, '../../docs/data/seoul-station-master-2026-10-04.csv'));
  assert.deepEqual(buildCatalog(bytes, {
    downloadedAt: catalog.source.downloadedAt,
    sourceUpdatedAt: catalog.source.updatedAt,
  }), catalog);
  const invalid = Buffer.from(bytes.toString('binary').replace('37.372221', '99.372221'), 'binary');
  assert.throws(() => buildCatalog(invalid, { downloadedAt: '2026-10-04', sourceUpdatedAt: '2026-10-02' }), /Invalid coordinate/);
  assert.deepEqual(parseCsv('"id","name"\r\n"1","a,""b"""\r\n'), [['id', 'name'], ['1', 'a,"b"']]);
});
