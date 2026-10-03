// 정규화된 정적 데이터만 받습니다. 인증키·외부 API 형식·시간표는 탐색 계층에 전달하지 않습니다.
export type RideTimeRecord = Readonly<{ fromPlatformId: string; toPlatformId: string; seconds: number }>;
export type TransferTimeRecord = RideTimeRecord & Readonly<{ stationId: string }>;
export type RouteTimeData = Readonly<{
  rides?: readonly RideTimeRecord[];
  transfers?: readonly TransferTimeRecord[];
}>;

export interface RouteCostProvider {
  // 한 번의 탐색 중에는 동일한 입력에 동일한 비음수 정수(초)를 반환해야 합니다.
  rideTime(fromPlatformId: string, toPlatformId: string): number;
  transferTime(stationId: string, fromPlatformId: string, toPlatformId: string): number;
}

const DEFAULT_RIDE_SECONDS = 120;
const DEFAULT_TRANSFER_SECONDS = 300;
const key = (...ids: string[]) => JSON.stringify(ids);
const validSeconds = (value: number) => Number.isSafeInteger(value) && value >= 0;

function indexData(data: RouteTimeData) {
  const rides = new Map<string, number>();
  const transfers = new Map<string, number>();
  for (const row of data.rides ?? []) {
    if (row.fromPlatformId && row.toPlatformId && validSeconds(row.seconds)) rides.set(key(row.fromPlatformId, row.toPlatformId), row.seconds);
  }
  for (const row of data.transfers ?? []) {
    if (row.stationId && row.fromPlatformId && row.toPlatformId && validSeconds(row.seconds)) transfers.set(key(row.stationId, row.fromPlatformId, row.toPlatformId), row.seconds);
  }
  return { rides, transfers };
}

// 생성 시 복사하여 탐색 중 원본 데이터 변경의 영향을 받지 않습니다.
// primary: 별도 검증 데이터, secondary: 선택적 검증 캐시. 현재 앱에는 둘 다 연결하지 않습니다.
export function createRouteCostProvider(primary: RouteTimeData = {}, secondary: RouteTimeData = {}): RouteCostProvider {
  const first = indexData(primary), second = indexData(secondary);
  return Object.freeze({
    rideTime: (from: string, to: string) => first.rides.get(key(from, to)) ?? second.rides.get(key(from, to)) ?? DEFAULT_RIDE_SECONDS,
    transferTime: (station: string, from: string, to: string) => first.transfers.get(key(station, from, to)) ?? second.transfers.get(key(station, from, to)) ?? DEFAULT_TRANSFER_SECONDS,
  });
}

export const defaultRouteCostProvider = createRouteCostProvider();

export function checkedRouteSeconds(seconds: number): number {
  if (!validSeconds(seconds)) throw new Error('경로 비용은 비음수 안전 정수(초)여야 합니다.');
  return seconds;
}

export type RoutePreference = 'fastest' | 'fewest-transfers';
export type RouteCost = Readonly<{ transferCount: number; totalSeconds: number }>;

// 노드 선택과 relaxation 모두 이 비교 규칙을 사용합니다. 검색 점수를 시간에 섞지 않습니다.
export function compareRouteCosts(a: RouteCost, b: RouteCost, preference: RoutePreference): number {
  if (preference === 'fewest-transfers' && a.transferCount !== b.transferCount) return a.transferCount - b.transferCount;
  return a.totalSeconds - b.totalSeconds;
}
