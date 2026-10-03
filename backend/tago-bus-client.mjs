// Backend only. Operation names follow the TAGO public API specifications.
const operations = {
  cities: ['ROUTE', 'getCtyCodeList', []],
  stops: ['STOP', 'getCrdntPrxmtSttnList', ['gpsLati', 'gpsLong']],
  routes: ['ROUTE', 'getRouteNoList', ['cityCode']],
  routeStops: ['ROUTE', 'getRouteAcctoThrghSttnList', ['cityCode', 'routeId']],
  arrivals: ['ARRIVAL', 'getSttnAcctoArvlPrearngeInfoList', ['cityCode', 'nodeId']],
  locations: ['LOCATION', 'getRouteAcctoBusLcList', ['cityCode', 'routeId']],
};
const fail = (code) => { throw new Error(code); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseTagoResponse(raw) {
  const response = raw?.response;
  if (!record(response?.header)) fail('TAGO_BUS_INVALID_RESPONSE');
  if (!['00', '0'].includes(String(response.header.resultCode))) fail('TAGO_BUS_UPSTREAM_ERROR');
  const body = response.body;
  if (!record(body)) fail('TAGO_BUS_INVALID_RESPONSE');
  const value = body.items?.item;
  let items;
  if (Array.isArray(value)) items = value;
  else if (record(value)) items = [value];
  else if ((body.items === '' || body.items == null || (record(body.items) && Object.keys(body.items).length === 0) || value === '') && Number(body.totalCount) === 0) items = [];
  else fail('TAGO_BUS_INVALID_RESPONSE');
  if (!items.every(record) || (items.length > 0 && body.totalCount !== undefined && Number(body.totalCount) < items.length)) fail('TAGO_BUS_INVALID_RESPONSE');
  return items;
}

export function createTagoBusClient(env, fetchImpl = fetch, { services = ['STOP', 'ROUTE', 'ARRIVAL', 'LOCATION'] } = {}) {
  if (!Array.isArray(services) || services.length === 0 || services.some(service => !['STOP', 'ROUTE', 'ARRIVAL', 'LOCATION'].includes(service))) fail('TAGO_BUS_INVALID_SERVICES');
  let key = env.TAGO_BUS_API_KEY?.trim();
  if (!key) fail('TAGO_BUS_MISSING_TAGO_BUS_API_KEY');
  try { key = decodeURIComponent(key); } catch { fail('TAGO_BUS_INVALID_API_KEY'); }
  const bases = {};
  for (const service of services) {
    const name = `TAGO_BUS_${service}_ENDPOINT`;
    if (!env[name]?.trim()) fail(`TAGO_BUS_MISSING_${name}`);
    let url;
    try { url = new URL(env[name]); } catch { fail(`TAGO_BUS_INVALID_${name}`); }
    if (url.protocol !== 'https:' || url.hostname !== 'apis.data.go.kr' || url.port || url.username || url.password || url.search || url.hash) fail(`TAGO_BUS_INVALID_${name}`);
    bases[service] = url.href.replace(/\/$/, '');
  }
  async function request(method, params = {}, { signal } = {}) {
    const [service, operation, required] = operations[method];
    if (!bases[service]) fail('TAGO_BUS_SERVICE_NOT_CONFIGURED');
    for (const name of required) {
      if (!['string', 'number'].includes(typeof params[name]) || !String(params[name]).trim()) fail('TAGO_BUS_INVALID_QUERY');
    }
    const rows = params.numOfRows ?? 10, page = params.pageNo ?? 1;
    if (!Number.isInteger(rows) || rows < 1 || rows > 100 || !Number.isInteger(page) || page < 1) fail('TAGO_BUS_INVALID_QUERY');
    const url = new URL(`${bases[service]}/${operation}`);
    for (const name of [...required, ...(method === 'routes' ? ['routeNo'] : [])]) {
      if (params[name] !== undefined) url.searchParams.set(name, String(params[name]));
    }
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('_type', 'json');
    if (method !== 'cities') {
      url.searchParams.set('pageNo', String(page));
      url.searchParams.set('numOfRows', String(rows));
    }
    let response, raw;
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    } catch { fail(signal?.aborted ? 'TAGO_BUS_ABORTED' : 'TAGO_BUS_UNAVAILABLE'); }
    if (!response.ok) fail('TAGO_BUS_HTTP_ERROR');
    try { raw = await response.json(); } catch { fail('TAGO_BUS_INVALID_RESPONSE'); }
    parseTagoResponse(raw);
    return raw;
  }
  return Object.freeze(Object.fromEntries(Object.entries(operations)
    .filter(([, [service]]) => services.includes(service))
    .map(([method]) => [method, (params, options) => request(method, params, options)])));
}
