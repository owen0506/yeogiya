import { networkSegments } from '../stations/network';
import { getStationByName, type Station } from '../stations/stations';

export type MapPoint = { x: number; y: number };
export type MapStation = MapPoint & { station: Station };
export type MapConnection = { points: MapPoint[]; oneWay: boolean };

// 모든 역과 분기를 같은 연결 데이터에서 그립니다. 환승역/순환 접점은 한 번만 배치합니다.
export function getMapLayout(line: string) {
  const segments = networkSegments.filter((segment) => segment.line === line);
  const primary = segments.find((segment) => !segment.branch);
  const nodes = new Map<string, MapStation>();
  const connections: MapConnection[] = [];
  if (!primary) return { stations: [], connections, height: 520 };
  const mainNames = [...new Set(primary.names)];
  mainNames.forEach((name, index) => {
    let x: number, y: number;
    if (line === '2호선') {
      // 43개 본선 역을 빠짐없이 순환형으로 배치합니다.
      if (index <= 10) { x = 100 + index * 80; y = 90; }
      else if (index <= 21) { x = 900; y = 90 + (index - 10) * 70; }
      else if (index <= 31) { x = 900 - (index - 21) * 80; y = 860; }
      else { x = 100; y = 860 - (index - 31) * 64; }
    } else {
      const row = Math.floor(index / 7), column = index % 7;
      x = 100 + (row % 2 ? 6 - column : column) * 130;
      y = 90 + row * 100;
    }
    const station = getStationByName(name)!;
    nodes.set(station.id, { station, x, y });
  });
  const pointFor = (name: string) => nodes.get(getStationByName(name)!.id)!;
  primary.names.slice(1).forEach((name, index) => connections.push({ points: [pointFor(primary.names[index]), pointFor(name)], oneWay: !!primary.oneWay }));
  let bottom = Math.max(...[...nodes.values()].map((point) => point.y));
  segments.filter((segment) => segment !== primary).forEach((segment, branchIndex) => {
    const existing = new Set(nodes.keys());
    const newNames = [...new Set(segment.names)].filter((name) => !existing.has(getStationByName(name)!.id));
    const top = bottom + 150;
    newNames.forEach((name, index) => {
      const row = Math.floor(index / 7), column = index % 7;
      const station = getStationByName(name)!;
      nodes.set(station.id, { station, x: 100 + (row % 2 ? 6 - column : column) * 130, y: top + row * 100 });
    });
    segment.names.slice(1).forEach((name, index) => {
      const a = pointFor(segment.names[index]), b = pointFor(name);
      const connectsExisting = existing.has(a.station.id) !== existing.has(b.station.id);
      // 분기 연결은 바깥 여백으로 보내 다른 역을 지나가는 것처럼 보이지 않게 합니다.
      const gutter = 940 + branchIndex * 16;
      const points = connectsExisting ? [a, { x: a.x, y: a.y - 26 }, { x: gutter, y: a.y - 26 }, { x: gutter, y: b.y - 26 }, { x: b.x, y: b.y - 26 }, b] : [a, b];
      connections.push({ points, oneWay: !!segment.oneWay });
    });
    bottom = Math.max(bottom, ...[...nodes.values()].map((point) => point.y));
  });
  return { stations: [...nodes.values()], connections, height: Math.max(520, bottom + 110) };
}
