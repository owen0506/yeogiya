import { createRouteCostProvider, defaultRouteCostProvider, type RideTimeRecord } from '../features/journey/route-costs';
import { getRideGraph } from '../features/journey/route-service';

export async function loadSegmentTimes(signal?: AbortSignal) {
  const base = process.env.EXPO_PUBLIC_SUBWAY_API_BASE_URL;
  if (!base) return defaultRouteCostProvider;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 5000);
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/segment-times`, { signal: controller.signal });
    if (!response.ok) return defaultRouteCostProvider;
    const data = await response.json();
    if (data?.version !== 1 || !Array.isArray(data.rides) || data.rides.length > 10000) return defaultRouteCostProvider;
    const edges = new Set(getRideGraph().rides.map(e => JSON.stringify([e.from, e.to])));
    const rides: RideTimeRecord[] = data.rides.filter((row: RideTimeRecord | null) => row && Number.isSafeInteger(row.seconds) && row.seconds > 0 && edges.has(JSON.stringify([row.fromPlatformId, row.toPlatformId])));
    return createRouteCostProvider({ rides });
  } catch { return defaultRouteCostProvider; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
