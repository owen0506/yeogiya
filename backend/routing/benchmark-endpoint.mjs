import { createKakaoRoutingProvider } from './kakao-routing-provider.mjs';

// Separate developer endpoint. The normal route/cost providers never call this.
export async function handleBenchmarkRoute(url, res, env, createProvider = createKakaoRoutingProvider) {
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once('close', close);
  const reply = (status, payload) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
  try {
    const coordinate = name => {
      const values = url.searchParams.getAll(name);
      if (values.length !== 1 || !values[0].trim()) throw new Error('BENCHMARK_INVALID_QUERY');
      return Number(values[0]);
    };
    const routeIndex = Number(url.searchParams.get('routeIndex') ?? 0);
    if (!Number.isSafeInteger(routeIndex) || routeIndex < 0) throw new Error('BENCHMARK_INVALID_QUERY');
    const query = { origin: { longitude: coordinate('start_x'), latitude: coordinate('start_y') },
      destination: { longitude: coordinate('end_x'), latitude: coordinate('end_y') },
      ...(url.searchParams.has('departureTime') ? { departureTime: url.searchParams.get('departureTime') } : {}),
    };
    const routes = await createProvider(env).searchRoute(query, { signal: controller.signal });
    if (!routes[routeIndex]) throw new Error('BENCHMARK_NO_RESULTS');
    reply(200, routes[routeIndex]);
  } catch (error) {
    const statuses = { BENCHMARK_INVALID_QUERY: 400, BENCHMARK_DEPARTURE_TIME_UNSUPPORTED: 400,
      BENCHMARK_NOT_CONFIGURED: 503, BENCHMARK_INVALID_ENDPOINT: 503, BENCHMARK_TIMEOUT: 504,
      BENCHMARK_ABORTED: 499, BENCHMARK_NO_RESULTS: 404, BENCHMARK_HTTP_ERROR: 502,
      BENCHMARK_UNAVAILABLE: 502, BENCHMARK_INVALID_JSON: 502, BENCHMARK_INVALID_RESPONSE: 502 };
    const code = Object.hasOwn(statuses, error?.message) ? error.message : 'BENCHMARK_UNAVAILABLE';
    reply(statuses[code], { error: code });
  } finally { res.off('close', close); }
}
