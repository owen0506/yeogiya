const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

// The app's station IDs remain the single source of truth for matching.
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(compiled.outputText, filename);
};

const { stationPlatforms, stations } = require('../src/features/stations/stations.ts');
const { interchangeName, stationAliases } = require('../src/features/stations/network.ts');

// The source uses infrastructure/operator names as well as passenger line names.
// Membership in stationPlatforms must also match; e.g. 경원선 이촌 is not Line 1.
const sourceLines = {
  '1호선': '1호선', '경원선': '1호선', '경부선': '1호선', '경인선': '1호선', '장항선': '1호선',
  '2호선': '2호선', '3호선': '3호선', '일산선': '3호선',
  '4호선': '4호선', '과천선': '4호선', '안산선': '4호선', '진접선': '4호선',
  '5호선': '5호선', '6호선': '6호선', '7호선': '7호선', '7호선(인천)': '7호선',
  '8호선': '8호선', '별내선': '8호선', '9호선': '9호선', '9호선(연장)': '9호선',
  '신분당선': '신분당선', '신분당선(연장)': '신분당선', '신분당선(연장2)': '신분당선',
};

function normalizedStationName(name) {
  const base = name.normalize('NFC').replace(/\([^)]*\)/g, '').replace(/\s/g, '');
  return interchangeName(stationAliases[base] ?? (base === '지제' ? '평택지제' : base));
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value); value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some(cell => cell !== '')) rows.push(row);
      row = []; value = '';
    } else value += character;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field.');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function buildCatalog(bytes, { downloadedAt, sourceUpdatedAt }) {
  for (const value of [downloadedAt, sourceUpdatedAt]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || !Number.isFinite(Date.parse(value))) {
      throw new Error('Provide downloadedAt and sourceUpdatedAt as YYYY-MM-DD.');
    }
  }
  const rows = parseCsv(new TextDecoder('euc-kr', { fatal: true }).decode(bytes));
  const expectedHeader = ['역사_ID', '역사명', '호선', '위도', '경도'];
  if (JSON.stringify(rows.shift()) !== JSON.stringify(expectedHeader)) throw new Error('Unexpected station CSV header.');
  const points = [], unmatchedSourceRows = [];
  let unsupportedSourceRows = 0;
  for (const row of rows) {
    if (row.length !== expectedHeader.length) throw new Error('Unexpected CSV column count.');
    const [sourceStationId, sourceStationName, sourceLine, rawLatitude, rawLongitude] = row;
    // OA-21232 lists the shared Hoegi station once, under 중앙선. This exact record
    // can locate the physical station used by Line 1; do not admit all 중앙선 rows.
    const isHoegi = sourceStationId === '1015' && sourceStationName === '회기' && sourceLine === '중앙선';
    const line = isHoegi ? '1호선' : sourceLines[sourceLine];
    if (!line) { unsupportedSourceRows += 1; continue; }
    const matches = stationPlatforms.filter(platform => platform.line === line &&
      normalizedStationName(platform.name) === normalizedStationName(sourceStationName));
    if (matches.length > 1) throw new Error(`Ambiguous station: ${sourceStationId}`);
    const platform = matches[0];
    if (!platform) { unmatchedSourceRows.push({ sourceStationId, sourceStationName, sourceLine }); continue; }
    const latitude = Number(rawLatitude), longitude = Number(rawLongitude);
    // Covers the supported Seoul metropolitan network, including Yeoncheon/Sinchang.
    if (!rawLatitude.trim() || !rawLongitude.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < 36 || latitude > 39 || longitude < 125 || longitude > 129) {
      throw new Error(`Invalid coordinate for station ${sourceStationId}`);
    }
    points.push({ stationId: platform.stationId, latitude, longitude, sourceStationId, sourceStationName, sourceLine, line });
  }
  points.sort((a, b) => a.stationId.localeCompare(b.stationId, 'ko') || Number(a.sourceStationId) - Number(b.sourceStationId));
  const coveredIds = new Set(points.map(point => point.stationId));
  return {
    source: {
      title: '서울시 역사마스터 정보',
      publisher: '서울특별시',
      url: 'https://data.seoul.go.kr/dataList/OA-21232/S/1/datasetView.do',
      datasetId: 'OA-21232',
      license: '공공누리 제1유형: 출처표시',
      licenseUrl: 'https://www.kogl.or.kr/info/licenseType1.do',
      modified: '앱 지원 노선·역명 연결, 부역명 제거, 개정 역명 반영, 좌표 숫자 변환 및 필터링. 원본 좌표값 유지.',
      updatedAt: sourceUpdatedAt,
      downloadedAt,
      encoding: 'EUC-KR',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      rowCount: rows.length,
    },
    coverage: {
      supportedStationCount: stations.length,
      coveredStationCount: coveredIds.size,
      coordinateCount: points.length,
      unsupportedSourceRowCount: unsupportedSourceRows,
      unmatchedSourceRows,
    },
    points,
    missingStationIds: stations.filter(station => !coveredIds.has(station.id)).map(station => station.id).sort(),
  };
}

if (require.main === module) {
  const [, , inputPath, downloadedAt, sourceUpdatedAt] = process.argv;
  if (!inputPath || !downloadedAt || !sourceUpdatedAt) {
    throw new Error('Usage: node scripts/build-station-locations.cjs <EUC-KR CSV> <downloaded YYYY-MM-DD> <source updated YYYY-MM-DD>');
  }
  const catalog = buildCatalog(fs.readFileSync(inputPath), { downloadedAt, sourceUpdatedAt });
  if (catalog.missingStationIds.length) {
    throw new Error(`Catalog is incomplete; review missing stations before replacing it: ${catalog.missingStationIds.join(', ')}`);
  }
  const output = path.resolve(__dirname, '../src/features/stations/station-locations.json');
  fs.writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${catalog.points.length} coordinates for ${catalog.coverage.coveredStationCount}/${catalog.coverage.supportedStationCount} supported stations.`);
}

module.exports = { buildCatalog, parseCsv };
