# 여기야 프런트엔드

Expo SDK 57 · React Native · TypeScript. 추가 UI/지도 서비스 의존성 없이 웹·iOS·Android 공용 화면을 구성합니다.

## 주요 파일

- `src/features/journey/home-screen.tsx`: 역 검색과 `길찾기 / 내 여정 / 알림` 하단 메뉴.
- `src/features/journey/route-result-screen.tsx`: 구간 시간 비율 막대, 차량 선택, 선택 차량별 하차 알림 설정.
- `src/features/journey/route-service.ts`: 기존 지하철 연결망과 비용 공급자를 공통 평균 그래프 엔진에 연결하는 어댑터.
- `src/features/transit/journey-plan.ts`: 경로를 승차·환승·도보 구간으로 분리하고 선택 차량을 구간에 연결.
- `src/features/transit/average-route-engine.ts`: 지하철·버스 공통 Node/Edge의 평균시간 탐색. 대기시간은 알 수 없음으로 유지.
- `src/features/transit/timetable-engine.ts`: 실제 Trip/StopTime을 공급받았을 때의 출발시각별 최초 도착 탐색.
- `src/features/transit/timetable-plan.ts`: 시간표 탐색 결과를 버스·지하철·대기·환승·도보 JourneyPlan으로 변환. RouteResultScreen의 `plan` 입력으로 표시할 수 있습니다.
- `src/services/subway-vehicle-candidates.ts`, `src/services/bus-vehicles.ts`: 실시간 위치·도착 정보에서 선택 가능한 차량 후보 구성.
- `src/features/stations/network.ts`: 노선 색상, 역 순서, 지선, 단방향 연결, 역명 별칭.
- `src/features/notifications/`: 플랫폼별 알림, 카운트다운, 화면 전체 하차 안내창.

## 로컬 노선망 범위

이 목록 밖의 수도권 노선은 검색되지 않습니다. 검색·선택에서는 환승역 하나에 여러 호선을 표시합니다.

| 노선 | 지원 구간 |
| --- | --- |
| 1 | 연천–신창, 구로–인천, 금천구청–광명, 병점–서동탄 |
| 2 | 순환 본선, 성수–신설동, 신도림–까치산 |
| 3 | 대화–오금 |
| 4 | 진접–오이도 |
| 5 | 방화–하남검단산, 강동–마천 |
| 6 | 응암 순환(단방향), 응암–신내 |
| 7 | 장암–석남 |
| 8 | 별내–모란 |
| 9 | 개화–중앙보훈병원, 일반열차만 |
| 신분당 | 신사–광교 |

역 ID는 앱 내부 식별자이며 공식 API 역 코드가 아닙니다. 기존 `mock-`/`seoul-` 호선별 저장 ID는 통합 역 ID로 복원합니다.
`총신대입구(이수)`/`이수`는 `이수(총신대입구)` 하나로, 금정은 1·4호선을 가진 하나의 역으로 표시합니다.
`당고개`/`뚝섬유원지` 검색도 새 역명으로 연결합니다. 상세 기준과 참고 자료는 [역 데이터 안내](../docs/station-data.md)에 기록합니다.
공식 경로 조회를 우선하고 거리·정차·환승 대기를 반영합니다. 설정과 제한은 [공식 경로 연동](../docs/official-routes.md)을 참고하세요. 아래 시간 규칙은 API 실패 시 임시 예상값에만 적용합니다.
2호선 지선은 성수·신도림에서 환승 5분을 적용하되 해당 역 자체에서 출발·도착할 때는 제외합니다.
5호선 분기 간 이동처럼 열차 방면을 바꿔야 하는 경우 실제 대기 시간은 계산하지 않습니다.
노선망은 수작업으로 관리하는 프로토타입 데이터이며 운영기관의 실시간 노선 변경을 자동 반영하지 않습니다.

## 차량 선택과 알림

- 지하철은 실시간 도착·위치, 버스는 TAGO 차량 위치가 있는 구간에서만 실제 후보를 표시합니다. 번호가 같아도 추천 시간표의 Trip과 동일 운행인지 단정하지 않습니다.
- 버스·지하철의 색상은 경로 막대와 차량 위치에 적용하며 메인 초록색은 유지합니다. 도보·환승은 별도 중립색입니다.
- 시간 기반 단일 알림. 선택한 차량의 위치/도착 정보와 구간 예상시간으로 도착 1·2·3개 역 또는 정류장 전 예상 시점을 계산합니다. 이후 지연에 맞춰 자동 재계산하지 않습니다.
- 중복 예약 방지, 카운트다운, 취소, 종료, 웹 새로고침 후 예약 복원.
- 만료되면 현재 탭/화면에 관계없이 하차 안내창을 표시합니다.
- 웹의 화면 내 알림은 권한 없이 시작합니다. 브라우저 알림은 별도의 허용 버튼을 사용합니다.

현재 화면에서 검색 가능한 경로는 지하철뿐입니다. 버스 실시간 후보 API와 공통 경로 엔진은 준비되어 있으나, 실제 버스 시간표·정류장 그래프·지하철 연결 데이터를 공급하기 전까지 버스 경로는 표시하지 않습니다.

시간표 데이터의 내부 `routeId`와 `StopTime.sequence`는 실시간 API의 노선 ID·노선 정류장 순번과 별개입니다. `TimetablePlanCatalog`의 `providerRouteId`와 `tripStopSequences`로 명시적으로 연결해야 합니다. 매핑이 없으면 실시간 조회용 ID·순번을 비워 두며, 부분 운행이나 순환 노선의 Trip 순번을 제공자 순번으로 추정하지 않습니다.

## 확인 명령

```sh
npm run web
npm test
npm run typecheck
npx expo export --platform web
node scripts/test-journey-engine.cjs
node scripts/test-timetable-engine.cjs
node scripts/test-timetable-plan.cjs
node scripts/test-average-route-engine.cjs
node scripts/test-bus-vehicles.cjs
node scripts/test-alarm-context.cjs
```

## 수동 확인

1. 강남 → 시청 검색 후 막대 너비가 구간 시간 비율을 반영하고 2·4·1호선 색이 서로 다른지 확인.
2. 지하철 구간을 열어 승차역 앞뒤의 실시간 열차를 고르고 `탈 예정`·`지금 타고 있어요` 가능 여부를 확인.
3. 도착 예정 시간이 있는 열차를 선택하면 알림 기준역과 예상 시각이 아래에 나타나는지 확인.
4. 하단 `알림` 탭으로 이동했다가 돌아와도 선택 열차가 유지되는지 확인.
5. 중계 서버를 중지하면 실시간 차량 조회 오류가 표시되되 임시 경로 결과는 유지되는지 확인.
6. 너비 390px와 1440px에서 입력, 가로 정차역 스크롤, 하단 메뉴와 알림창 확인.
7. 실기기: 알림 권한 허용/거부, 소리, 백그라운드, 앱 재시작, 예약 취소 확인.

참고: [Expo SDK 57 알림](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/),
[서울시 지하철 도착 정보](https://data.seoul.go.kr/dataList/OA-12764/F/1/datasetView.do),
[불암산역 역명 안내](https://gil.seoul.go.kr/gil/view.do?key=2407100001&sc_gilNo=2).
