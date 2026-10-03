// Topology and average ride costs are separate from dated Trip/StopTime data.
// This engine is the explicit fallback when a timetable is unavailable. It
// cannot infer a vehicle, departure, arrival, or waiting time from an average.

export type TransitTopologyNode =
  | Readonly<{ id: string; type: 'SUBWAY_STATION' | 'BUS_STOP' | 'WALK_POINT'; name?: string }>
  | Readonly<{ id: string; type: 'SUBWAY_PLATFORM' | 'BUS_SERVICE_STATE'; routeId: string; name?: string }>;

export type AverageTransitEdge = Readonly<{
  id: string;
  from: string;
  to: string;
  averageTravelSeconds: number;
}> & (
  | Readonly<{ kind: 'RIDE'; mode: 'SUBWAY' | 'BUS'; routeId: string }>
  | Readonly<{ kind: 'BOARD' | 'ALIGHT' | 'TRANSFER' | 'WALK' }>
);

export type TransitTopology = Readonly<{
  nodes: readonly TransitTopologyNode[];
  edges: readonly AverageTransitEdge[];
}>;

export type AverageRoute = Readonly<{
  source: 'AVERAGE_EDGE';
  from: string;
  to: string;
  nodeIds: readonly string[];
  edges: readonly AverageTransitEdge[];
  averageTravelSeconds: number;
  transferCount: number;
  waitingSeconds: null;
}>;

export type AverageRoutePreference = 'fastest' | 'fewest-transfers';
type AverageCost = { seconds: number; transfers: number };
type HeapItem = { id: string; cost: AverageCost; nodeOrder: number };

function compareCosts(a: AverageCost, b: AverageCost, preference: AverageRoutePreference): number {
  if (preference === 'fewest-transfers' && a.transfers !== b.transfers) return a.transfers - b.transfers;
  return a.seconds - b.seconds;
}

class MinHeap {
  private items: HeapItem[] = [];
  private readonly compare: (a: HeapItem, b: HeapItem) => number;

  constructor(compare: (a: HeapItem, b: HeapItem) => number) {
    this.compare = compare;
  }

  push(item: HeapItem) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(items[parent], item) <= 0) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop(): HeapItem | null {
    const items = this.items;
    if (!items.length) return null;
    const first = items[0];
    const last = items.pop()!;
    if (items.length) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= items.length) break;
        if (child + 1 < items.length && this.compare(items[child + 1], items[child]) < 0) child++;
        if (this.compare(last, items[child]) <= 0) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return first;
  }
}

function adjacency(topology: TransitTopology): Map<string, AverageTransitEdge[]> {
  if (!topology || !Array.isArray(topology.nodes) || !Array.isArray(topology.edges)) throw new Error('AVERAGE_GRAPH_INVALID');
  const nodeIds = new Set<string>();
  const nodes = new Map<string, TransitTopologyNode>();
  for (const node of topology.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim() || nodeIds.has(node.id) ||
      !['SUBWAY_STATION', 'SUBWAY_PLATFORM', 'BUS_STOP', 'BUS_SERVICE_STATE', 'WALK_POINT'].includes(node.type) ||
      ((node.type === 'SUBWAY_PLATFORM' || node.type === 'BUS_SERVICE_STATE') &&
        (typeof node.routeId !== 'string' || !node.routeId.trim()))) {
      throw new Error('AVERAGE_GRAPH_INVALID_NODE');
    }
    nodeIds.add(node.id);
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  const edges = new Map<string, AverageTransitEdge[]>();
  for (const edge of topology.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id.trim() || edgeIds.has(edge.id) ||
      !nodeIds.has(edge.from) || !nodeIds.has(edge.to) ||
      !Number.isSafeInteger(edge.averageTravelSeconds) || edge.averageTravelSeconds < 0) {
      throw new Error('AVERAGE_GRAPH_INVALID_EDGE');
    }
    if (edge.kind === 'RIDE') {
      const expected = edge.mode === 'SUBWAY' ? 'SUBWAY_PLATFORM' : edge.mode === 'BUS' ? 'BUS_SERVICE_STATE' : null;
      const fromNode = nodes.get(edge.from), toNode = nodes.get(edge.to);
      if (!expected || fromNode?.type !== expected || toNode?.type !== expected ||
        typeof edge.routeId !== 'string' || !edge.routeId.trim()) {
        throw new Error('AVERAGE_GRAPH_INVALID_EDGE');
      }
      if (!fromNode || !toNode || !('routeId' in fromNode) || !('routeId' in toNode) ||
        fromNode.routeId !== edge.routeId || toNode.routeId !== edge.routeId) throw new Error('AVERAGE_GRAPH_INVALID_EDGE');
    } else if (!['BOARD', 'ALIGHT', 'TRANSFER', 'WALK'].includes(edge.kind)) {
      throw new Error('AVERAGE_GRAPH_INVALID_EDGE');
    }
    edgeIds.add(edge.id);
    edges.set(edge.from, [...(edges.get(edge.from) ?? []), edge]);
  }
  for (const id of nodeIds) if (!edges.has(id)) edges.set(id, []);
  return edges;
}

export function findAverageRouteBetween(
  topology: TransitTopology,
  origins: readonly string[],
  destinations: readonly string[],
  preference: AverageRoutePreference = 'fastest',
): AverageRoute | null {
  const outgoing = adjacency(topology);
  if (!['fastest', 'fewest-transfers'].includes(preference)) throw new Error('AVERAGE_GRAPH_INVALID_PREFERENCE');
  if (origins.some(id => !outgoing.has(id)) || destinations.some(id => !outgoing.has(id))) throw new Error('AVERAGE_GRAPH_UNKNOWN_NODE');
  if (!origins.length || !destinations.length) return null;
  const destinationSet = new Set(destinations);
  const nodeOrder = new Map(topology.nodes.map((node, index) => [node.id, index]));
  const best = new Map<string, AverageCost>();
  const previous = new Map<string, { from: string; edge: AverageTransitEdge }>();
  const heap = new MinHeap((a, b) => compareCosts(a.cost, b.cost, preference) || a.nodeOrder - b.nodeOrder);
  for (const id of origins) {
    if (best.has(id)) continue;
    const cost = { seconds: 0, transfers: 0 };
    best.set(id, cost);
    heap.push({ id, cost, nodeOrder: nodeOrder.get(id)! });
  }
  let chosenDestination: string | null = null;
  while (true) {
    const current = heap.pop();
    if (!current) break;
    if (current.cost !== best.get(current.id)) continue;
    if (destinationSet.has(current.id)) { chosenDestination = current.id; break; }
    for (const edge of outgoing.get(current.id) ?? []) {
      const next: AverageCost = {
        seconds: current.cost.seconds + edge.averageTravelSeconds,
        transfers: current.cost.transfers + (edge.kind === 'TRANSFER' ? 1 : 0),
      };
      if (!Number.isSafeInteger(next.seconds) || !Number.isSafeInteger(next.transfers)) throw new Error('AVERAGE_GRAPH_INVALID_COST');
      const old = best.get(edge.to);
      if (old !== undefined && compareCosts(old, next, preference) <= 0) continue;
      best.set(edge.to, next);
      previous.set(edge.to, { from: current.id, edge });
      heap.push({ id: edge.to, cost: next, nodeOrder: nodeOrder.get(edge.to)! });
    }
  }
  if (!chosenDestination) return null;
  const total = best.get(chosenDestination)!;
  const routeEdges: AverageTransitEdge[] = [];
  const nodeIds = [chosenDestination];
  let cursor = chosenDestination;
  while (previous.has(cursor)) {
    const step = previous.get(cursor);
    if (!step) throw new Error('AVERAGE_GRAPH_INVALID_PATH');
    routeEdges.unshift(step.edge);
    nodeIds.unshift(step.from);
    cursor = step.from;
  }
  return {
    source: 'AVERAGE_EDGE', from: cursor, to: chosenDestination, nodeIds, edges: routeEdges,
    averageTravelSeconds: total.seconds, transferCount: total.transfers, waitingSeconds: null,
  };
}

export function findAverageRoute(topology: TransitTopology, from: string, to: string): AverageRoute | null {
  return findAverageRouteBetween(topology, [from], [to]);
}
