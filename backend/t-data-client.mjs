// Backend only. Endpoints and credentials come from the environment.
const fail = code => { throw new Error(code); };
const services = {
  sectionTimes: ['T_DATA_BUS_SECTION_TIME_ENDPOINT', ['stdrDe']],
  routeStops: ['T_DATA_ROUTE_STOP_ENDPOINT', ['routeId']],
  stopHistory: ['T_DATA_BUS_STOP_HISTORY_ENDPOINT', ['stdrDe', 'routeId']],
  routeMaster: ['T_DATA_ROUTE_MASTER_ENDPOINT', []],
  stopMaster: ['T_DATA_STOP_MASTER_ENDPOINT', []],
  bisRouteInfo: ['T_DATA_BIS_ROUTE_INFO_ENDPOINT', []],
};
export function createTDataClient(env, fetchImpl = fetch, { timeoutMs = 8000 } = {}) {
  const key = env.T_DATA_API_KEY?.trim();
  if (!key) fail('T_DATA_MISSING_API_KEY');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail('T_DATA_INVALID_TIMEOUT');
  const bases = {};
  for (const [kind, [name]] of Object.entries(services)) {
    // Existing consumers do not require the newly added investigation services.
    if (!['sectionTimes', 'routeStops'].includes(kind) && !env[name]?.trim()) continue;
    if (!env[name]?.trim()) fail(`T_DATA_MISSING_${name}`);
    let url;
    try { url = new URL(env[name]); } catch { fail('T_DATA_INVALID_ENDPOINT'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 't-data.seoul.go.kr' ||
        url.port || url.username || url.password || url.search || url.hash) fail('T_DATA_INVALID_ENDPOINT');
    // The documented HTTP paths were verified over HTTPS; never transmit the key over HTTP.
    url.protocol = 'https:';
    bases[kind] = url.href;
  }
  async function request(kind, params = {}, { signal } = {}) {
    if (!bases[kind]) fail(`T_DATA_MISSING_${services[kind][0]}`);
    const { startRow = 1, rowCnt = 3 } = params;
    const maxRows = ['routeMaster', 'stopMaster', 'bisRouteInfo', 'stopHistory'].includes(kind) ? 1000 : 10;
    if (!Number.isSafeInteger(startRow) || startRow < 1 || !Number.isInteger(rowCnt) || rowCnt < 1 || rowCnt > maxRows) fail('T_DATA_INVALID_QUERY');
    const filters = [...services[kind][1]];
    if (kind === 'bisRouteInfo') {
      for (const field of ['route_id', 'route_nm', 'route_ty', 'areaId']) if (params[field] !== undefined) filters.push(field);
    }
    // Never silently ignore a supposed filter unsupported by the documented service.
    if (Object.keys(params).some(field => !['startRow', 'rowCnt', ...filters].includes(field))) fail('T_DATA_INVALID_QUERY');
    for (const filter of filters) {
      if (filter === 'route_nm') {
        if (typeof params[filter] !== 'string' || !params[filter].trim() || params[filter].length > 255) fail('T_DATA_INVALID_QUERY');
        continue;
      }
      if (typeof params[filter] !== 'string' || !(filter === 'stdrDe' ? /^\d{8}$/ : /^\d+$/).test(params[filter])) fail('T_DATA_INVALID_QUERY');
      if (filter === 'stdrDe') {
        const value = params[filter], iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
        const date = new Date(iso);
        if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== iso) fail('T_DATA_INVALID_QUERY');
      }
    }
    const url = new URL(bases[kind]);
    url.search = new URLSearchParams({ apikey: key, startRow: String(startRow), rowCnt: String(rowCnt), ...Object.fromEntries(filters.map(filter => [filter, params[filter]])) }).toString();
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (!response.ok) {
        const error = new Error('T_DATA_HTTP_ERROR');
        error.status = response.status; // Safe status only, never the upstream URL/body.
        throw error;
      }
      let raw;
      try { raw = await response.json(); } catch { fail('T_DATA_INVALID_JSON'); }
      if (!Array.isArray(raw) || raw.length > rowCnt || raw.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('T_DATA_INVALID_RESPONSE');
      if (kind === 'bisRouteInfo' && raw.some(row =>
        (params.route_id !== undefined && row.routeId !== params.route_id) ||
        (params.route_nm !== undefined && row.routeNm !== params.route_nm) ||
        (params.route_ty !== undefined && row.routeTy !== params.route_ty) ||
        (params.areaId !== undefined && row.areaId !== params.areaId))) fail('T_DATA_FILTER_MISMATCH');
      if (kind === 'stopHistory' && raw.some(row => row.routeId !== params.routeId || row.stdrDe !== params.stdrDe)) fail('T_DATA_FILTER_MISMATCH');
      return raw;
    } catch (error) {
      if (signal?.aborted) fail('T_DATA_ABORTED');
      if (timeout.aborted) fail('T_DATA_TIMEOUT');
      if (['T_DATA_HTTP_ERROR', 'T_DATA_INVALID_JSON', 'T_DATA_INVALID_RESPONSE', 'T_DATA_FILTER_MISMATCH'].includes(error?.message)) throw error;
      fail('T_DATA_REQUEST_FAILED'); // Never forward URLs, upstream bodies or credentials.
    }
  }
  return {
    sectionTimes: (params, options) => request('sectionTimes', params, options),
    routeStops: (params, options) => request('routeStops', params, options),
    stopHistory: (params, options) => request('stopHistory', params, options),
    routeMaster: (params, options) => request('routeMaster', params, options),
    stopMaster: (params, options) => request('stopMaster', params, options),
    bisRouteInfo: (params, options) => request('bisRouteInfo', params, options),
  };
}
