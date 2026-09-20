import { stations } from '../stations/stations';

export type SavedJourney = { fromId: string; toId: string };
export function sanitizeJourneys(value: unknown): SavedJourney[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(stations.map((station) => station.id));
  const seen = new Set<string>();
  return value.filter((item): item is SavedJourney => {
    if (!item || typeof item !== 'object' || !ids.has(item.fromId) || !ids.has(item.toId) || item.fromId === item.toId) return false;
    const key = `${item.fromId}/${item.toId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8).map(({ fromId, toId }) => ({ fromId, toId }));
}

export function loadJourneys(kind: 'saved' | 'recent'): SavedJourney[] {
  try { return sanitizeJourneys(JSON.parse(localStorage.getItem(`yeogiya-${kind}`) ?? '[]')); } catch { return []; }
}

export function storeJourneys(kind: 'saved' | 'recent', journeys: SavedJourney[]) {
  try { localStorage.setItem(`yeogiya-${kind}`, JSON.stringify(journeys)); } catch { /* 네이티브 및 저장소 제한 환경에서는 현재 세션의 React 상태를 유지합니다. */ }
}
