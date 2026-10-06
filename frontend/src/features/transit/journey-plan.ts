import type { JourneyRoute, RouteStep } from '../journey/route-service';

// A route is a proposal. A selected run belongs to one ride leg of that route.
// Sequence is local to the leg, so repeated stops on circular services stay distinct.
export type JourneyStop = Readonly<{
  id: string;
  name: string;
  platformId: string | null;
  providerStopId: string | null;
  // The provider's route stop order; it can differ from Trip StopTime.sequence.
  serviceSequence: number | null;
  sequence: number;
  plannedOffsetSeconds: number | null;
}>;

export type PlannedTiming = Readonly<{
  startOffsetSeconds: number | null;
  endOffsetSeconds: number | null;
  durationSeconds: number | null;
  departureAt: string | null;
  arrivalAt: string | null;
  source: 'OFFICIAL_TIMETABLE' | 'TIMETABLE' | 'ESTIMATE' | 'UNKNOWN';
}>;

export type RideLeg = Readonly<{
  id: string;
  kind: 'RIDE';
  mode: 'SUBWAY' | 'BUS';
  line: string;
  // Provider route ID for live lookups. The scheduled route belongs to scheduledTrip.
  routeId: string | null;
  providerId: string | null;
  cityCode: string | null;
  routeType: string | null;
  direction: string | null;
  scheduledTrip?: Readonly<{ tripId: string; serviceDate: string; routeId?: string }>;
  from: JourneyStop;
  to: JourneyStop;
  stops: readonly JourneyStop[];
  // Ordered provider occurrences before boarding, through the alighting stop.
  // Negative offsets are estimates relative to the boarding stop, not Trip times.
  approachStops?: readonly JourneyStop[];
  // Retains the selected ride's boarding occurrence when an onboard replan starts later.
  boardingSequence?: number;
  planned: PlannedTiming;
}>;

export type TransferLeg = Readonly<{
  id: string;
  kind: 'TRANSFER';
  from: JourneyStop;
  to: JourneyStop;
  planned: PlannedTiming;
}>;

export type WalkLeg = Readonly<{
  id: string;
  kind: 'WALK';
  from: JourneyStop;
  to: JourneyStop;
  planned: PlannedTiming;
}>;

export type WaitLeg = Readonly<{
  id: string;
  kind: 'WAIT';
  from: JourneyStop;
  to: JourneyStop;
  planned: PlannedTiming;
}>;

export type JourneyLeg = RideLeg | TransferLeg | WalkLeg | WaitLeg;
export type JourneyPlan = Readonly<{
  legs: readonly JourneyLeg[];
  totalSeconds: number;
  searchedAt: string | null;
  source: 'OFFICIAL_TIMETABLE' | 'TIMETABLE' | 'ESTIMATE';
  departureAt?: string | null;
  arrivalAt?: string | null;
  notes?: readonly string[];
  includesAccessAndWaiting?: boolean;
  transferCount?: number;
}>;

// A realtime run reference is not a timetable Trip or a physical vehicle ID.
export type RunIdentity = Readonly<{
  provider: 'SEOUL_SUBWAY' | 'TAGO_BUS';
  serviceDate: string | null;
  tripId: string | null;
  realtimeRunId: string | null;
  vehicleId: string | null;
}>;

export type VehicleEvidence = Readonly<{
  source: 'SEOUL_ARRIVAL' | 'SEOUL_POSITION' | 'TAGO_ARRIVAL' | 'TAGO_POSITION';
  observedAt: string | null;
  fetchedAt: string;
  freshness: 'LIVE' | 'STALE' | 'UNKNOWN';
}>;

export type VehicleCandidate = Readonly<{
  id: string;
  legId: string;
  mode: 'SUBWAY' | 'BUS';
  run: RunIdentity;
  observedAt: string | null;
  matchStatus: 'UNVERIFIED' | 'TIMETABLE_MATCHED';
  selectable: boolean;
  evidence: readonly VehicleEvidence[];
}>;

export type SelectedRide = Readonly<{
  legId: string;
  status: 'PLANNED' | 'ONBOARD';
  candidateId: string;
  run: RunIdentity;
  selectedAt: string;
  observedAt: string | null;
  matchStatus: VehicleCandidate['matchStatus'];
}>;

function stop(step: RouteStep, sequence: number): JourneyStop {
  return {
    id: step.station.stationId,
    name: step.station.name,
    platformId: step.station.id,
    providerStopId: null,
    serviceSequence: null,
    sequence,
    plannedOffsetSeconds: Number.isFinite(step.secondsFromStart) ? step.secondsFromStart : null,
  };
}

function timing(start: RouteStep, end: RouteStep, route: JourneyRoute): PlannedTiming {
  const a = start.secondsFromStart, b = end.secondsFromStart;
  const valid = Number.isFinite(a) && Number.isFinite(b) && b >= a;
  const origin = route.official ? Date.parse(route.official.departureAt) : NaN;
  return {
    startOffsetSeconds: valid ? a : null,
    endOffsetSeconds: valid ? b : null,
    durationSeconds: valid ? b - a : null,
    departureAt: valid && Number.isFinite(origin) ? new Date(origin + a * 1000).toISOString() : null,
    arrivalAt: valid && Number.isFinite(origin) ? new Date(origin + b * 1000).toISOString() : null,
    source: valid ? route.official ? 'OFFICIAL_TIMETABLE' : 'ESTIMATE' : 'UNKNOWN',
  };
}

export function createJourneyPlan(route: JourneyRoute): JourneyPlan {
  const legs: JourneyLeg[] = [];
  const steps = route.steps;
  let rideStart = -1;

  function finishRide(end: number) {
    if (rideStart < 0 || end <= rideStart) return;
    const rideSteps = steps.slice(rideStart, end + 1);
    const stops = rideSteps.map((step, sequence) => stop(step, sequence));
    legs.push({
      id: `ride:${JSON.stringify([steps[rideStart].station.id, steps[end].station.id, rideStart, end])}`,
      kind: 'RIDE', mode: 'SUBWAY', line: steps[rideStart].station.line,
      routeId: null, providerId: null, cityCode: null, routeType: null, direction: null,
      from: stops[0], to: stops[stops.length - 1], stops,
      planned: timing(steps[rideStart], steps[end], route),
    });
  }

  for (let index = 1; index < steps.length; index++) {
    if (steps[index].transfer) {
      finishRide(index - 1);
      rideStart = -1;
      legs.push({
        id: `transfer:${JSON.stringify([steps[index - 1].station.id, steps[index].station.id, index])}`, kind: 'TRANSFER',
        from: stop(steps[index - 1], 0), to: stop(steps[index], 1),
        planned: timing(steps[index - 1], steps[index], route),
      });
    } else {
      // A new service without an explicit transfer is an invalid route plan.
      if (steps[index].station.line !== steps[index - 1].station.line) throw new Error('경로의 환승 정보가 누락되었습니다.');
      if (rideStart < 0) rideStart = index - 1;
    }
  }
  finishRide(steps.length - 1);
  return {
    legs, totalSeconds: route.seconds,
    searchedAt: route.official?.searchedAt ?? null,
    source: route.official ? 'OFFICIAL_TIMETABLE' : 'ESTIMATE',
  };
}

export function selectRideVehicle(
  leg: RideLeg,
  candidate: VehicleCandidate,
  status: 'PLANNED' | 'ONBOARD',
  selectedAt = new Date().toISOString(),
): SelectedRide {
  if (candidate.legId !== leg.id || candidate.mode !== leg.mode || !candidate.selectable) {
    throw new Error('이 구간에서 선택할 수 없는 차량입니다.');
  }
  return {
    legId: leg.id, status, candidateId: candidate.id, run: candidate.run,
    selectedAt, observedAt: candidate.observedAt, matchStatus: candidate.matchStatus,
  };
}
