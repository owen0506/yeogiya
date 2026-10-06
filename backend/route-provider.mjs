const allowedBase = 'https://apis.data.go.kr/B553766/path2';

export function koreaTime(date = new Date()) {
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

// The optional search time must be a complete ISO instant, never a locale date.
// Both UTC and the app's Korean time zone are supported without JS date rollover.
export function parseRouteDepartureAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+09:00)$/.test(value)) {
    throw new Error('ROUTE_API_INVALID_DEPARTURE_AT');
  }
  const date = new Date(value);
  const offset = value.endsWith('+09:00') ? 9 * 3600000 : 0;
  if (!Number.isFinite(date.valueOf()) || new Date(date.valueOf() + offset).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error('ROUTE_API_INVALID_DEPARTURE_AT');
  }
  return date;
}

export async function fetchOfficialRoute({ from, to, preference = 'fastest', departureAt }, env, fetcher = fetch, now = new Date()) {
  const searchTime = departureAt === undefined ? now : parseRouteDepartureAt(departureAt);
  if (!(searchTime instanceof Date) || !Number.isFinite(searchTime.valueOf())) throw new Error('ROUTE_API_INVALID_DEPARTURE_AT');
  if (!env.SUBWAY_API_KEY) throw new Error('ROUTE_API_NOT_CONFIGURED');
  const base = (env.SUBWAY_API_BASE_URL || allowedBase).replace(/\/$/, '');
  if (base !== allowedBase) throw new Error('ROUTE_API_INVALID_ENDPOINT');
  let key = env.SUBWAY_API_KEY;
  try { if (/%[0-9a-f]{2}/i.test(key)) key = decodeURIComponent(key); } catch { throw new Error('ROUTE_API_NOT_CONFIGURED'); }
  const searchedAt = searchTime.toISOString();
  const url = new URL(`${base}/getShtrmPath2`);
  url.search = new URLSearchParams({ serviceKey: key, dataType: 'JSON', dptreStn: from, arvlStn: to, searchDt: koreaTime(searchTime), searchType: preference === 'fewest-transfers' ? 'transfer' : 'duration', schInclYn: 'Y', stationValueType: 'name' }).toString();
  let payload;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error();
    payload = await response.json();
  } catch { throw new Error('ROUTE_API_UNAVAILABLE'); }
  if (!['00', '0'].includes(String(payload?.header?.resultCode))) throw new Error('ROUTE_API_NO_RESULT');
  const body = payload.body;
  if (!body || !Array.isArray(body.paths) || !body.paths.length || body.paths.length > 500) throw new Error('ROUTE_API_INVALID_DATA');
  // 외부 오류나 인증정보를 그대로 전달하지 않고 공개 경로 필드만 반환합니다.
  const station = (value) => ({ stnNm: value?.stnNm, lineNm: value?.lineNm, stnCd: value?.stnCd, brlnNm: value?.brlnNm });
  return { searchedAt, fetchedAt: new Date().toISOString(), source: 'seoul-metro', body: {
    totalDstc: body.totalDstc, totalReqHr: body.totalReqHr, trsitNmtm: body.trsitNmtm, schInclYn: body.schInclYn,
    paths: body.paths.map((p) => ({ dptreStn: station(p.dptreStn), arvlStn: station(p.arvlStn), stnSctnDstc: p.stnSctnDstc, reqHr: p.reqHr, wtngHr: p.wtngHr, trainDptreTm: p.trainDptreTm, trainArvlTm: p.trainArvlTm, trsitYn: p.trsitYn, nonstopYn: p.nonstopYn, etrnYn: p.etrnYn, trainno: p.trainno, tmnlStnNm: p.tmnlStnNm })),
  } };
}
