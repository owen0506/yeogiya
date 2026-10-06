import { interchangeName, networkSegments, stationAliases } from '../features/stations/network';
import type { RideLeg } from '../features/transit/journey-plan';

export function canonicalSubwayStation(name: string): string {
  const compact = name.replace(/\s/g, '').replace(/역$/, '');
  return interchangeName(stationAliases[compact] ?? compact);
}

export function normalizeSubwayDirection(raw: string | null | undefined): '0' | '1' | null {
  if (raw === '0' || raw === '상행' || raw === '내선') return '0';
  if (raw === '1' || raw === '하행' || raw === '외선') return '1';
  return null;
}

export function subwayTerminalName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = canonicalSubwayStation(raw.split(' - ')[0].split('행')[0]);
  return name && !/순환|방면/.test(name) ? name : null;
}

type ServiceDirection = Readonly<{ direction: '0' | '1' | null; branch: boolean; next: Map<string, Set<string>> }>;

function add(next: Map<string, Set<string>>, from: string, to: string) {
  if (!next.has(from)) next.set(from, new Set());
  next.get(from)!.add(to);
}

function containsRoute(next: Map<string, Set<string>>, names: readonly string[]): boolean {
  return names.length > 1 && names.slice(1).every((name, index) => next.get(names[index])?.has(name));
}

function serviceDirections(leg: RideLeg): ServiceDirection[] {
  const wanted = leg.stops.map(stop => canonicalSubwayStation(stop.name));
  const segments = networkSegments.filter(segment => segment.line === leg.line);
  if (leg.line === '2호선') {
    // Inner/outer refer to the ring. Spur services require their own terminal path.
    return segments.flatMap(segment => [false, true].flatMap(reverse => {
      const next = new Map<string, Set<string>>();
      const names = (reverse ? [...segment.names].reverse() : segment.names).map(canonicalSubwayStation);
      names.slice(1).forEach((name, index) => add(next, names[index], name));
      return containsRoute(next, wanted) ? [{ next, branch: !!segment.branch,
        direction: segment.branch ? null : reverse ? '1' as const : '0' as const }] : [];
    }));
  }
  return (['0', '1'] as const).flatMap(direction => {
    const next = new Map<string, Set<string>>();
    for (const segment of segments) {
      const names = (direction === '0' && !segment.oneWay ? [...segment.names].reverse() : segment.names).map(canonicalSubwayStation);
      names.slice(1).forEach((name, index) => add(next, names[index], name));
    }
    return containsRoute(next, wanted) ? [{ next, branch: false, direction }] : [];
  });
}

// Follow the ride's direction back to its upstream terminus. At an ambiguous
// branch, keep the known path; a loop ends before repeating a displayed stop.
export function getSubwayCorridorNames(leg: RideLeg): readonly string[] | null {
  if (leg.mode !== 'SUBWAY' || leg.stops.length < 2) return null;
  const wanted = leg.stops.map(stop => canonicalSubwayStation(stop.name));
  const paths = serviceDirections(leg).map(service => {
    const previous = new Map<string, Set<string>>();
    for (const [from, destinations] of service.next) {
      for (const to of destinations) add(previous, to, from);
    }
    const prefix: string[] = [];
    const seen = new Set(wanted);
    let current = wanted[0];
    while (true) {
      const predecessors = [...(previous.get(current) ?? [])];
      if (predecessors.length !== 1 || seen.has(predecessors[0])) break;
      current = predecessors[0];
      prefix.unshift(current);
      seen.add(current);
    }
    return [...prefix, ...wanted];
  });
  const unique = new Map(paths.map(path => [JSON.stringify(path), path]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function reachesTerminal(service: ServiceDirection, wanted: readonly string[], terminal: string): boolean {
  if (terminal === wanted.at(-1)) return true;
  const seen = new Set(wanted.slice(0, -1));
  const queue = [wanted[wanted.length - 1]];
  while (queue.length) {
    const station = queue.shift()!;
    if (seen.has(station)) continue;
    seen.add(station);
    for (const next of service.next.get(station) ?? []) {
      if (next === terminal) return true;
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

// This verifies a service direction and terminal coverage, never a timetable Trip.
export function subwayServiceMatchesLeg(
  leg: RideLeg,
  rawDirection: string | null | undefined,
  rawTerminal: string | null | undefined,
  express: boolean | null | undefined = false,
): boolean {
  if (leg.mode !== 'SUBWAY' || express === true) return false;
  const direction = normalizeSubwayDirection(rawDirection);
  const terminal = subwayTerminalName(rawTerminal);
  const wanted = leg.stops.map(stop => canonicalSubwayStation(stop.name));
  return serviceDirections(leg).some(service => {
    if (service.direction !== null && direction !== service.direction) return false;
    if (!terminal) {
      const loop = rawTerminal?.replace(/\s/g, '');
      return leg.line === '2호선' && !service.branch &&
        ((direction === '0' && loop === '내선순환') || (direction === '1' && loop === '외선순환'));
    }
    return reachesTerminal(service, wanted, terminal);
  });
}

export function sameSubwayDirection(a: string | null | undefined, b: string | null | undefined): boolean {
  const first = normalizeSubwayDirection(a), second = normalizeSubwayDirection(b);
  return first !== null && first === second;
}
