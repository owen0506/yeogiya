import { validateRouteQuery } from './external-routing-provider.mjs';

const defaultEndpoint = 'https://dapi.kakao.com/v2/routing/publictraffic';
const fail = code => { throw new Error(code); };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const metric = value => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('BENCHMARK_INVALID_RESPONSE');
  return value;
};
const names = values => {
  if (values === undefined || values === null) return undefined;
  if (!Array.isArray(values) || values.some(v => !record(v) || typeof v.name !== 'string' || !v.name.trim())) fail('BENCHMARK_INVALID_RESPONSE');
  return values.map(v => v.name);
};

/** @returns {import('./external-routing-provider.mjs').BenchmarkRoute[]} */
export function normalizeKakaoRoutes(raw) {
  if (raw?.status === 'NO_RESULTS') fail('BENCHMARK_NO_RESULTS');
  if (raw?.status !== 'OK' || !Array.isArray(raw.routes) || !raw.routes.length) fail('BENCHMARK_INVALID_RESPONSE');
  return raw.routes.map((route, routeIndex) => {
    if (!record(route?.properties) || !Array.isArray(route.steps) || !route.steps.length) fail('BENCHMARK_INVALID_RESPONSE');
    const legs = route.steps.map(step => {
      const p = step?.properties;
      if (!record(p) || !['WALKING', 'SUBWAY', 'BUS'].includes(p.type)) fail('BENCHMARK_INVALID_RESPONSE');
      const stopNames = names(p.stops), routeNames = names(p.vehicles);
      return {
        type: p.type === 'WALKING' ? 'WALK' : p.type,
        ...(metric(p.time) === undefined ? {} : { seconds: metric(p.time) }),
        ...(metric(p.distance) === undefined ? {} : { distanceMeters: metric(p.distance) }),
        ...(stopNames === undefined ? {} : { stopNames }),
        ...(stopNames?.length ? { fromName: stopNames[0], toName: stopNames.at(-1) } : {}),
        ...(routeNames === undefined ? {} : { routeNames }),
      };
    });
    const walks = legs.filter(leg => leg.type === 'WALK');
    // This is the sum of explicitly returned WALK steps, not inferred access/egress.
    const walkingSeconds = walks.length && walks.every(leg => leg.seconds !== undefined) ? walks.reduce((sum, leg) => sum + leg.seconds, 0) : undefined;
    if (walkingSeconds !== undefined && !Number.isSafeInteger(walkingSeconds)) fail('BENCHMARK_INVALID_RESPONSE');
    const totalSeconds = metric(route.properties.totalTime), transferCount = metric(route.properties.transfers);
    // Total can include time not represented in steps. Never replace it with their sum.
    return { provider: 'KAKAO', routeIndex, legs,
      ...(totalSeconds === undefined ? {} : { totalSeconds }),
      ...(transferCount === undefined ? {} : { transferCount }),
      ...(walkingSeconds === undefined ? {} : { walkingSeconds }),
    };
  });
}

/** @returns {import('./external-routing-provider.mjs').ExternalRoutingProvider} */
export function createKakaoRoutingProvider(env, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const key = env.KAKAO_REST_API_KEY?.trim();
  if (!key) fail('BENCHMARK_NOT_CONFIGURED');
  let endpoint;
  try { endpoint = new URL(env.KAKAO_TRANSIT_ROUTE_ENDPOINT || defaultEndpoint); } catch { fail('BENCHMARK_INVALID_ENDPOINT'); }
  if (endpoint.origin !== 'https://dapi.kakao.com' || endpoint.pathname !== '/v2/routing/publictraffic' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('BENCHMARK_INVALID_ENDPOINT');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('BENCHMARK_INVALID_TIMEOUT');
  return Object.freeze({ async searchRoute(query, { signal } = {}) {
    validateRouteQuery(query);
    // Publictraffic's documented parameters have no departure-time option.
    if (query.departureTime !== undefined) fail('BENCHMARK_DEPARTURE_TIME_UNSUPPORTED');
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries({ start_x: query.origin.longitude, start_y: query.origin.latitude,
      end_x: query.destination.longitude, end_y: query.destination.latitude })) url.searchParams.set(name, String(value));
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response, raw;
    try {
      requestSignal.throwIfAborted();
      response = await fetchImpl(url, { headers: { Authorization: `KakaoAK ${key}` }, signal: requestSignal, redirect: 'error' });
    } catch { fail(signal?.aborted ? 'BENCHMARK_ABORTED' : deadline.aborted ? 'BENCHMARK_TIMEOUT' : 'BENCHMARK_UNAVAILABLE'); }
    if (!response.ok) fail('BENCHMARK_HTTP_ERROR');
    try { raw = await response.json(); }
    catch { fail(signal?.aborted ? 'BENCHMARK_ABORTED' : deadline.aborted ? 'BENCHMARK_TIMEOUT' : 'BENCHMARK_INVALID_JSON'); }
    return normalizeKakaoRoutes(raw);
  } });
}
