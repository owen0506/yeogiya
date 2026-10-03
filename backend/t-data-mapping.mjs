import { parseTDataRouteStops, parseTDataSectionTimes } from './t-data-model.mjs';

const text = x => typeof x === 'string' && x.trim().length > 0;
const fields = ['providerId', 'cityCode', 'routeId', 'direction', 'fromStopId', 'fromSequence', 'toStopId', 'toSequence'];
const key = x => JSON.stringify(fields.map(f => x[f]));

function rideKeys(snapshot) {
  const counts = new Map();
  for (const r of snapshot.routes) for (const d of r.directions) for (const segment of d.segments) {
    for (let i = 1; i < segment.stops.length; i++) {
      const a = segment.stops[i - 1], b = segment.stops[i];
      if (!Number.isSafeInteger(a.sequence) || !Number.isSafeInteger(b.sequence) || a.sequence >= b.sequence) continue;
      const k = key({ ...r, direction: d.direction, fromStopId: a.stopId, fromSequence: a.sequence, toStopId: b.stopId, toSequence: b.sequence });
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * crosswalk is a separately reviewed mapping, never generated from equal-looking IDs.
 * Each entry has source {routeId,fromStopId,toStopId,fromSequence,toSequence},
 * target (the eight internal identity fields), and evidence {route,fromStop,toStop,direction}.
 * Evidence contains audit references establishing identity, not guessed names/prefixes.
 * semantics requires separately verified unit/statistic/timeZone and an evidence reference.
 * No production crosswalk or semantics is supplied until those facts are established.
 */
export function buildTDataBusRideSnapshot({ sectionRaw, masterRaw, topology, crosswalk = [], semantics }) {
  const sections = parseTDataSectionTimes(sectionRaw), master = parseTDataRouteStops(masterRaw);
  const rides = rideKeys(topology), records = [], rejected = [];
  const verified = semantics && ['seconds', 'minutes'].includes(semantics.unit) &&
    text(semantics.statistic) && text(semantics.evidence) && text(semantics.timeZone) && semantics.measure === 'directed-adjacent-travel-time';
  let validZone = false;
  try { if (verified) { new Intl.DateTimeFormat('en', { timeZone: semantics.timeZone }); validZone = true; } } catch { /* reject */ }
  for (const [index, row] of sections.entries()) {
    const reasons = [];
    if (!verified || !validZone) reasons.push('unverified-time-semantics');
    if (row.toSequence !== row.fromSequence + 1) reasons.push('invalid-source-sequence');
    const at = sequence => master.filter(m => m.externalRouteId === row.externalRouteId && m.sequence === sequence);
    const from = at(row.fromSequence), to = at(row.toSequence);
    if (from.length !== 1 || to.length !== 1 || from[0].externalStopId !== row.fromExternalStopId || to[0].externalStopId !== row.toExternalStopId) reasons.push('master-segment-unconfirmed');
    const matches = crosswalk.filter(m => m.source?.routeId === row.externalRouteId &&
      m.source.fromStopId === row.fromExternalStopId && m.source.toStopId === row.toExternalStopId &&
      m.source.fromSequence === row.fromSequence && m.source.toSequence === row.toSequence);
    if (matches.length !== 1) reasons.push(matches.length ? 'ambiguous-mapping' : 'missing-mapping');
    const mapping = matches.length === 1 ? matches[0] : undefined;
    if (mapping && (!['route', 'fromStop', 'toStop', 'direction'].every(f => text(mapping.evidence?.[f])) ||
      !mapping.target || !fields.filter(f => !f.endsWith('Sequence')).every(f => text(mapping.target[f])) ||
      rides.get(key(mapping.target)) !== 1)) reasons.push('unverified-target-ride');
    if (row.value === undefined && !row.hours.length) reasons.push('no-positive-time');
    if (reasons.length) { rejected.push({ index, reasons }); continue; }
    const identity = Object.fromEntries(fields.map(f => [f, mapping.target[f]]));
    const base = { ...identity, source: 'seoul-t-data', statistic: semantics.statistic,
      timeBasis: row.referenceDate, timeZone: semantics.timeZone };
    const seconds = value => value * (semantics.unit === 'minutes' ? 60 : 1);
    // Retain daily and hourly observations separately; never average hourly values.
    for (const sample of [{ value: row.value }, ...row.hours]) {
      const n = seconds(sample.value);
      if (!Number.isFinite(n) || n <= 0) continue;
      records.push({ ...base, seconds: n, ...(sample.hour === undefined ? {} : { timeBucket: { startHour: sample.hour, endHour: sample.hour + 1 } }) });
    }
  }
  return { snapshot: { version: 1, records }, rejected };
}
