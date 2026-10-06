import type { Place } from '../features/places/types';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
class PlaceSearchError extends Error {}
const invalid = () => new PlaceSearchError('장소 검색 결과를 확인하지 못했어요. 다시 검색해주세요.');
const cancelled = () => Object.assign(new Error('장소 검색이 취소됐어요.'), { name: 'AbortError' });

export function parsePlaceSearchResponse(value: unknown): readonly Place[] {
  if (!record(value) || value.provider !== 'kakao' || !Array.isArray(value.places) || value.places.length > 10) throw invalid();
  const ids = new Set<string>();
  return value.places.map((place): Place => {
    if (!record(place) || place.provider !== 'kakao' || !text(place.providerPlaceId, 200)
      || !text(place.name, 500) || !text(place.address, 500) || !['PLACE', 'ADDRESS'].includes(String(place.kind))
      || typeof place.latitude !== 'number' || !Number.isFinite(place.latitude) || Math.abs(place.latitude) > 90
      || typeof place.longitude !== 'number' || !Number.isFinite(place.longitude) || Math.abs(place.longitude) > 180
      || (place.category !== undefined && !text(place.category, 300))) throw invalid();
    const id = `${place.kind}:${place.providerPlaceId.trim()}`;
    if (ids.has(id)) throw invalid();
    ids.add(id);
    // Keep only display/coordinate fields; never retain arbitrary server data.
    return {
      provider: 'kakao', providerPlaceId: place.providerPlaceId.trim(), name: place.name.trim(), address: place.address.trim(),
      latitude: place.latitude, longitude: place.longitude, kind: place.kind as Place['kind'],
      ...(place.category === undefined ? {} : { category: place.category.trim() }),
    };
  });
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<readonly Place[]> {
  const term = query.trim();
  if (term.length < 2 || term.length > 100) throw new PlaceSearchError('장소 이름이나 주소를 2~100자로 입력해주세요.');
  if (signal?.aborted) throw cancelled();
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL?.trim().replace(/\/+$/, '');
  if (!base) throw new PlaceSearchError('장소 검색 서버 주소가 설정되지 않았어요.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 10_000);
  try {
    const response = await fetch(`${base}/places/search?${new URLSearchParams({ query: term })}`, { signal: controller.signal });
    if (signal?.aborted) throw cancelled();
    if (response.status === 404) throw new PlaceSearchError('장소 검색을 사용하려면 백엔드 서버를 다시 실행해주세요.');
    if (response.status === 503) throw new PlaceSearchError('장소 검색 설정을 확인해주세요. 역 이름 검색은 계속 사용할 수 있어요.');
    if (response.status === 429) throw new PlaceSearchError('검색 요청이 많아요. 잠시 후 다시 검색해주세요.');
    if (!response.ok) throw new PlaceSearchError('장소 검색 서버가 응답하지 못했어요. 잠시 후 다시 검색해주세요.');
    let data: unknown;
    try { data = await response.json(); } catch { throw invalid(); }
    if (signal?.aborted) throw cancelled();
    return parsePlaceSearchResponse(data);
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (timedOut) throw new Error('장소 검색이 지연되고 있어요. 다시 검색해주세요.');
    if (error instanceof PlaceSearchError) throw error;
    throw new Error('장소 검색 서버에 연결할 수 없어요. 서버와 Wi-Fi 연결을 확인해주세요.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
