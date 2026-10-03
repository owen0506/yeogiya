import { getSubwayGraph } from '../journey/route-service';
import type { TransitEdge, TransitGraph, TransitNode } from './transit-types';

// 연결·시간·환승 규칙을 재계산하지 않고 기존 방향별 간선을 1:1 변환합니다.
export function getTransitSubwayGraph(): TransitGraph {
  const graph = getSubwayGraph();
  const nodes: TransitNode[] = graph.platforms.map(platform => Object.freeze({
    id: platform.id, type: 'SUBWAY_PLATFORM' as const, platformId: platform.id, platform,
  }));
  const edges: TransitEdge[] = graph.edges.map(edge => Object.freeze(edge.kind === 'ride'
    ? { from: edge.from, to: edge.to, type: 'SUBWAY_RIDE' as const, transfer: false as const }
    : { from: edge.from, to: edge.to, type: 'TRANSFER' as const, transfer: true as const }));
  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}
