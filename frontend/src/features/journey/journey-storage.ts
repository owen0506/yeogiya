import { getStation } from '../stations/stations';

export type SavedJourney = { fromId: string; toId: string };
export function sanitizeJourneys(value: unknown): SavedJourney[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): SavedJourney[] => {
    if (!item || typeof item !== 'object' || typeof item.fromId !== 'string' || typeof item.toId !== 'string') return [];
    const from = getStation(item.fromId), to = getStation(item.toId);
    if (!from || !to || from.id === to.id) return [];
    const key = `${from.id}/${to.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ fromId: from.id, toId: to.id }];
  }).slice(0, 8);
}

export function loadJourneys(kind: 'saved' | 'recent'): SavedJourney[] {
  try { return sanitizeJourneys(JSON.parse(localStorage.getItem(`yeogiya-${kind}`) ?? '[]')); } catch { return []; }
}

export function storeJourneys(kind: 'saved' | 'recent', journeys: SavedJourney[]) {
  try { localStorage.setItem(`yeogiya-${kind}`, JSON.stringify(journeys)); } catch { /* 네이티브 및 저장소 제한 환경에서는 현재 세션의 React 상태를 유지합니다. */ }
}
