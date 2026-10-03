/**
 * @typedef {{type: 'WALK'|'BUS'|'SUBWAY', seconds?: number, distanceMeters?: number,
 * fromName?: string, toName?: string, stopNames?: string[], routeNames?: string[]}} BenchmarkLeg
 * @typedef {{provider: string, routeIndex: number, totalSeconds?: number,
 * transferCount?: number, walkingSeconds?: number, legs: BenchmarkLeg[]}} BenchmarkRoute
 * @typedef {{origin: {latitude: number, longitude: number},
 * destination: {latitude: number, longitude: number}, departureTime?: string}} RouteQuery
 * @typedef {{searchRoute: (query: RouteQuery, options?: {signal?: AbortSignal}) => Promise<BenchmarkRoute[]>}} ExternalRoutingProvider
 */

export function validateRouteQuery(query) {
  for (const point of [query?.origin, query?.destination]) {
    if (!point || typeof point.latitude !== 'number' || typeof point.longitude !== 'number' ||
        !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
        Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) throw new Error('BENCHMARK_INVALID_QUERY');
  }
}

// Positive means Yeogiya takes longer / transfers more. Missing is never zero.
export function compareBenchmarkRoutes(yeogiya, benchmark) {
  const diff = key => {
    const a = yeogiya?.[key], b = benchmark?.[key];
    return typeof a === 'number' && Number.isFinite(a) && a >= 0 &&
      typeof b === 'number' && Number.isFinite(b) && b >= 0 ? a - b : undefined;
  };
  return { totalSecondsDiff: diff('totalSeconds'), transferCountDiff: diff('transferCount'), walkingSecondsDiff: diff('walkingSeconds') };
}
