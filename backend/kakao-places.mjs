import { createHash } from 'node:crypto';

// Local search is server-only: credentials go in an Authorization header, never a URL.
const baseUrl = 'https://dapi.kakao.com/v2/local/search/';
const maxResults = 10;
const timeoutMs = 6000;
const fail = code => { throw new Error(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const controlCharacters = /[\u0000-\u001f\u007f]/;
const decimal = /^-?\d+(?:\.\d+)?$/;

function text(value, limit, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > limit || controlCharacters.test(value)) fail('PLACES_INVALID_DATA');
  return value.trim();
}

function coordinate(value, limit, code = 'PLACES_INVALID_DATA') {
  if (!['string', 'number'].includes(typeof value) || !decimal.test(String(value))) fail(code);
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > limit) fail(code);
  return result;
}

export function parsePlaceSearchQuery(params) {
  const allowed = ['query', 'latitude', 'longitude'];
  if ([...params.keys()].some(name => !allowed.includes(name))
    || params.getAll('query').length !== 1
    || allowed.some(name => params.getAll(name).length > 1)) fail('PLACES_INVALID_QUERY');
  const query = params.get('query').trim();
  if (query.length < 2 || query.length > 100 || controlCharacters.test(query)) fail('PLACES_INVALID_QUERY');
  if (params.has('latitude') !== params.has('longitude')) fail('PLACES_INVALID_QUERY');
  return {
    query,
    ...(params.has('latitude') ? {
      latitude: coordinate(params.get('latitude'), 90, 'PLACES_INVALID_QUERY'),
      longitude: coordinate(params.get('longitude'), 180, 'PLACES_INVALID_QUERY'),
    } : {}),
  };
}

function normalizeDocuments(raw, kind) {
  if (!record(raw) || !Array.isArray(raw.documents) || raw.documents.length > 15) fail('PLACES_INVALID_DATA');
  return raw.documents.map(document => {
    if (!record(document)) fail('PLACES_INVALID_DATA');
    const latitude = coordinate(document.y, 90);
    const longitude = coordinate(document.x, 180);
    if (kind === 'PLACE') {
      const providerPlaceId = text(document.id, 100);
      if (!/^[A-Za-z0-9_-]+$/.test(providerPlaceId)) fail('PLACES_INVALID_DATA');
      const category = text(document.category_name, 300, { optional: true });
      return {
        provider: 'kakao', providerPlaceId,
        name: text(document.place_name, 200),
        address: text(document.road_address_name || document.address_name, 500),
        latitude, longitude, kind,
        ...(category ? { category } : {}),
      };
    }
    const address = text(document.road_address?.address_name || document.address_name, 500);
    const name = text(document.road_address?.building_name || address, 500);
    return {
      provider: 'kakao',
      providerPlaceId: `address:${createHash('sha256').update(address.normalize('NFC')).digest('hex').slice(0, 24)}`,
      name, address, latitude, longitude, kind,
    };
  });
}

/** Keyword results have priority; address matches fill the remaining candidate slots. */
export async function fetchPlaceSearch(params, config = {}, fetchImpl = fetch, { signal } = {}) {
  const query = parsePlaceSearchQuery(params);
  const key = config.KAKAO_REST_API_KEY?.trim();
  if (!key || controlCharacters.test(key)) fail('PLACES_NOT_CONFIGURED');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const request = async (operation, kind) => {
    const url = new URL(`${operation}.json`, baseUrl);
    url.searchParams.set('query', query.query);
    url.searchParams.set('size', String(maxResults));
    url.searchParams.set('page', '1');
    if (kind === 'PLACE' && query.latitude !== undefined) {
      url.searchParams.set('x', String(query.longitude));
      url.searchParams.set('y', String(query.latitude));
      // Bias by the supplied position without excluding named destinations farther away.
      url.searchParams.set('sort', 'accuracy');
    }
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `KakaoAK ${key}` }, redirect: 'error', signal: requestSignal });
    } catch { fail('PLACES_UNAVAILABLE'); }
    if (!response.ok) fail('PLACES_UPSTREAM_ERROR');
    let raw;
    try { raw = await response.json(); }
    catch { fail(requestSignal.aborted ? 'PLACES_UNAVAILABLE' : 'PLACES_INVALID_DATA'); }
    return normalizeDocuments(raw, kind);
  };
  // Either search can still provide useful results if the other provider operation fails.
  const responses = await Promise.allSettled([request('keyword', 'PLACE'), request('address', 'ADDRESS')]);
  if (requestSignal.aborted) fail('PLACES_UNAVAILABLE');
  const candidates = responses.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  if (candidates.length === 0) {
    const failed = responses.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  const seen = new Set();
  const uniquePlaces = candidates.filter(place => {
    if (seen.has(place.providerPlaceId)) return false;
    seen.add(place.providerPlaceId);
    return true;
  });
  const places = uniquePlaces.slice(0, maxResults);
  const addressCandidate = uniquePlaces.find(place => place.kind === 'ADDRESS');
  // A street address can also match many businesses in the same building. Keep
  // the address itself selectable even when keyword matches fill every slot.
  if (addressCandidate && !places.some(place => place.kind === 'ADDRESS')) places[maxResults - 1] = addressCandidate;
  return { provider: 'kakao', places };
}

export function placeSearchError(error) {
  if (error?.message === 'PLACES_INVALID_QUERY') return [400, 'INVALID_QUERY'];
  if (error?.message === 'PLACES_NOT_CONFIGURED') return [503, 'PLACES_NOT_CONFIGURED'];
  if (['PLACES_UPSTREAM_ERROR', 'PLACES_INVALID_DATA'].includes(error?.message)) return [502, error.message];
  return [502, 'PLACES_UNAVAILABLE'];
}
