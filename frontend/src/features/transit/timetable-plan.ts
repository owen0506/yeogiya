import { findEarliestArrival, type TimetableJourney, type TimetableNetwork, type TimetableQuery, type TimetableTrip } from './timetable-engine';
import type { JourneyLeg, JourneyPlan, JourneyStop, PlannedTiming } from './journey-plan';

// Display and provider identifiers stay outside the schedule search algorithm.
export type TimetableStopInfo = Readonly<{
  stopId: string;
  name: string;
  nodeId?: string;
  platformId?: string;
  providerStopId?: string;
}>;

export type TimetableServiceInfo = Readonly<{
  routeId: string;
  mode: 'SUBWAY' | 'BUS';
  line: string;
  providerRouteId?: string;
  providerId?: string;
  cityCode?: string;
  routeType?: string;
  direction?: string;
}>;

export type TimetablePlanCatalog = Readonly<{
  stops: readonly TimetableStopInfo[];
  services: readonly TimetableServiceInfo[];
  tripStopSequences?: readonly Readonly<{
    tripId: string;
    serviceDate: string;
    sequence: number;
    providerSequence: number;
  }>[];
}>;

export function createTimetableJourneyPlan(
  journey: TimetableJourney,
  network: TimetableNetwork,
  catalog: TimetablePlanCatalog,
): JourneyPlan {
  const originMs = Date.parse(journey.departureAt);
  const endMs = Date.parse(journey.arrivalAt);
  if (!Number.isFinite(originMs) || !Number.isFinite(endMs) || endMs < originMs ||
    journey.totalSeconds !== (endMs - originMs) / 1000) throw new Error('TIMETABLE_PLAN_INVALID_JOURNEY');
  const stopInfo = new Map(catalog.stops.map(stop => [stop.stopId, stop]));
  if (stopInfo.size !== catalog.stops.length) throw new Error('TIMETABLE_PLAN_DUPLICATE_STOP');
  const services = new Map(catalog.services.map(service => [`${service.mode}:${service.routeId}`, service]));
  if (services.size !== catalog.services.length) throw new Error('TIMETABLE_PLAN_DUPLICATE_SERVICE');
  const tripsByExternalMappingKey = new Map<string, TimetableTrip | null>();
  for (const trip of network.trips) {
    const key = JSON.stringify([trip.tripId, trip.serviceDate]);
    tripsByExternalMappingKey.set(key, tripsByExternalMappingKey.has(key) ? null : trip);
  }
  const providerSequences = new Map<string, number>();
  const mappedByTrip = new Map<string, Array<{ sequence: number; providerSequence: number }>>();
  if (catalog.tripStopSequences !== undefined && !Array.isArray(catalog.tripStopSequences)) {
    throw new Error('TIMETABLE_PLAN_INVALID_PROVIDER_SEQUENCE');
  }
  for (const mapping of catalog.tripStopSequences ?? []) {
    if (!mapping || typeof mapping.tripId !== 'string' || !mapping.tripId.trim() ||
      typeof mapping.serviceDate !== 'string' || !mapping.serviceDate.trim() ||
      !Number.isSafeInteger(mapping.sequence) || mapping.sequence < 0 ||
      !Number.isSafeInteger(mapping.providerSequence) || mapping.providerSequence < 1) {
      throw new Error('TIMETABLE_PLAN_INVALID_PROVIDER_SEQUENCE');
    }
    const tripKey = JSON.stringify([mapping.tripId, mapping.serviceDate]);
    const trip = tripsByExternalMappingKey.get(tripKey);
    if (!trip || !trip.stopTimes.some(time => time.sequence === mapping.sequence)) {
      throw new Error('TIMETABLE_PLAN_INVALID_PROVIDER_SEQUENCE');
    }
    const key = JSON.stringify([mapping.tripId, mapping.serviceDate, mapping.sequence]);
    if (providerSequences.has(key)) throw new Error('TIMETABLE_PLAN_DUPLICATE_PROVIDER_SEQUENCE');
    providerSequences.set(key, mapping.providerSequence);
    mappedByTrip.set(tripKey, [...(mappedByTrip.get(tripKey) ?? []), mapping]);
  }
  for (const mappings of mappedByTrip.values()) {
    mappings.sort((a, b) => a.sequence - b.sequence);
    for (let index = 1; index < mappings.length; index++) {
      if (mappings[index].providerSequence <= mappings[index - 1].providerSequence) {
        throw new Error('TIMETABLE_PLAN_INVALID_PROVIDER_SEQUENCE');
      }
    }
  }

  function stop(id: string, sequence: number, at: string, serviceSequence: number | null = null): JourneyStop {
    const info = stopInfo.get(id);
    if (!info?.name.trim()) throw new Error('TIMETABLE_PLAN_MISSING_STOP');
    return {
      id: info.nodeId ?? id, name: info.name, platformId: info.platformId ?? null,
      providerStopId: info.providerStopId ?? null, serviceSequence, sequence,
      plannedOffsetSeconds: (Date.parse(at) - originMs) / 1000,
    };
  }

  function timing(from: string, to: string): PlannedTiming {
    const a = Date.parse(from), b = Date.parse(to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < originMs || b < a || b > endMs) {
      throw new Error('TIMETABLE_PLAN_INVALID_TIME');
    }
    return {
      startOffsetSeconds: (a - originMs) / 1000,
      endOffsetSeconds: (b - originMs) / 1000,
      durationSeconds: (b - a) / 1000,
      departureAt: from, arrivalAt: to, source: 'TIMETABLE',
    };
  }

  const legs: JourneyLeg[] = [];
  let cursor = journey.departureAt;
  let previousStop: string | null = null;
  journey.segments.forEach((segment, index) => {
    if (previousStop !== null && previousStop !== segment.fromStopId) throw new Error('TIMETABLE_PLAN_DISCONNECTED');
    const wait = Date.parse(segment.departureAt) - Date.parse(cursor);
    if (wait < 0) throw new Error('TIMETABLE_PLAN_INVALID_TIME');
    if (wait > 0) {
      legs.push({ id: `wait:${JSON.stringify([segment.fromStopId, cursor, index])}`, kind: 'WAIT',
        from: stop(segment.fromStopId, 0, cursor), to: stop(segment.fromStopId, 0, segment.departureAt),
        planned: timing(cursor, segment.departureAt) });
    }
    const planned = timing(segment.departureAt, segment.arrivalAt);
    if (segment.kind === 'RIDE') {
      const trip = network.trips.find(trip => trip.tripId === segment.tripId && trip.routeId === segment.routeId &&
        trip.mode === segment.mode && trip.serviceDate === segment.serviceDate);
      const service = services.get(`${segment.mode}:${segment.routeId}`);
      if (!trip || !service?.line.trim()) throw new Error('TIMETABLE_PLAN_MISSING_SERVICE');
      const fromIndex = trip.stopTimes.findIndex(time => time.sequence === segment.boardSequence && time.stopId === segment.fromStopId);
      const toIndex = trip.stopTimes.findIndex(time => time.sequence === segment.alightSequence && time.stopId === segment.toStopId);
      if (fromIndex < 0 || toIndex <= fromIndex) throw new Error('TIMETABLE_PLAN_INVALID_SEQUENCE');
      const stops = trip.stopTimes.slice(fromIndex, toIndex + 1).map((time, sequence) =>
        stop(time.stopId, sequence, sequence === 0 ? segment.departureAt : time.arrivalAt,
          providerSequences.get(JSON.stringify([trip.tripId, trip.serviceDate, time.sequence])) ?? null));
      legs.push({ id: `ride:${JSON.stringify([trip.serviceDate, trip.mode, trip.routeId, trip.tripId, segment.boardSequence, segment.alightSequence, index])}`, kind: 'RIDE', mode: segment.mode,
        line: service.line, routeId: service.providerRouteId?.trim() || null, providerId: service.providerId ?? null,
        cityCode: service.cityCode ?? null, routeType: service.routeType ?? null, direction: service.direction ?? null,
        scheduledTrip: { tripId: trip.tripId, serviceDate: trip.serviceDate, routeId: trip.routeId },
        from: stops[0], to: stops[stops.length - 1], stops, planned });
    } else {
      legs.push({ id: `${segment.kind.toLowerCase()}:${JSON.stringify([segment.fromStopId, segment.toStopId, segment.departureAt, index])}`, kind: segment.kind,
        from: stop(segment.fromStopId, 0, segment.departureAt),
        to: stop(segment.toStopId, 1, segment.arrivalAt), planned });
    }
    cursor = segment.arrivalAt;
    previousStop = segment.toStopId;
  });
  if (Date.parse(cursor) !== endMs) throw new Error('TIMETABLE_PLAN_INVALID_JOURNEY');
  return { legs, totalSeconds: journey.totalSeconds, searchedAt: journey.departureAt,
    source: 'TIMETABLE', departureAt: journey.departureAt, arrivalAt: journey.arrivalAt };
}

export function findTimetableJourneyPlan(
  network: TimetableNetwork,
  query: TimetableQuery,
  catalog: TimetablePlanCatalog,
): JourneyPlan | null {
  const journey = findEarliestArrival(network, query);
  return journey ? createTimetableJourneyPlan(journey, network, catalog) : null;
}
