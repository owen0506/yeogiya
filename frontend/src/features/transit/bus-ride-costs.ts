export type BusRideIdentity = Readonly<{
  providerId: string; cityCode: string; routeId: string; direction: string;
  fromStopId: string; fromSequence: number; toStopId: string; toSequence: number;
}>;
export type BusRideTime = BusRideIdentity & Readonly<{
  seconds: number; source: string; statistic: string;
  /** Exact observation date (YYYY-MM-DD), not an inferred recurring weekday profile. */
  timeBasis: string; timeZone: string; sampleCount?: number;
  timeBucket?: Readonly<{ startHour: number; endHour: number }>;
}>;
export type BusRideTimeSnapshot = Readonly<{ version: 1; records: readonly BusRideTime[] }>;
export type BusRideCostResult = Readonly<{ status: 'missing' }> | Readonly<{ status: 'available'; cost: BusRideTime }>;
export interface BusRideCostProvider {
  rideTime(query: BusRideIdentity & { requestedTime?: Date }): BusRideCostResult;
}
const fields = ['providerId', 'cityCode', 'routeId', 'direction', 'fromStopId', 'fromSequence', 'toStopId', 'toSequence'] as const;
const key = (x: BusRideIdentity) => JSON.stringify(fields.map(f => x[f]));
const text = (x: unknown) => typeof x === 'string' && x.trim().length > 0;
const invalid = (): never => { throw new Error('BUS_RIDE_TIME_INVALID_SNAPSHOT'); };
const missing = Object.freeze({ status: 'missing' } as const);

export function createBusRideCostProvider(snapshot: BusRideTimeSnapshot): BusRideCostProvider {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) invalid();
  const index = new Map<string, BusRideTime[]>();
  for (const row of snapshot.records) {
    if (!row || ![row.providerId, row.cityCode, row.routeId, row.direction, row.fromStopId, row.toStopId,
      row.source, row.statistic, row.timeZone].every(text) || !Number.isSafeInteger(row.fromSequence) ||
      !Number.isSafeInteger(row.toSequence) || row.fromSequence < 1 || row.toSequence <= row.fromSequence ||
      typeof row.seconds !== 'number' || !Number.isFinite(row.seconds) || row.seconds <= 0 ||
      (row.sampleCount !== undefined && (!Number.isSafeInteger(row.sampleCount) || row.sampleCount < 1))) invalid();
    if (typeof row.timeBasis !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.timeBasis)) invalid();
    const date = new Date(row.timeBasis);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== row.timeBasis) invalid();
    try { new Intl.DateTimeFormat('en', { timeZone: row.timeZone }); } catch { invalid(); }
    const b = row.timeBucket;
    if (b && (!Number.isInteger(b.startHour) || !Number.isInteger(b.endHour) || b.startHour < 0 || b.endHour > 24 || b.endHour <= b.startHour)) invalid();
    const record = Object.freeze({ ...row, ...(b ? { timeBucket: Object.freeze({ ...b }) } : {}) });
    const k = key(record);
    index.set(k, [...(index.get(k) ?? []), record]);
  }
  return Object.freeze({ rideTime(query: BusRideIdentity & { requestedTime?: Date }): BusRideCostResult {
    let candidates = index.get(key(query)) ?? [];
    const time = query.requestedTime;
    if (time !== undefined) {
      if (!(time instanceof Date) || !Number.isFinite(time.valueOf())) return missing;
      const matches = candidates.filter(row => {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: row.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(time);
        const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
        if (`${p.year}-${p.month}-${p.day}` !== row.timeBasis) return false;
        return !row.timeBucket || (Number(p.hour) >= row.timeBucket.startHour && Number(p.hour) < row.timeBucket.endHour);
      });
      const hourly = matches.filter(row => row.timeBucket);
      // A missing hourly observation does not silently fall back to a daily mean.
      const hasHourly = candidates.some(row => row.timeBucket && matches.some(m => m.timeBasis === row.timeBasis && m.timeZone === row.timeZone));
      candidates = hourly.length || hasHourly ? hourly : matches;
    } else {
      candidates = candidates.filter(row => !row.timeBucket);
    }
    // Conflicting sources/dates/overlapping buckets require an explicit policy.
    return candidates.length === 1 ? { status: 'available', cost: candidates[0] } : missing;
  } });
}
