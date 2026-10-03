# 여기야 · 대중교통 하차 알림

출발역과 내릴 역을 검색한 뒤, 여정의 구간별 색상 막대에서 실제로 탈 열차를 고르고 하차 알림을 설정하는 Expo 앱입니다. 기존 메인 초록색은 유지하고, 막대와 차량 위치에는 지하철 호선·버스 종류의 색을 사용합니다.

## 현재 사용 흐름

1. 하단 **길찾기**에서 출발역과 도착역을 고릅니다.
2. **내 여정**에서 이동 시간 비율에 따른 색상 막대나 구간 카드를 누릅니다.
3. 승차역 앞뒤의 실시간 열차를 확인하고 **탈 예정** 또는 **지금 타고 있어요**를 선택합니다.
4. 선택한 열차 아래에서 하차 몇 역 전 알릴지 정합니다. 설정한 알림은 하단 **알림**에서 확인·취소합니다.

현재 검색 화면은 지하철역을 대상으로 합니다. 공식 경로 API를 우선 사용하고, 연결되지 않으면 평균 구간시간 기반의 임시 경로를 표시합니다. 첫 탑승 대기시간과 선택한 차량의 실제 운행이 경로와 일치하는지는 별도로 확인해야 합니다. 실시간 위치와 도착 정보가 있을 때만 차량 후보를 표시하며, 이후 지연에 맞춰 알림 시각을 자동 변경하지 않습니다. 동시에 켤 수 있는 알림은 하나입니다.

버스·지하철 공통 Node/Edge 평균 그래프와 Trip/StopTime 시간표 탐색 엔진, 버스 실시간 차량 위치 조회 기반을 추가했습니다. **버스가 포함된 실제 경로 검색**에는 버스 정류장·운행 시간표와 지하철 환승 연결 데이터 적재가 더 필요합니다. 현재 검색 결과에 버스 구간을 임의로 만들어 표시하지 않습니다.

## 로컬 실행

Node.js 22.13 이상이 필요합니다.

```sh
cd frontend
npm install
npm run web
```

웹 미리보기의 기본 주소는 `http://localhost:8081`입니다. 실시간 차량과 공식 경로를 조회하려면 [백엔드 설정](backend/README.md)에 따라 개발용 중계 서버도 실행합니다. 두 서버의 포트를 바꾸면 `frontend/.env`의 `EXPO_PUBLIC_SUBWAY_API_BASE_URL`과 백엔드의 `FRONTEND_ORIGIN`을 맞춰야 합니다. API 키는 중계 서버에서만 사용합니다.

```sh
cd backend
node --env-file=.env seoul-proxy.mjs
```

## 확인

```sh
cd frontend
npm test
npm run typecheck
npx expo export --platform web
node scripts/test-journey-engine.cjs
node scripts/test-timetable-engine.cjs
node scripts/test-timetable-plan.cjs
node scripts/test-average-route-engine.cjs
```

앱 구조와 데이터 범위는 [프런트엔드 안내](frontend/README.md), 공식 경로의 제한은 [공식 경로 연동](docs/official-routes.md)을 참고하세요. 웹 탭을 닫거나 기기가 절전 상태에 들어가면 알림이 지연될 수 있습니다. 네이티브 알림의 백그라운드 동작은 실기기 검증이 필요합니다.
