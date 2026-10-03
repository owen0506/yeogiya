import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';

// Node 24의 타입 제거로 기존 순수 TS 그래프를 읽습니다. 노선/ID를 복제하지 않습니다.
const frontendUrl = new URL('../frontend/src/', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(frontendUrl) && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });
let getRideGraph;
try { ({ getRideGraph } = createRequire(import.meta.url)('../frontend/src/features/journey/route-service.ts')); }
finally { hook.deregister(); }

const allowed = new Set(['강남|2호선|역삼', '역삼|2호선|선릉', '금정|4호선|범계', '용답|2호선|성수']);
const clockSeconds = value => {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(value)) return NaN;
  const [h, m, s] = value.split(':').map(Number);
  return h < 24 && m < 60 && s < 60 ? h * 3600 + m * 60 + s : NaN;
};

export function buildSegmentSnapshot(fixtures) {
  const graph = getRideGraph();
  const edges = new Set(graph.rides.map(e => JSON.stringify([e.from, e.to])));
  const records = new Map(), conflicts = new Set();
  function platform(station) {
    if (!station || typeof station.stnNm !== 'string') return;
    // 이번 적재 범위에서 실제 응답으로 확인한 지선명만 허용합니다.
    if (station.brlnNm != null && station.brlnNm !== '성수지선') return;
    const matches = graph.platforms.filter(p => p.name === station.stnNm && p.line === station.lineNm &&
      Boolean(p.branch) === (station.stnNm === '성수' && station.brlnNm === '성수지선'));
    return matches.length === 1 ? matches[0] : undefined;
  }
  for (const fixture of fixtures) {
    if (fixture?.source !== 'seoul-metro' || !Number.isFinite(Date.parse(fixture.searchedAt))) continue;
    for (const p of Array.isArray(fixture.body?.paths) ? fixture.body.paths : []) {
      if (!p || p.trsitYn !== 'N' || p.nonstopYn !== 'N' || p.etrnYn !== 'N' || !Number.isSafeInteger(p.reqHr) || p.reqHr <= 0) continue;
      if (p.wtngHr !== 0 || (clockSeconds(p.trainArvlTm) - clockSeconds(p.trainDptreTm) + 86400) % 86400 !== p.reqHr) continue;
      if (!allowed.has(`${p.dptreStn?.stnNm}|${p.dptreStn?.lineNm}|${p.arvlStn?.stnNm}`)) continue;
      const from = platform(p.dptreStn), to = platform(p.arvlStn);
      if (!from || !to) continue;
      const key = JSON.stringify([from.id, to.id]);
      if (!edges.has(key)) continue;
      if (records.has(key) && records.get(key).seconds !== p.reqHr) conflicts.add(key);
      records.set(key, { fromPlatformId: from.id, toPlatformId: to.id, seconds: p.reqHr });
    }
  }
  return { version: 1, source: 'seoul-metro-fixtures-2026-09-24', rides: [...records].filter(([key]) => !conflicts.has(key)).map(([, value]) => value) };
}

export function loadSegmentSnapshot() {
  const fixtures = ['gangnam-jamsil', 'geumjeong-isu', 'yongdap-konkuk'].flatMap(name => {
    try { return [JSON.parse(readFileSync(new URL(`../frontend/scripts/fixtures/${name}.json`, import.meta.url), 'utf8'))]; }
    catch { return []; }
  });
  return buildSegmentSnapshot(fixtures);
}
