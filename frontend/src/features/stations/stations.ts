import { networkSegments, stationAliases } from './network';

export type Station = {
  id: string;
  name: string;
  line: string;
  branch?: boolean;
};

// UI 개발용 일부 역 데이터입니다. ID는 공식 API 역 코드가 아닙니다.
export const mockStations: readonly Station[] = [
  { id: 'mock-1-seoul', name: '서울역', line: '1호선' },
  { id: 'mock-4-seoul', name: '서울역', line: '4호선' },
  { id: 'mock-1-cityhall', name: '시청', line: '1호선' },
  { id: 'mock-2-cityhall', name: '시청', line: '2호선' },
  { id: 'mock-1-jonggak', name: '종각', line: '1호선' },
  { id: 'mock-1-jongno3', name: '종로3가', line: '1호선' },
  { id: 'mock-3-jongno3', name: '종로3가', line: '3호선' },
  { id: 'mock-5-jongno3', name: '종로3가', line: '5호선' },
  { id: 'mock-2-hongik', name: '홍대입구', line: '2호선' },
  { id: 'mock-2-sinchon', name: '신촌', line: '2호선' },
  { id: 'mock-2-ewha', name: '이대', line: '2호선' },
  { id: 'mock-2-gangnam', name: '강남', line: '2호선' },
  { id: 'mock-sinbundang-gangnam', name: '강남', line: '신분당선' },
  { id: 'mock-2-yeoksam', name: '역삼', line: '2호선' },
  { id: 'mock-2-seolleung', name: '선릉', line: '2호선' },
  { id: 'mock-2-samseong', name: '삼성', line: '2호선' },
  { id: 'mock-2-jamsil', name: '잠실', line: '2호선' },
  { id: 'mock-8-jamsil', name: '잠실', line: '8호선' },
  { id: 'mock-2-sadang', name: '사당', line: '2호선' },
  { id: 'mock-4-sadang', name: '사당', line: '4호선' },
  { id: 'mock-3-express', name: '고속터미널', line: '3호선' },
  { id: 'mock-7-express', name: '고속터미널', line: '7호선' },
  { id: 'mock-9-express', name: '고속터미널', line: '9호선' },
  { id: 'mock-5-yeouido', name: '여의도', line: '5호선' },
  { id: 'mock-9-yeouido', name: '여의도', line: '9호선' },
];

// 기존 저장값과 테스트 ID를 유지하면서 검색 가능한 역을 연결망 전체로 확장합니다.
export const stations: readonly Station[] = [...new Map(networkSegments.flatMap((segment) => segment.names.map((name) => {
  const station = mockStations.find((item) => item.name === name && item.line === segment.line)
    ?? { id: `seoul-${segment.line}-${name}`, name, line: segment.line };
  return [station.id, station] as const;
}))).values()];

function normalize(value: string) {
  return value.normalize('NFC').replace(/\s/g, '').toLowerCase();
}

export function searchStations(query: string, line?: string): readonly Station[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  // '역삼' 같은 실제 역명은 유지하면서 '강남역' 검색도 지원합니다.
  const rawTerm = normalized.length > 1 && normalized.endsWith('역')
    ? normalized.slice(0, -1)
    : normalized;
  const term = stationAliases[rawTerm] ?? rawTerm;
  return stations.filter((station) => (!line || station.line === line) && normalize(station.name).includes(term));
}

export type StationFieldValue = { query: string; station: Station | null };
