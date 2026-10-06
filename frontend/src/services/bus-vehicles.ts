import type { JourneyStop, RideLeg, VehicleCandidate } from '../features/transit/journey-plan';

export type BusVehicleCandidate = VehicleCandidate & Readonly<{
  mode: 'BUS';
  vehicleNumber: string;
  currentStopId: string;
  currentStopSequence: number;
  relativeStopIndex: number;
  canBoardHere: boolean;
  canBeOnboard: boolean;
  etaSeconds: number | null;
  etaSource: 'POSITION_ESTIMATE' | null;
  routeId: string;
  cityCode: string;
  routeDirectionMatched: true;
  latitude: number | null;
  longitude: number | null;
  coveragePartial: boolean;
}>;

type BusVehicleResponse = {
  providerId: string;
  cityCode: string;
  routeId: string;
  fetchedAt: string;
  coverage: { partial: boolean };
  sequenceRange?: { from: number; to: number };
  vehicles: Array<{
    providerId: string;
    cityCode: string;
    routeId: string;
    vehicleNumber: string;
    stopId: string;
    stopSequence: number;
    latitude?: number;
    longitude?: number;
    direction?: string;
  }>;
};

function serviceDate(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
}

export function getBusCorridorStops(leg: RideLeg): readonly JourneyStop[] {
  const from = leg.from.serviceSequence;
  const board = leg.boardingSequence ?? from;
  const alight = leg.to.serviceSequence;
  if (leg.mode !== 'BUS' || !Number.isSafeInteger(from) || !Number.isSafeInteger(board) || !Number.isSafeInteger(alight)
    || (board as number) < 1 || (board as number) > (from as number)
    || (from as number) >= (alight as number) || !leg.stops.length) return [];
  const bySequence = new Map<number, JourneyStop>();
  for (const group of [leg.approachStops ?? [], leg.stops]) {
    for (let index = 0; index < group.length; index++) {
      const stop = group[index];
      const sequence = stop.serviceSequence;
      if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || !stop.providerStopId
        || (index > 0 && (sequence as number) <= (group[index - 1].serviceSequence as number))) return [];
      const previous = bySequence.get(sequence as number);
      if (previous && previous.providerStopId !== stop.providerStopId) return [];
      bySequence.set(sequence as number, stop);
    }
  }
  if (!bySequence.has(board as number) || leg.stops[0].serviceSequence !== from || leg.stops[0].providerStopId !== leg.from.providerStopId
    || leg.stops[leg.stops.length - 1].serviceSequence !== alight
    || leg.stops[leg.stops.length - 1].providerStopId !== leg.to.providerStopId) return [];
  // The approach corridor may include the ride itself. Merge an identical
  // provider occurrence once, while rejecting conflicting route orders.
  return [...bySequence.values()].filter(stop => (stop.serviceSequence as number) <= (alight as number))
    .sort((a, b) => (a.serviceSequence as number) - (b.serviceSequence as number));
}

export function parseBusVehicleCandidates(data: unknown, leg: RideLeg): BusVehicleCandidate[] {
  if (leg.mode !== 'BUS' || leg.providerId !== 'tago' || !leg.cityCode || !leg.routeId ||
      !Number.isSafeInteger(leg.from.serviceSequence) || !Number.isSafeInteger(leg.to.serviceSequence)) return [];
  if (!data || typeof data !== 'object') throw new Error('버스 위치 응답이 올바르지 않습니다.');
  const response = data as BusVehicleResponse;
  if (response.providerId !== leg.providerId || response.cityCode !== leg.cityCode ||
      response.routeId !== leg.routeId || !Number.isFinite(Date.parse(response.fetchedAt)) ||
      !response.coverage || typeof response.coverage.partial !== 'boolean' || !Array.isArray(response.vehicles) ||
      (response.sequenceRange !== undefined && (!response.sequenceRange ||
        !Number.isSafeInteger(response.sequenceRange.from) || !Number.isSafeInteger(response.sequenceRange.to)
        || response.sequenceRange.from < 1 || response.sequenceRange.to < response.sequenceRange.from))) {
    throw new Error('버스 위치 응답이 경로와 맞지 않습니다.');
  }
  const fromSequence = leg.from.serviceSequence as number;
  const boardSequence = leg.boardingSequence ?? fromSequence;
  const alightSequence = leg.to.serviceSequence as number;
  if (boardSequence >= alightSequence) return [];
  const corridor = getBusCorridorStops(leg);
  // Provider order identifies the occurrence of a stop on a circular route.
  // A nearby vehicle must belong to this exact, forward-going corridor.
  if (!corridor.length) return [];
  const boardingStop = corridor.find(stop => stop.serviceSequence === boardSequence);
  if (!boardingStop || (boardSequence === fromSequence && boardingStop.providerStopId !== leg.from.providerStopId) ||
      !corridor.some(stop => stop.serviceSequence === alightSequence && stop.providerStopId === leg.to.providerStopId)) return [];
  const date = serviceDate(response.fetchedAt);
  return response.vehicles.flatMap((vehicle): BusVehicleCandidate[] => {
    if (!vehicle || typeof vehicle !== 'object' || vehicle.providerId !== leg.providerId || vehicle.cityCode !== leg.cityCode ||
        vehicle.routeId !== leg.routeId || typeof vehicle.vehicleNumber !== 'string' || !vehicle.vehicleNumber.trim() ||
        typeof vehicle.stopId !== 'string' || !vehicle.stopId.trim() ||
        !Number.isSafeInteger(vehicle.stopSequence) || vehicle.stopSequence < 1) return [];
    const currentStop = corridor.find(stop => stop.serviceSequence === vehicle.stopSequence
      && stop.providerStopId === vehicle.stopId);
    if (!currentStop || (vehicle.direction && leg.direction && leg.direction !== 'SERVICE_SEQUENCE'
      && vehicle.direction !== leg.direction)) return [];
    const canBoardHere = vehicle.stopSequence <= boardSequence;
    const canBeOnboard = vehicle.stopSequence >= boardSequence && vehicle.stopSequence < alightSequence;
    if (!canBoardHere && !canBeOnboard) return [];
    const fromOffset = boardingStop.plannedOffsetSeconds;
    const currentOffset = currentStop.plannedOffsetSeconds;
    const etaSeconds = canBoardHere && fromOffset !== null && currentOffset !== null &&
      Number.isFinite(fromOffset) && Number.isFinite(currentOffset) && currentOffset <= fromOffset
      ? Math.ceil(fromOffset - currentOffset) : null;
    const validCoordinates = Number.isFinite(vehicle.latitude) && Number.isFinite(vehicle.longitude)
      && Math.abs(vehicle.latitude as number) <= 90 && Math.abs(vehicle.longitude as number) <= 180;
    return [{
      id: JSON.stringify(['tago', leg.cityCode, leg.routeId, date, vehicle.vehicleNumber]),
      legId: leg.id, mode: 'BUS', vehicleNumber: vehicle.vehicleNumber,
      currentStopId: vehicle.stopId, currentStopSequence: vehicle.stopSequence,
      relativeStopIndex: vehicle.stopSequence - fromSequence,
      canBoardHere, canBeOnboard, etaSeconds, etaSource: etaSeconds === null ? null : 'POSITION_ESTIMATE',
      routeId: leg.routeId!, cityCode: leg.cityCode!, routeDirectionMatched: true,
      latitude: validCoordinates ? vehicle.latitude! : null, longitude: validCoordinates ? vehicle.longitude! : null,
      coveragePartial: response.coverage.partial || Boolean(response.sequenceRange &&
        ((corridor[0].serviceSequence as number) < response.sequenceRange.from
          || alightSequence > response.sequenceRange.to)),
      run: { provider: 'TAGO_BUS', serviceDate: date, tripId: null, realtimeRunId: null, vehicleId: vehicle.vehicleNumber },
      observedAt: null, matchStatus: 'UNVERIFIED', selectable: true,
      evidence: [{ source: 'TAGO_POSITION', observedAt: null, fetchedAt: response.fetchedAt, freshness: 'UNKNOWN' }],
    }];
  }).sort((a, b) => Math.abs(a.relativeStopIndex) - Math.abs(b.relativeStopIndex));
}

export async function getBusVehicleCandidates(leg: RideLeg, signal?: AbortSignal): Promise<BusVehicleCandidate[]> {
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  if (!base || leg.mode !== 'BUS' || leg.providerId !== 'tago' || !leg.cityCode || !leg.routeId ||
      !Number.isSafeInteger(leg.from.serviceSequence) || !Number.isSafeInteger(leg.to.serviceSequence)) throw new Error('이 버스 구간의 실시간 위치 연결이 아직 준비되지 않았습니다.');
  const query = new URLSearchParams({ cityCode: leg.cityCode, routeId: leg.routeId,
    nearSequence: String(leg.boardingSequence ?? leg.from.serviceSequence), toSequence: String(leg.to.serviceSequence) });
  const response = await fetch(`${base.replace(/\/$/, '')}/bus-vehicles?${query}`, { signal });
  if (!response.ok) throw new Error(response.status === 503
    ? '버스 실시간 정보 연결이 설정되지 않았습니다.' : '버스 위치를 가져오지 못했습니다.');
  return parseBusVehicleCandidates(await response.json(), leg);
}
