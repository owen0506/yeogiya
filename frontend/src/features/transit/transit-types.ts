import type { StationPlatform } from '../stations/stations';

export type TransitNodeType = 'SUBWAY_PLATFORM' | 'BUS_STOP' | 'BUS_SERVICE_STATE';
export type TransitEdgeType = 'SUBWAY_RIDE' | 'BUS_RIDE' | 'WALK' | 'BOARD' | 'ALIGHT' | 'TRANSFER';

export type TransitService =
  | Readonly<{ mode: 'SUBWAY'; line: string; branch?: boolean }>
  | Readonly<{ mode: 'BUS'; providerId: string; cityCode: string; routeId: string; patternId?: string; direction?: string }>;

// 버스용 접두사는 기존 지하철 ID와 분리합니다. 실제 ID 생성은 데이터 적재 단계의 책임입니다.
export type TransitNode =
  | Readonly<{ id: string; type: 'SUBWAY_PLATFORM'; platformId: string; platform: Readonly<StationPlatform> }>
  | Readonly<{ id: `bus-stop:${string}`; type: 'BUS_STOP'; providerId: string; cityCode: string; stopId: string; name: string; latitude?: number; longitude?: number }>
  | Readonly<{ id: `bus-service:${string}`; type: 'BUS_SERVICE_STATE'; service: Extract<TransitService, { mode: 'BUS' }>; stopId: string; stopSequence: number }>;

export type TransitEdge = Readonly<{ from: string; to: string }> & (
  | Readonly<{ type: 'SUBWAY_RIDE'; transfer: false }>
  | Readonly<{ type: 'TRANSFER'; transfer: true }>
  | Readonly<{ type: 'BUS_RIDE' | 'BOARD' | 'ALIGHT'; service: Extract<TransitService, { mode: 'BUS' }> }>
  | Readonly<{ type: 'WALK' }>
);

export type TransitGraph = Readonly<{ nodes: readonly TransitNode[]; edges: readonly TransitEdge[] }>;
