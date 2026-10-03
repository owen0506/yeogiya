// Exact, date-specific timetable routing. It does not generate trips from
// average edge times; callers must supply actual trips and explicit footpaths.
export type ScheduledMode = 'SUBWAY' | 'BUS';

export type StopTime = Readonly<{
  stopId: string;
  sequence: number;
  arrivalAt: string;
  departureAt: string;
}>;

export type TimetableTrip = Readonly<{
  tripId: string;
  routeId: string;
  mode: ScheduledMode;
  serviceDate: string;
  stopTimes: readonly StopTime[];
}>;

export type Footpath = Readonly<{
  fromStopId: string;
  toStopId: string;
  seconds: number;
  kind: 'WALK' | 'TRANSFER';
}>;

export type TimetableNetwork = Readonly<{
  trips: readonly TimetableTrip[];
  footpaths: readonly Footpath[];
}>;

export type TimetableQuery = Readonly<{
  fromStopId: string;
  toStopId: string;
  departureAt: string;
  minBoardingSeconds?: number;
}>;

export type ScheduledRide = Readonly<{
  kind: 'RIDE';
  mode: ScheduledMode;
  routeId: string;
  tripId: string;
  serviceDate: string;
  fromStopId: string;
  toStopId: string;
  boardSequence: number;
  alightSequence: number;
  departureAt: string;
  arrivalAt: string;
}>;

export type ScheduledFootpath = Readonly<{
  kind: 'WALK' | 'TRANSFER';
  fromStopId: string;
  toStopId: string;
  departureAt: string;
  arrivalAt: string;
}>;

export type TimetableSegment = ScheduledRide | ScheduledFootpath;
export type TimetableJourney = Readonly<{
  departureAt: string;
  arrivalAt: string;
  totalSeconds: number;
  segments: readonly TimetableSegment[];
}>;

type Arc = Readonly<{
  trip: TimetableTrip;
  tripKey: string;
  fromIndex: number;
  from: StopTime;
  to: StopTime;
  departureMs: number;
  arrivalMs: number;
}>;

type PathState = Readonly<{
  stopId: string;
  arrivalMs: number;
  previous: PathState | null;
  segment: TimetableSegment | null;
}>;

function validId(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactTime(value: string): number {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error('TIMETABLE_INVALID_TIME');
  const [, y, m, d, h, minute, s, ms = '0', zone, sign, offsetH, offsetM] = match;
  const [year, month, day, hour, minutes, seconds] = [y, m, d, h, minute, s].map(Number);
  const offsetHours = Number(offsetH ?? 0), offsetMinutes = Number(offsetM ?? 0);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > maxDay ||
    hour > 23 || minutes > 59 || seconds > 59 || offsetHours > 14 || offsetMinutes > 59 ||
    (offsetHours === 14 && offsetMinutes > 0)) throw new Error('TIMETABLE_INVALID_TIME');
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (offsetHours * 60 + offsetMinutes);
  return Date.UTC(year, month - 1, day, hour, minutes, seconds, Number(ms.padEnd(3, '0'))) - offset * 60_000;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function validServiceDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { exactTime(`${value}T00:00:00+09:00`); return true; }
  catch { return false; }
}

function checkedNetwork(network: TimetableNetwork): { arcs: Arc[]; footpaths: Map<string, Footpath[]> } {
  if (!network || !Array.isArray(network.trips) || !Array.isArray(network.footpaths)) throw new Error('TIMETABLE_INVALID_NETWORK');
  const arcs: Arc[] = [];
  const seenTrips = new Set<string>();
  for (const trip of network.trips) {
    if (!trip || !validId(trip.tripId) || !validId(trip.routeId) || !validServiceDate(trip.serviceDate) ||
      !['SUBWAY', 'BUS'].includes(trip.mode) || !Array.isArray(trip.stopTimes) || trip.stopTimes.length < 2) throw new Error('TIMETABLE_INVALID_TRIP');
    const tripKey = `${trip.serviceDate}\u0000${trip.mode}\u0000${trip.tripId}`;
    if (seenTrips.has(tripKey)) throw new Error('TIMETABLE_DUPLICATE_TRIP');
    seenTrips.add(tripKey);
    let previous: StopTime | null = null;
    let previousDeparture = -Infinity;
    for (let index = 0; index < trip.stopTimes.length; index++) {
      const current = trip.stopTimes[index];
      if (!current) throw new Error('TIMETABLE_INVALID_STOP_TIME');
      const arrivalMs = exactTime(current.arrivalAt);
      const departureMs = exactTime(current.departureAt);
      if (!validId(current.stopId) || !Number.isInteger(current.sequence) || current.sequence < 0 ||
        arrivalMs > departureMs || arrivalMs < previousDeparture ||
        (previous && current.sequence <= previous.sequence)) throw new Error('TIMETABLE_INVALID_STOP_TIME');
      if (previous) {
        arcs.push({
          trip, tripKey, fromIndex: index - 1, from: previous, to: current,
          departureMs: previousDeparture, arrivalMs,
        });
      }
      previous = current;
      previousDeparture = departureMs;
    }
  }
  arcs.sort((a, b) => a.departureMs - b.departureMs || a.arrivalMs - b.arrivalMs || a.fromIndex - b.fromIndex);
  const footpaths = new Map<string, Footpath[]>();
  for (const path of network.footpaths) {
    if (!validId(path.fromStopId) || !validId(path.toStopId) ||
      !Number.isFinite(path.seconds) || path.seconds < 0 || !Number.isInteger(path.seconds) ||
      !['WALK', 'TRANSFER'].includes(path.kind)) throw new Error('TIMETABLE_INVALID_FOOTPATH');
    footpaths.set(path.fromStopId, [...(footpaths.get(path.fromStopId) ?? []), path]);
  }
  return { arcs, footpaths };
}

function flatten(path: PathState): TimetableSegment[] {
  const segments: TimetableSegment[] = [];
  let current: PathState | null = path;
  while (current?.previous) {
    if (current.segment) segments.unshift(current.segment);
    current = current.previous;
  }
  const merged: TimetableSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === 'RIDE' && segment.kind === 'RIDE' &&
      previous.tripId === segment.tripId && previous.serviceDate === segment.serviceDate &&
      previous.mode === segment.mode && previous.alightSequence === segment.boardSequence &&
      previous.toStopId === segment.fromStopId) {
      merged[merged.length - 1] = { ...previous, toStopId: segment.toStopId,
        alightSequence: segment.alightSequence, arrivalAt: segment.arrivalAt };
    } else merged.push(segment);
  }
  return merged;
}

export function findEarliestArrival(network: TimetableNetwork, query: TimetableQuery): TimetableJourney | null {
  if (!validId(query.fromStopId) || !validId(query.toStopId)) throw new Error('TIMETABLE_INVALID_QUERY');
  const startMs = exactTime(query.departureAt);
  const boardingMs = (query.minBoardingSeconds ?? 0) * 1000;
  if (!Number.isInteger(query.minBoardingSeconds ?? 0) || boardingMs < 0) throw new Error('TIMETABLE_INVALID_QUERY');
  const { arcs, footpaths } = checkedNetwork(network);
  const labels = new Map<string, PathState>();
  const tripStates = new Map<string, { nextIndex: number; path: PathState }>();

  function improve(candidate: PathState) {
    const old = labels.get(candidate.stopId);
    if (old && old.arrivalMs <= candidate.arrivalMs) return;
    labels.set(candidate.stopId, candidate);
    // Explicit walking/transfer connectors are closed after every improvement.
    // Strict improvement makes zero-time cycles terminate.
    const queue: PathState[] = [candidate];
    while (queue.length) {
      const current = queue.shift()!;
      if (labels.get(current.stopId) !== current) continue;
      for (const footpath of footpaths.get(current.stopId) ?? []) {
        const arrivalMs = current.arrivalMs + footpath.seconds * 1000;
        const existing = labels.get(footpath.toStopId);
        if (existing && existing.arrivalMs <= arrivalMs) continue;
        const next: PathState = {
          stopId: footpath.toStopId, arrivalMs, previous: current,
          segment: { kind: footpath.kind, fromStopId: footpath.fromStopId, toStopId: footpath.toStopId,
            departureAt: iso(current.arrivalMs), arrivalAt: iso(arrivalMs) },
        };
        labels.set(next.stopId, next);
        queue.push(next);
      }
    }
  }

  improve({ stopId: query.fromStopId, arrivalMs: startMs, previous: null, segment: null });
  for (const arc of arcs) {
    if (arc.departureMs < startMs) continue;
    const onboard = tripStates.get(arc.tripKey);
    const continuation = onboard?.nextIndex === arc.fromIndex && onboard.path.stopId === arc.from.stopId &&
      onboard.path.arrivalMs <= arc.departureMs;
    const waiting = labels.get(arc.from.stopId);
    const predecessor = continuation ? onboard!.path : waiting && waiting.arrivalMs + boardingMs <= arc.departureMs ? waiting : null;
    if (!predecessor) continue;
    const next: PathState = {
      stopId: arc.to.stopId, arrivalMs: arc.arrivalMs, previous: predecessor,
      segment: {
        kind: 'RIDE', mode: arc.trip.mode, routeId: arc.trip.routeId,
        tripId: arc.trip.tripId, serviceDate: arc.trip.serviceDate,
        fromStopId: arc.from.stopId, toStopId: arc.to.stopId,
        boardSequence: arc.from.sequence, alightSequence: arc.to.sequence,
        departureAt: iso(arc.departureMs), arrivalAt: iso(arc.arrivalMs),
      },
    };
    tripStates.set(arc.tripKey, { nextIndex: arc.fromIndex + 1, path: next });
    improve(next);
  }
  const destination = labels.get(query.toStopId);
  if (!destination) return null;
  return {
    departureAt: iso(startMs), arrivalAt: iso(destination.arrivalMs),
    totalSeconds: (destination.arrivalMs - startMs) / 1000,
    segments: flatten(destination),
  };
}
