import { readFileSync } from 'node:fs';
import { normalizeTagoBusResponse } from './tago-bus-model.mjs';

const invalid = () => { throw new Error('BUS_SNAPSHOT_INVALID_DATA'); };

// Each supplied page is a verified contiguous segment. Never bridge missing pages.
export function buildBusSnapshot(routeFixture, pageFixtures) {
  if (routeFixture.operation !== 'getRouteNoList' || !pageFixtures.length) invalid();
  const routes = normalizeTagoBusResponse('routes', routeFixture.raw, routeFixture.query);
  const result = [];
  for (const route of routes) {
    const pages = pageFixtures.filter(f => String(f.query?.cityCode) === route.cityCode && f.query?.routeId === route.routeId);
    if (!pages.length) continue;
    const directions = new Map(), seen = new Set(), positions = new Set();
    let totalStops;
    for (const fixture of pages) {
      if (fixture.operation !== 'getRouteAcctoThrghSttnList') invalid();
      const body = fixture.raw?.response?.body;
      const { pageNo, numOfRows, totalCount } = body ?? {};
      if (![pageNo, numOfRows, totalCount].every(n => Number.isSafeInteger(n) && n > 0) ||
          pageNo !== (fixture.query.pageNo ?? 1) || numOfRows !== fixture.query.numOfRows ||
          (totalStops !== undefined && totalStops !== totalCount)) invalid();
      totalStops = totalCount;
      const rows = normalizeTagoBusResponse('routeStops', fixture.raw, fixture.query);
      const offset = (pageNo - 1) * numOfRows;
      if (rows.length !== Math.min(numOfRows, totalCount - offset) || !rows.length) invalid();
      let previous, segment;
      for (const [index, row] of rows.entries()) {
        if (row.directionCode === undefined || (previous && row.stopSequence <= previous.stopSequence)) invalid();
        const key = JSON.stringify([row.directionCode, row.stopSequence]);
        if (seen.has(key) || positions.has(offset + index)) invalid();
        seen.add(key); positions.add(offset + index);
        if (!previous || previous.directionCode !== row.directionCode) {
          segment = { stops: [] };
          if (!directions.has(row.directionCode)) directions.set(row.directionCode, { direction: row.directionCode, segments: [] });
          directions.get(row.directionCode).segments.push(segment);
        }
        segment.stops.push({ stopId: row.stopId, sequence: row.stopSequence, name: row.name, latitude: row.latitude, longitude: row.longitude });
        previous = row;
      }
    }
    result.push({ providerId: route.providerId, cityCode: route.cityCode, routeId: route.routeId, routeNumber: route.routeNumber,
      totalStops, loadedStops: seen.size, partial: seen.size !== totalStops,
      directions: [...directions.values()].sort((a, b) => a.direction.localeCompare(b.direction)).map(d => ({ ...d,
        segments: d.segments.sort((a, b) => a.stops[0].sequence - b.stops[0].sequence),
      })),
    });
  }
  // A page for an unknown route must not silently disappear.
  if (pageFixtures.some(f => !result.some(r => r.cityCode === String(f.query?.cityCode) && r.routeId === f.query?.routeId))) invalid();
  return { version: 1, routes: result };
}

export function loadBusSnapshot() {
  const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/tago-bus-${name}.json`, import.meta.url), 'utf8'));
  return buildBusSnapshot(fixture('routes'), [fixture('routeStops'), fixture('routeStops-return')]);
}
