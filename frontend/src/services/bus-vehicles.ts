import type { RideLeg, VehicleCandidate } from '../features/transit/journey-plan';

export type BusVehicleCandidate = VehicleCandidate & Readonly<{
  mode: 'BUS';
  vehicleNumber: string;
  currentStopId: string;
  currentStopSequence: number;
  relativeStopIndex: number;
  canBoardHere: boolean;
  canBeOnboard: boolean;
  etaSeconds: null;
  coveragePartial: boolean;
}>;

type BusVehicleResponse = {
  providerId: string;
  cityCode: string;
  routeId: string;
  fetchedAt: string;
  coverage: { partial: boolean };
  vehicles: Array<{
    providerId: string;
    cityCode: string;
    routeId: string;
    vehicleNumber: string;
    stopId: string;
    stopSequence: number;
  }>;
};

function serviceDate(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
}

export function parseBusVehicleCandidates(data: unknown, leg: RideLeg): BusVehicleCandidate[] {
  if (leg.mode !== 'BUS' || leg.providerId !== 'tago' || !leg.cityCode || !leg.routeId ||
      !Number.isSafeInteger(leg.from.serviceSequence) || !Number.isSafeInteger(leg.to.serviceSequence)) return [];
  if (!data || typeof data !== 'object') throw new Error('버스 위치 응답이 올바르지 않습니다.');
  const response = data as BusVehicleResponse;
  if (response.providerId !== leg.providerId || response.cityCode !== leg.cityCode ||
      response.routeId !== leg.routeId || !Number.isFinite(Date.parse(response.fetchedAt)) ||
      !response.coverage || typeof response.coverage.partial !== 'boolean' || !Array.isArray(response.vehicles)) {
    throw new Error('버스 위치 응답이 경로와 맞지 않습니다.');
  }
  const boardSequence = leg.from.serviceSequence as number;
  const alightSequence = leg.to.serviceSequence as number;
  const date = serviceDate(response.fetchedAt);
  return response.vehicles.flatMap((vehicle): BusVehicleCandidate[] => {
    if (vehicle.providerId !== leg.providerId || vehicle.cityCode !== leg.cityCode ||
        vehicle.routeId !== leg.routeId || !vehicle.vehicleNumber?.trim() || !vehicle.stopId?.trim() ||
        !Number.isSafeInteger(vehicle.stopSequence) || vehicle.stopSequence < 1) return [];
    const canBoardHere = vehicle.stopSequence <= boardSequence;
    const canBeOnboard = vehicle.stopSequence >= boardSequence && vehicle.stopSequence < alightSequence;
    if (!canBoardHere && !canBeOnboard) return [];
    return [{
      id: JSON.stringify(['tago', leg.cityCode, leg.routeId, date, vehicle.vehicleNumber]),
      legId: leg.id, mode: 'BUS', vehicleNumber: vehicle.vehicleNumber,
      currentStopId: vehicle.stopId, currentStopSequence: vehicle.stopSequence,
      relativeStopIndex: vehicle.stopSequence - boardSequence,
      canBoardHere, canBeOnboard, etaSeconds: null,
      coveragePartial: response.coverage.partial,
      run: { provider: 'TAGO_BUS', serviceDate: date, tripId: null, realtimeRunId: null, vehicleId: vehicle.vehicleNumber },
      observedAt: null, matchStatus: 'UNVERIFIED', selectable: true,
      evidence: [{ source: 'TAGO_POSITION', observedAt: null, fetchedAt: response.fetchedAt, freshness: 'UNKNOWN' }],
    }];
  }).sort((a, b) => Math.abs(a.relativeStopIndex) - Math.abs(b.relativeStopIndex));
}

export async function getBusVehicleCandidates(leg: RideLeg, signal?: AbortSignal): Promise<BusVehicleCandidate[]> {
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  if (!base || leg.mode !== 'BUS' || leg.providerId !== 'tago' || !leg.cityCode || !leg.routeId ||
      !Number.isSafeInteger(leg.from.serviceSequence)) throw new Error('이 버스 구간의 실시간 위치 연결이 아직 준비되지 않았습니다.');
  const query = new URLSearchParams({ cityCode: leg.cityCode, routeId: leg.routeId,
    nearSequence: String(leg.from.serviceSequence) });
  const response = await fetch(`${base.replace(/\/$/, '')}/bus-vehicles?${query}`, { signal });
  if (!response.ok) throw new Error(response.status === 503
    ? '버스 실시간 정보 연결이 설정되지 않았습니다.' : '버스 위치를 가져오지 못했습니다.');
  return parseBusVehicleCandidates(await response.json(), leg);
}
