# 내부 fallback 경로 탐색

공식 API 요청·검증 성공 시 공식 경로를 그대로 사용합니다. 이 문서는 API 실패 시 사용하는 정적 다익스트라만 설명합니다.

## 보존한 구조

`StationPlatform`, 기존 station/platform ID, 성수·신도림의 `-branch` 노드, 응암 순환의 단방향 연결을 유지합니다. 간선의 `kind`는 `ride` 또는 `transfer`이며 기존 `transfer` boolean과 일치합니다. 비용 데이터는 연결망을 생성하거나 변경하지 않습니다.

출발역의 모든 후보 플랫폼은 비용 0으로 시작하고 도착역의 모든 후보 플랫폼을 목적지로 허용합니다. 기존 플랫폼 ID로 지정하는 호선 제한 동작도 유지합니다.

## 비용 공급

`frontend/src/features/journey/route-costs.ts`의 `RouteCostProvider`:

```ts
rideTime(fromPlatformId: string, toPlatformId: string): number;
transferTime(stationId: string, fromPlatformId: string, toPlatformId: string): number;
```

`createRouteCostProvider(primary, secondary)`에 정규화한 `RouteTimeData`를 넣습니다. 각 데이터는 `rides`와 `transfers` 목록으로 구성합니다. 모든 시간은 비음수 안전 정수(초)이며, 방향별 platform ID로 조회합니다. 환승에는 station ID도 사용해 같은 호선의 본선/지선 간 이동을 구분합니다.

우선순위는 별도 검증 데이터(primary), 선택적 검증 캐시(secondary), 기본값 순입니다. 없거나 수치가 잘못된 값은 다음 공급원으로 넘어갑니다. 기본값은 주행 120초·환승 300초이며 탐색 코드는 이 상수를 알지 못합니다. 생성 시 데이터를 복사하여 한 탐색 동안 가중치가 바뀌지 않게 합니다. 사용자 정의 provider도 탐색 중 같은 입력에 같은 값을 반환해야 합니다.

```ts
const provider = createRouteCostProvider({
  rides: [
    { fromPlatformId: 'mock-2-gangnam', toPlatformId: 'mock-2-yeoksam', seconds: 90 },
    { fromPlatformId: 'mock-2-yeoksam', toPlatformId: 'mock-2-gangnam', seconds: 110 },
  ],
});
findRoute(fromId, toId, 'fastest', provider);
```

위 수치는 주입 방법을 보여주는 예시이며 운영 데이터가 아닙니다. 현재 별도 검증 데이터셋/API는 연결하지 않았고 공식 응답 캐시도 수집하지 않습니다. 기본 앱 호출은 빈 provider를 사용하므로 120초·300초가 적용됩니다. 테스트 응답 파일은 운영 시간 데이터로 사용하지 않습니다.

향후 연결은 외부 API → backend에서 검증·정규화 → frontend에서 ID 매핑·provider 생성 순서입니다. provider에는 인증키나 외부 API 응답 형식을 넣지 않습니다. 데이터 출처·유효기간 검증은 공급 계층에서 수행해야 합니다. 실제 데이터를 UI에 연결할 때 기본값 사용 여부에 맞는 안내 문구도 함께 갱신해야 합니다.

## 탐색 기준과 결과

- 빠른 경로: `totalSeconds` 최소화.
- 최소 환승: `(transferCount, totalSeconds)` 사전식 비교. 임의의 환승 가중치는 없습니다.
- 다음 노드 선택과 relaxation 모두 `compareRouteCosts`를 사용합니다.
- 주행시간 + 환승 이동시간만 계산합니다. 열차 대기·실시간 지연은 포함하지 않습니다.
- 반환하는 `steps`, `secondsFromStart`, `transfer`, `seconds`, `stops`, `transfers`는 기존 형식을 유지합니다. 색상 바·환승역 통합·알림은 기존 계산을 사용합니다.

현재 `findRoute`는 연결망과 비용을 공통 `average-route-engine.ts`의 Node/Edge로 변환하고, 다중 시작·도착 플랫폼을 지원하는 우선순위 큐 탐색을 호출합니다. 빠른 경로와 최소 환승은 기존 비교 기준을 유지합니다. 이 평균 엔진은 대기시간을 `null`로 반환합니다.

운행일별 Trip/StopTime이 공급되면 별도 `timetable-engine.ts`가 절대시각으로 다음 탑승편과 대기시간을 계산합니다. `timetable-plan.ts`가 결과를 화면용 버스·지하철·대기·환승·도보 구간으로 변환합니다. 현재 전체 운행 시간표 데이터는 연결하지 않았으므로 앱의 공식 경로 실패 시에는 평균 엔진을 사용합니다. 선택한 실시간 차량에 맞춘 후속 여정 자동 재탐색은 아직 없습니다.

검증: `cd frontend` 후 `npm run typecheck`, `npm test`. 테스트에는 방향별 시간, 데이터 우선순위·누락·유효성, 시간에 따른 경로 변경, 최소 환승 동률 비교, 큰 시간 차이, 본선/지선, 단방향 순환, 다중 시작·도착, 누적 시간·색상 바·알림 계약이 포함됩니다.
