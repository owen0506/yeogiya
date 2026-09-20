import { stations as allStations, type Station } from '../stations/stations';
import { interchangeName, networkSegments } from '../stations/network';

export type RouteStep = { station: Station; secondsFromStart: number; transfer: boolean };
export type JourneyRoute = { steps: RouteStep[]; seconds: number; stops: number; transfers: number };

// 역간 2분, 환승 5분은 예상값이며 실시간 운행 시간표가 아닙니다.
const stations = new Map<string, Station>(allStations.map((station) => [station.id, station]));
const edges = new Map<string, { to: string; seconds: number; transfer: boolean }[]>();

function connect(a: Station, b: Station, transfer = false, oneWay = false) {
  const seconds = transfer ? 300 : 120;
  edges.set(a.id, [...(edges.get(a.id) ?? []), { to: b.id, seconds, transfer }]);
  if (!oneWay) edges.set(b.id, [...(edges.get(b.id) ?? []), { to: a.id, seconds, transfer }]);
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

export function findRoute(fromId: string, toId: string, preference: 'fastest' | 'fewest-transfers' = 'fastest'): JourneyRoute | null {
  if (fromId === toId || !stations.has(fromId) || !stations.has(toId)) return null;
  const distances = new Map<string, number>([[fromId, 0]]);
  const costs = new Map<string, number>([[fromId, 0]]);
  const from = stations.get(fromId)!;
  const to = stations.get(toId)!;
  const targets = new Set<string>();
  // 환승역에서 여정을 시작/종료할 때는 이용 승강장까지 별도 환승으로 세지 않습니다.
  for (const station of stations.values()) {
    if (station.name === from.name && station.line === from.line) { distances.set(station.id, 0); costs.set(station.id, 0); }
    if (station.name === to.name && station.line === to.line) targets.add(station.id);
  }
  let targetId: string | null = null;
  const previous = new Map<string, { from: string; transfer: boolean }>();
  const remaining = new Set(stations.keys());
  while (remaining.size) {
    let current = '';
    let best = Infinity;
    for (const id of remaining) {
      const cost = costs.get(id) ?? Infinity;
      if (cost < best) { best = cost; current = id; }
    }
    const distance = distances.get(current);
    if (distance === undefined) break;
    remaining.delete(current);
    if (targets.has(current)) { targetId = current; break; }
    for (const edge of edges.get(current) ?? []) {
      const cost = best + edge.seconds + (preference === 'fewest-transfers' && edge.transfer ? 100_000 : 0);
      if (cost < (costs.get(edge.to) ?? Infinity)) {
        costs.set(edge.to, cost);
        distances.set(edge.to, distance + edge.seconds);
        previous.set(edge.to, { from: current, transfer: edge.transfer });
      }
    }
  }
  if (!targetId) return null;
  const steps: RouteStep[] = [];
  let cursor = targetId;
  while (true) {
    const prev = previous.get(cursor);
    steps.unshift({ station: stations.get(cursor)!, secondsFromStart: distances.get(cursor)!, transfer: prev?.transfer ?? false });
    if (!prev) break;
    cursor = prev.from;
  }
  steps[0].station = { ...from, branch: steps[0].station.branch };
  steps[steps.length - 1].station = { ...to, branch: steps[steps.length - 1].station.branch };
  const transfers = steps.filter((step) => step.transfer).length;
  return { steps, seconds: distances.get(targetId)!, stops: steps.length - 1 - transfers, transfers };
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
