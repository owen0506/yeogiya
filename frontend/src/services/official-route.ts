import { getStationByName, stationPlatforms, type Station, type StationPlatform } from '../features/stations/stations';
import { interchangeName, stationAliases } from '../features/stations/network';
import type { JourneyRoute, RouteStep } from '../features/journey/route-service';

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('경로 데이터 형식이 올바르지 않습니다.');
  return value as Json;
}
function number(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') throw new Error('경로 수치가 누락되었습니다.');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('경로 수치가 올바르지 않습니다.');
  return parsed;
}
function platform(value: unknown): StationPlatform {
  const p = object(value);
  const raw = String(p.stnNm ?? '');
  const name = raw === '서울' ? '서울역' : stationAliases[raw] ?? raw;
  const station = getStationByName(name);
  const match = stationPlatforms.find((item) => item.stationId === station?.id && item.line === p.lineNm);
  if (!match) throw new Error('현재 앱에서 지원하지 않는 역·노선이 포함되어 있습니다.');
  return { ...match, branch: typeof p.brlnNm === 'string' && p.brlnNm.includes('지선') };
}
function time(value: unknown, day: number, minimum: number): number {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(value)) throw new Error('열차 시간표가 없습니다.');
  const [h, m, s] = value.split(':').map(Number);
  if (h > 47 || m > 59 || s > 59) throw new Error('열차 시각이 올바르지 않습니다.');
  let result = day + (h * 3600 + m * 60 + s) * 1000;
  if (result < minimum) result += 86400000;
  if (result < minimum || result - minimum > 12 * 3600000) throw new Error('열차 시간표가 검색 시각과 맞지 않습니다.');
  return result;
}

// 실제 조회한 구간별 시각을 사용합니다. reqHr 합계만 쓰면 중간역 정차 시간이 빠집니다.
export function parseOfficialRoute(value: unknown, from: Station, to: Station): JourneyRoute {
  const data = object(value), body = object(data.body);
  const searchedAt = String(data.searchedAt ?? ''), fetchedAt = String(data.fetchedAt ?? '');
  const searchTime = Date.parse(searchedAt);
  if (!Number.isFinite(searchTime) || !Number.isFinite(Date.parse(fetchedAt)) || body.schInclYn !== 'Y' || !Array.isArray(body.paths) || !body.paths.length || body.paths.length > 500) throw new Error('공식 시간표 경로를 확인할 수 없습니다.');
  const koreanDate = new Date(searchTime + 9 * 3600000).toISOString().slice(0, 10);
  const day = Date.parse(`${koreanDate}T00:00:00+09:00`);
  const steps: RouteStep[] = [];
  let start = 0, current = 0, meters = 0, transfers = 0;
  for (const value of body.paths) {
    const p = object(value), departure = platform(p.dptreStn), arrival = platform(p.arvlStn);
    if (!['Y', 'N'].includes(String(p.trsitYn)) || p.nonstopYn !== 'N') throw new Error('정차역을 확인할 수 없는 경로입니다.');
    const transfer = p.trsitYn === 'Y';
    const seconds = number(p.reqHr), wait = number(p.wtngHr), distance = number(p.stnSctnDstc);
    const previous = steps[steps.length - 1];
    if (previous && (previous.station.stationId !== departure.stationId || previous.station.line !== departure.line)) throw new Error('구간 연결이 맞지 않습니다.');
    if (transfer && departure.stationId !== arrival.stationId) throw new Error('환승역 정보가 맞지 않습니다.');
    if (!transfer && departure.line !== arrival.line) throw new Error('환승 정보가 누락되었습니다.');
    if (!steps.length) {
      if (transfer || departure.stationId !== from.id) throw new Error('출발역이 맞지 않습니다.');
      start = time(p.trainDptreTm, day, searchTime);
      current = start;
      steps.push({ station: departure, secondsFromStart: 0, transfer: false, distanceMeters: 0 });
    }
    if (transfer) {
      current += (seconds + wait) * 1000;
      transfers++;
    } else {
      const departureTime = time(p.trainDptreTm, day, current);
      current = time(p.trainArvlTm, day, departureTime);
      if (Math.abs((current - departureTime) / 1000 - seconds) > 1) throw new Error('구간 소요시간이 시간표와 맞지 않습니다.');
    }
    meters += distance;
    steps.push({ station: arrival, secondsFromStart: (current - start) / 1000, transfer, distanceMeters: distance });
  }
  const seconds = (current - start) / 1000;
  if (steps[steps.length - 1].station.stationId !== to.id || seconds <= 0 || seconds > 12 * 3600 || Math.abs(seconds - number(body.totalReqHr)) > 1 || meters !== number(body.totalDstc) || transfers !== number(body.trsitNmtm)) throw new Error('경로 합계가 구간 정보와 맞지 않습니다.');
  const first = object(body.paths[0]);
  return { steps, seconds, stops: steps.length - 1 - transfers, transfers, official: { distanceMeters: meters, departureAt: new Date(start).toISOString(), arrivalAt: new Date(current).toISOString(), searchedAt, fetchedAt, firstTrain: String(first.trainno ?? ''), destination: String(first.tmnlStnNm ?? '') } };
}

export async function getOfficialRoute(from: Station, to: Station, preference: 'fastest' | 'fewest-transfers', signal?: AbortSignal): Promise<JourneyRoute> {
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  if (!base) throw new Error('공식 경로 연결이 설정되지 않았습니다.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  try {
    const query = new URLSearchParams({ from: interchangeName(from.name), to: interchangeName(to.name), preference });
    const response = await fetch(`${base.replace(/\/$/, '')}/route?${query}`, { signal: controller.signal });
    if (!response.ok) throw new Error('공식 경로를 가져오지 못했습니다.');
    return parseOfficialRoute(await response.json(), from, to);
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
