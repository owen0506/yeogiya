import { lineColor } from '../stations/network';

// Keep the product's green palette separate from the colors of a service.
const busColors = {
  trunk: '#2D6CC6',
  branch: '#239461',
  rapid: '#D84B55',
  circular: '#B99726',
  unknown: '#66788A',
} as const;

export function busColor(routeType?: string): string {
  if (!routeType) return busColors.unknown;
  if (/간선|trunk|blue/i.test(routeType)) return busColors.trunk;
  if (/지선|마을|branch|local|green/i.test(routeType)) return busColors.branch;
  if (/광역|급행|rapid|red/i.test(routeType)) return busColors.rapid;
  if (/순환|circular|yellow/i.test(routeType)) return busColors.circular;
  return busColors.unknown;
}

export function transitColor(mode: 'SUBWAY' | 'BUS', line: string, routeType?: string): string {
  return mode === 'SUBWAY' ? lineColor(line) : busColor(routeType);
}
