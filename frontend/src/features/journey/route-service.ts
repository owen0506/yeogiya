import { mockStations, type Station } from '../stations/stations';

export type RouteStep = { station: Station; secondsFromStart: number; transfer: boolean };
export type JourneyRoute = { steps: RouteStep[]; seconds: number; stops: number; transfers: number };

// 개발용 부분 노선망. 역간 2분, 환승 5분은 실측이 아닌 데모 가정입니다.
const segments: { line: string; names: string[] }[] = [
  { line: '1호선', names: ['서울역', '시청', '종각', '종로3가'] },
  { line: '2호선', names: ['홍대입구', '신촌', '이대', '아현', '충정로', '시청'] },
  { line: '2호선', names: ['사당', '방배', '서초', '교대', '강남', '역삼', '선릉', '삼성', '종합운동장', '잠실새내', '잠실'] },
  { line: '3호선', names: ['종로3가', '을지로3가', '충무로', '동대입구', '약수', '금호', '옥수', '압구정', '신사', '잠원', '고속터미널'] },
  { line: '4호선', names: ['서울역', '숙대입구', '삼각지', '신용산', '이촌', '동작', '총신대입구(이수)', '사당'] },
  { line: '5호선', names: ['종로3가', '광화문', '서대문', '충정로', '애오개', '공덕', '마포', '여의나루', '여의도'] },
  { line: '9호선', names: ['여의도', '샛강', '노량진', '노들', '흑석', '동작', '구반포', '신반포', '고속터미널'] },
];
const stations = new Map<string, Station>(mockStations.map((station) => [station.id, station]));
const edges = new Map<string, { to: string; seconds: number; transfer: boolean }[]>();

function connect(a: Station, b: Station, transfer = false) {
  const seconds = transfer ? 300 : 120;
  edges.set(a.id, [...(edges.get(a.id) ?? []), { to: b.id, seconds, transfer }]);
  edges.set(b.id, [...(edges.get(b.id) ?? []), { to: a.id, seconds, transfer }]);
}

for (const segment of segments) {
  const nodes = segment.names.map((name) => {
    const station = [...stations.values()].find((item) => item.name === name && item.line === segment.line)
      ?? { id: `demo-${segment.line}-${name}`, name, line: segment.line };
    stations.set(station.id, station);
    return station;
  });
  nodes.slice(1).forEach((station, index) => connect(nodes[index], station));
}
const nodes = [...stations.values()];
nodes.forEach((a, index) => nodes.slice(index + 1).forEach((b) => {
  if (a.name === b.name && a.line !== b.line) connect(a, b, true);
}));

export function findRoute(fromId: string, toId: string): JourneyRoute | null {
  if (fromId === toId || !stations.has(fromId) || !stations.has(toId)) return null;
  const distances = new Map<string, number>([[fromId, 0]]);
  const previous = new Map<string, { from: string; transfer: boolean }>();
  const remaining = new Set(stations.keys());
  while (remaining.size) {
    const current = [...remaining].sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    const distance = distances.get(current);
    if (distance === undefined) break;
    remaining.delete(current);
    if (current === toId) break;
    for (const edge of edges.get(current) ?? []) {
      if (distance + edge.seconds < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, distance + edge.seconds);
        previous.set(edge.to, { from: current, transfer: edge.transfer });
      }
    }
  }
  if (!distances.has(toId)) return null;
  const steps: RouteStep[] = [];
  let cursor = toId;
  while (true) {
    const prev = previous.get(cursor);
    steps.unshift({ station: stations.get(cursor)!, secondsFromStart: distances.get(cursor)!, transfer: prev?.transfer ?? false });
    if (!prev) break;
    cursor = prev.from;
  }
  const transfers = steps.filter((step) => step.transfer).length;
  return { steps, seconds: distances.get(toId)!, stops: steps.length - 1 - transfers, transfers };
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
