export type Arrival = {
  trainId: string;
  lineId: string;
  direction: string;
  destination: string;
  message: string;
  seconds: number | null;
  receivedAt: string;
};

export const lineIds: Record<string, string> = {
  '1호선': '1001', '2호선': '1002', '3호선': '1003', '4호선': '1004',
  '5호선': '1005', '6호선': '1006', '7호선': '1007', '8호선': '1008', '9호선': '1009', '신분당선': '1077',
};

export function parseArrivals(payload: unknown, line: string, now = Date.now()): Arrival[] {
  if (!payload || typeof payload !== 'object') throw new Error('실시간 응답 형식이 올바르지 않습니다.');
  const data = payload as { errorMessage?: { code?: string }; realtimeArrivalList?: unknown };
  const code = data.errorMessage?.code;
  if (code === 'INFO-200') return [];
  if (code && code !== 'INFO-000') throw new Error('서울시 API가 오류를 반환했습니다. 인증키와 이용 한도를 확인해주세요.');
  if (!Array.isArray(data.realtimeArrivalList)) throw new Error('실시간 도착 목록을 읽을 수 없습니다.');
  return data.realtimeArrivalList.flatMap((value): Arrival[] => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if (String(row.subwayId) !== lineIds[line] || typeof row.recptnDt !== 'string') return [];
    const received = Date.parse(row.recptnDt.replace(' ', 'T') + '+09:00');
    // 3분 이상 지난 정보는 실제 위치처럼 표시하지 않습니다.
    if (!Number.isFinite(received) || now - received > 180_000 || received - now > 60_000) return [];
    const seconds = row.barvlDt === '' || row.barvlDt == null ? NaN : Number(row.barvlDt);
    return [{
      trainId: String(row.btrainNo ?? ''), lineId: String(row.subwayId),
      direction: String(row.updnLine ?? ''), destination: String(row.trainLineNm ?? ''),
      message: String(row.arvlMsg2 ?? ''), receivedAt: row.recptnDt,
      seconds: Number.isFinite(seconds) && seconds >= 0 ? Math.max(0, seconds - Math.max(0, Math.floor((now - received) / 1000))) : null,
    }];
  });
}

export async function getArrivals(station: string, line: string, signal?: AbortSignal): Promise<Arrival[]> {
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  if (!base) throw new Error('실시간 API가 설정되지 않았습니다. 예상 시간 알림은 사용할 수 있어요.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/arrivals?station=${encodeURIComponent(station)}`, { signal: controller.signal });
    if (!response.ok) throw new Error('실시간 정보를 가져오지 못했습니다. 중계 서버와 인증키 설정을 확인해주세요.');
    return parseArrivals(await response.json(), line);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('실시간 요청이 취소되었거나 제한 시간을 초과했습니다.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
