import { useEffect, useState } from 'react';
import { searchPlaces } from '../../services/places';
import type { Place } from './types';

type SearchState = {
  query: string;
  retry: number;
  active: boolean;
  places: readonly Place[];
  loading: boolean;
  error: string | null;
};

export function usePlaceSearch(query: string, enabled: boolean) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<SearchState>({ query: '', retry: 0, active: false, places: [], loading: false, error: null });
  const term = query.trim();
  const searchable = enabled && term.length >= 2 && term.length <= 100;
  useEffect(() => {
    if (!searchable) {
      setState({ query, retry, active: false, places: [], loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    let current = true;
    setState({ query, retry, active: true, places: [], loading: true, error: null });
    const timer = setTimeout(() => {
      void searchPlaces(term, controller.signal).then(places => {
        if (current) setState({ query, retry, active: true, places, loading: false, error: null });
      }).catch(error => {
        if (!current || controller.signal.aborted) return;
        setState({ query, retry, active: true, places: [], loading: false,
          error: error instanceof Error ? error.message : '장소 검색을 완료하지 못했어요. 다시 검색해주세요.' });
      });
    }, 350);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [query, term, searchable, retry]);
  // Hide earlier results immediately, before the cleanup/effect runs after a new keystroke.
  const matches = searchable && state.active && state.query === query && state.retry === retry;
  return {
    places: matches ? state.places : [],
    loading: searchable && (!matches || state.loading),
    error: matches ? state.error : null,
    retry: () => setRetry(value => value + 1),
  };
}
