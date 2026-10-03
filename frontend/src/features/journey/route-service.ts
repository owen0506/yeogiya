import { stationPlatforms as allStations, getStation, type Station, type StationPlatform } from '../stations/stations';
import { interchangeName, networkSegments } from '../stations/network';
import { findAverageRouteBetween, type AverageTransitEdge, type TransitTopology } from '../transit/average-route-engine';
import { checkedRouteSeconds, defaultRouteCostProvider, type RouteCostProvider, type RoutePreference } from './route-costs';

export type RouteStep = { station: StationPlatform; secondsFromStart: number; transfer: boolean; distanceMeters?: number };
export type JourneyRoute = { steps: RouteStep[]; seconds: number; stops: number; transfers: number; official?: { distanceMeters: number; departureAt: string; arrivalAt: string; searchedAt: string; fetchedAt: string; firstTrain: string; destination: string } };

// 기존 플랫폼 ID와 연결망을 보존합니다. 시간은 탐색 시 별도 provider에서 받습니다.
const stations = new Map<string, StationPlatform>(allStations.map((station) => [station.id, station]));
type RouteEdge = { to: string } & ({ kind: 'ride'; transfer: false } | { kind: 'transfer'; transfer: true });
const edges = new Map<string, RouteEdge[]>();

// 기존 플랫폼 객체를 참조하되 조회 결과와 타입은 읽기 전용입니다.
export function getSubwayGraph(): Readonly<{
  platforms: readonly Readonly<StationPlatform>[];
  edges: readonly Readonly<RouteEdge & { from: string }>[];
}> {
  return Object.freeze({
    platforms: Object.freeze([...stations.values()]),
    edges: Object.freeze([...edges].flatMap(([from, list]) => list.map(edge => Object.freeze({ from, ...edge })))),
  });
}

// 적재 검증은 탐색과 동일한 플랫폼·방향별 연결을 사용합니다.
export function getRideGraph() {
  return { platforms: [...stations.values()].map(p => ({ ...p })), rides: [...edges].flatMap(([from, list]) => list.filter(e => e.kind === 'ride').map(e => ({ from, to: e.to }))) };
}

function connect(a: StationPlatform, b: StationPlatform, transfer = false, oneWay = false) {
  const meaning = transfer ? { kind: 'transfer' as const, transfer: true as const } : { kind: 'ride' as const, transfer: false as const };
  edges.set(a.id, [...(edges.get(a.id) ?? []), { to: b.id, ...meaning }]);
  if (!oneWay) edges.set(b.id, [...(edges.get(b.id) ?? []), { to: a.id, ...meaning }]);
}

for (const segment of networkSegments) {
  const nodes = segment.names.map((name, index) => {
    const station = allStations.find((item) => item.name === name && item.line === segment.line)!;
    // 2호선 지선은 성수/신도림에서 열차를 갈아타야 합니다.
    if (segment.line === '2호선' && segment.branch && index === 0) {
      const platform = { ...station, id: `${station.id}-branch`, branch: true };
      stations.set(platform.id, platform);
      connect(station, platform, true);
      return platform;
    }
    return station;
  });
  nodes.slice(1).forEach((station, index) => connect(nodes[index], station, false, segment.oneWay));
}
const nodes = [...stations.values()];
nodes.forEach((a, index) => nodes.slice(index + 1).forEach((b) => {
  if (interchangeName(a.name) === interchangeName(b.name) && a.line !== b.line) connect(a, b, true);
}));

export function findRoute(fromId: string, toId: string, preference: RoutePreference = 'fastest', costProvider: RouteCostProvider = defaultRouteCostProvider): JourneyRoute | null {
  const origin = getStation(fromId), destination = getStation(toId);
  if (fromId === toId || !origin || !destination) return null;
  // 기존 호선별 ID도 읽을 수 있지만, 화면에서는 통합 역 ID를 전달합니다.
  const from = stations.get(fromId);
  const to = stations.get(toId);
  const origins: string[] = [];
  const targets: string[] = [];
  // 환승역에서 여정을 시작/종료할 때는 이용 승강장까지 별도 환승으로 세지 않습니다.
  for (const station of stations.values()) {
    if (station.stationId === origin.id && (!from || station.line === from.line)) origins.push(station.id);
    if (station.stationId === destination.id && (!to || station.line === to.line)) targets.push(station.id);
  }
  // 평균 구간시간은 provider가 공급하고, 경로 선택은 공통 그래프 엔진이 수행합니다.
  const topology: TransitTopology = {
    nodes: [...stations.values()].map(station => ({ id: station.id, type: 'SUBWAY_PLATFORM', routeId: station.line })),
    edges: [...edges].flatMap(([platformId, list]) => list.map((edge, index): AverageTransitEdge => ({
      id: `${platformId}:${index}`, from: platformId, to: edge.to,
      averageTravelSeconds: checkedRouteSeconds(edge.kind === 'ride'
        ? costProvider.rideTime(platformId, edge.to)
        : costProvider.transferTime(stations.get(platformId)!.stationId, platformId, edge.to)),
      ...(edge.kind === 'ride'
        ? { kind: 'RIDE' as const, mode: 'SUBWAY' as const, routeId: stations.get(platformId)!.line }
        : { kind: 'TRANSFER' as const }),
    }))),
  };
  let result: ReturnType<typeof findAverageRouteBetween>;
  try { result = findAverageRouteBetween(topology, origins, targets, preference); }
  catch (error) {
    if (error instanceof Error && error.message === 'AVERAGE_GRAPH_INVALID_COST') {
      throw new Error('경로 비용은 비음수 안전 정수(초)여야 합니다.');
    }
    throw error;
  }
  if (!result) return null;
  let secondsFromStart = 0;
  const steps: RouteStep[] = result.nodeIds.map((id, index) => {
    const edge = result.edges[index - 1];
    if (edge) secondsFromStart = checkedRouteSeconds(secondsFromStart + edge.averageTravelSeconds);
    return { station: stations.get(id)!, secondsFromStart, transfer: edge?.kind === 'TRANSFER' };
  });
  if (from) steps[0].station = { ...from, branch: steps[0].station.branch };
  if (to) steps[steps.length - 1].station = { ...to, branch: steps[steps.length - 1].station.branch };
  const transfers = steps.filter((step) => step.transfer).length;
  return { steps, seconds: result.averageTravelSeconds, stops: steps.length - 1 - transfers, transfers };
}

export type RouteStop = { station: Station; lines: string[]; secondsFromStart: number; transfer: boolean };

export function getRouteLegs(route: JourneyRoute) {
  const legs: { line: string; from: string; to: string; seconds: number }[] = [];
  let transferSeconds = 0;
  let leg: (typeof legs)[number] | undefined;
  for (let i = 1; i < route.steps.length; i++) {
    const previous = route.steps[i - 1], step = route.steps[i];
    const seconds = step.secondsFromStart - previous.secondsFromStart;
    if (step.transfer) {
      transferSeconds += seconds;
      leg = undefined;
      continue;
    }
    if (!leg) {
      leg = { line: previous.station.line, from: getStation(previous.station.stationId)!.name, to: '', seconds: 0 };
      legs.push(leg);
    }
    leg.to = getStation(step.station.stationId)!.name;
    leg.seconds += seconds;
  }
  return { legs, transferSeconds };
}

// 환승 시간과 호선별 연결은 유지하면서 화면에서는 환승역을 한 번만 표시합니다.
export function getRouteStops(route: JourneyRoute): RouteStop[] {
  const stops: RouteStop[] = [];
  for (const step of route.steps) {
    const previous = stops[stops.length - 1];
    if (previous?.station.id === step.station.stationId) {
      if (!previous.lines.includes(step.station.line)) previous.lines.push(step.station.line);
      previous.transfer ||= step.transfer;
    } else {
      stops.push({ station: getStation(step.station.stationId)!, lines: [step.station.line], secondsFromStart: step.secondsFromStart, transfer: step.transfer });
    }
  }
  return stops;
}

export function alarmDelaySeconds(route: JourneyRoute, stopsBefore: number): number {
  // 도착지에서 역간 이동만 역산합니다. 환승 자체는 한 역으로 세지 않습니다.
  let remaining = Math.max(1, Math.floor(stopsBefore));
  for (let i = route.steps.length - 1; i > 0; i--) {
    if (!route.steps[i].transfer) remaining--;
    if (remaining === 0) return Math.max(1, route.steps[i - 1].secondsFromStart);
  }
  return 1;
}
