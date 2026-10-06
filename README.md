# 여기야 · 대중교통 하차 알림

역·학교·아파트·주소 또는 내 위치를 출발지와 목적지로 고른 뒤, 여정의 구간별 색상 막대에서 실제로 탈 차량을 고르고 하차 알림을 설정하는 Expo 앱입니다. 기존 메인 초록색은 유지하고, 막대와 차량 위치에는 지하철 호선·버스 종류의 색을 사용합니다.

## 현재 사용 흐름

1. 하단 **길찾기**에서 역·장소·주소를 검색하거나 **내 위치**를 눌러 출발지와 목적지를 고릅니다.
2. **내 여정**에서 이동 시간 비율에 따른 색상 막대나 구간 카드를 누릅니다.
3. 승차역 앞뒤의 실시간 열차를 확인하고 **탈 예정** 또는 **지금 타고 있어요**를 선택합니다.
4. 선택한 열차 아래에서 하차 몇 역 전 알릴지 정합니다. 설정한 알림은 하단 **알림**에서 확인·취소합니다.

장소·주소 검색은 카카오 Local API를 서버에서 호출합니다. 장소의 좌표와 주변 역을 연결하고, 목적지 주변 역 최대 3곳의 경로를 마지막 도보 추정시간까지 포함해 비교합니다. 장소 검색 범위와 실제 경로를 안내할 수 있는 교통망 범위는 다릅니다. 검색 및 연결 기준은 [장소 검색 안내](docs/place-search.md)를 참고하세요.

지하철은 공식 경로 API를 우선 사용하고, 연결되지 않으면 평균 구간시간 기반의 임시 경로를 표시합니다. 군포 버스는 30·31번을 시범 연결해 도보·실시간 승차 대기·거리 기반 버스 이동 추정·지하철을 비교합니다. 시간표와 선택한 실제 차량의 운행이 일치하는지는 별도로 확인해야 합니다. 이후 지연에 맞춰 알림 시각을 자동 변경하지 않으며 동시에 켤 수 있는 알림은 하나입니다.

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
