import type { TransitEdge, TransitGraph, TransitNode, TransitService } from './transit-types';

export type BusSnapshotStop = Readonly<{ stopId: string; sequence: number; name: string; latitude?: number; longitude?: number }>;
export type BusSnapshot = Readonly<{
  version: 1;
  routes: readonly Readonly<{
    providerId: string; cityCode: string; routeId: string; routeNumber: string;
    totalStops: number; loadedStops: number; partial: boolean;
    directions: readonly Readonly<{ direction: string; segments: readonly Readonly<{ stops: readonly BusSnapshotStop[] }>[] }>[];
  }>[];
}>;

const invalid = (): never => { throw new Error('BUS_GRAPH_INVALID_DATA'); };
const validText = (s: string) => typeof s === 'string' && s.trim().length > 0;
const coordinate = (n: number | undefined, bound: number) => n === undefined || (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= bound);

// Input is a normalized snapshot. Neither TAGO raw fields nor time costs belong here.
export function getTransitBusGraph(snapshot: BusSnapshot): TransitGraph {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.routes)) invalid();
  const nodes = new Map<string, TransitNode>(), edges: TransitEdge[] = [], routes = new Set<string>();
  for (const route of snapshot.routes) {
    if (![route.providerId, route.cityCode, route.routeId, route.routeNumber].every(validText)) invalid();
    const scope = [route.providerId, route.cityCode];
    const routeKey = JSON.stringify([...scope, route.routeId]);
    if (routes.has(routeKey)) invalid();
    routes.add(routeKey);
    const directions = new Set<string>();
    let count = 0;
    for (const direction of route.directions) {
      if (!validText(direction.direction) || directions.has(direction.direction)) invalid();
      directions.add(direction.direction);
      const service: Extract<TransitService, { mode: 'BUS' }> = Object.freeze({ mode: 'BUS', providerId: route.providerId,
        cityCode: route.cityCode, routeId: route.routeId, direction: direction.direction });
      let lastSequence = 0;
      for (const segment of direction.segments) {
        if (!segment.stops.length) invalid();
        let previous: string | undefined;
        for (const stop of segment.stops) {
          if (!validText(stop.stopId) || !validText(stop.name) || !Number.isSafeInteger(stop.sequence) || stop.sequence <= lastSequence ||
              !coordinate(stop.latitude, 90) || !coordinate(stop.longitude, 180)) invalid();
          lastSequence = stop.sequence;
          count++;
          const stopNodeId = `bus-stop:${JSON.stringify([...scope, stop.stopId])}` as const;
          const stopNode: Extract<TransitNode, { type: 'BUS_STOP' }> = Object.freeze({ id: stopNodeId, type: 'BUS_STOP',
            providerId: route.providerId, cityCode: route.cityCode, stopId: stop.stopId, name: stop.name,
            latitude: stop.latitude, longitude: stop.longitude });
          const existing = nodes.get(stopNodeId);
          if (existing && JSON.stringify(existing) !== JSON.stringify(stopNode)) invalid();
          if (!existing) nodes.set(stopNodeId, stopNode);
          const id = `bus-service:${JSON.stringify([...scope, route.routeId, direction.direction, stop.stopId, stop.sequence])}` as const;
          if (nodes.has(id)) invalid();
          nodes.set(id, Object.freeze({ id, type: 'BUS_SERVICE_STATE', service, stopId: stop.stopId, stopSequence: stop.sequence }));
          edges.push(Object.freeze({ from: stopNodeId, to: id, type: 'BOARD', service }),
            Object.freeze({ from: id, to: stopNodeId, type: 'ALIGHT', service }));
          if (previous) edges.push(Object.freeze({ from: previous, to: id, type: 'BUS_RIDE', service }));
          previous = id;
        }
      }
    }
    if (!Number.isSafeInteger(route.totalStops) || route.totalStops < count || count !== route.loadedStops || route.partial !== (count !== route.totalStops)) invalid();
  }
  return Object.freeze({ nodes: Object.freeze([...nodes.values()]), edges: Object.freeze(edges) });
}
