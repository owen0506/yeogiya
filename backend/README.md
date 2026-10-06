# 서울시 API 개발용 중계 서버

추가 패키지 없이 Node.js로 실행합니다. Spring Boot 도입 전 사용할 로컬 개발 서버입니다.

```powershell
Copy-Item .env.example .env
# .env의 SEOUL_SUBWAY_API_KEY 설정 후
node --env-file=.env seoul-proxy.mjs
```

`node seoul-proxy.mjs`는 `frontend/.env`, `backend/.env`, 실행 환경 순으로 설정을 읽습니다(뒤의 값 우선). 기존 프런트엔드 폴더의 비공개 키도 서버에서만 사용합니다. `/health`의 `configured`는 실시간 API, `routesConfigured`는 최단경로 API 키의 설정 여부입니다.

- `GET /arrivals?station=강남`: 서울시 실시간 도착정보 원본 JSON
- `GET /positions?line=2호선`: 서울시 실시간 열차 위치정보 원본 JSON
- `GET /route?from=금정&to=이수&preference=fastest`: 서울교통공사 최단경로·거리·시간표. `fewest-transfers`로 최소 환승을 조회합니다. 선택적인 `departureAt`에 UTC 또는 한국 시간대의 완전한 ISO 시각을 전달하면 해당 미래 시각으로 조회합니다. 미지정 시 서버의 현재 한국 시각으로 검색하며 첫 열차 탑승 전 대기는 소요시간에서 제외합니다. 군포 연결 엔진은 별도 대기 구간을 더합니다.
- `GET /bus-vehicles?cityCode=23&routeId=ICB161000002&nearSequence=12`: 해당 TAGO 노선에서 정류장 순번 12의 앞뒤 8개 순번 안에 현재 보고된 버스를 조회합니다. `TAGO_BUS_API_KEY`와 `TAGO_BUS_LOCATION_ENDPOINT`만 설정하면 됩니다. `vehicles`는 `providerId`, `cityCode`, `routeId`, `vehicleNumber`, `stopId`, `stopSequence`, 위도·경도를 담고, 응답에는 `fetchedAt`, `sequenceRange`, `coverage`가 함께 옵니다. `coverage.partial`은 TAGO 결과를 모두 받지 못했거나 근처 차량 목록이 30건으로 잘렸을 때 참입니다. 최대 100건씩 3페이지를 조회하며 결과가 없으면 빈 배열을 반환합니다. `vehicleNumber`는 현재 보고된 실차 번호이며 시간표의 Trip ID가 아닙니다.
- 인증키 미설정: 503, 입력 오류: 400, 외부 연결/응답 오류: 502

`/bus-vehicles`에 `toSequence`를 추가하면 `nearSequence`의 8개 정류장 전부터 지정한 하차 순번까지 반환합니다. 미지정 시 기존 앞뒤 8개 범위를 유지합니다. 군포 앱은 원승차 순번과 하차 순번을 전달해 탑승한 버스가 8개 정류장 이상 이동해도 하차 전까지 표시합니다.

## 군포 시범 연결

- `GET /gunpo-bus-network`: 실제 TAGO 조회로 저장한 군포 30·31번의 노선 ID, 정류장 ID·좌표·방문 순번을 반환합니다. 전체 순서를 보존하며 없는 방향코드·평균시간을 만들지 않습니다.
- `GET /bus-arrivals?cityCode=31160&stopId=GGB225000047`: 시범 노선에 있는 정류장만 조회하고 30·31번의 노선별 ETA를 반환합니다. 20초 캐시와 같은 정류장의 동시 요청 병합을 사용합니다. 최대 100건씩 3페이지이며 잘못된 페이지·부분 응답은 실패 처리합니다. 차량 번호나 Trip ID를 ETA에 연결하지 않습니다.
- 군포 `/bus-vehicles`는 시범 노선 ID로 제한됩니다. 실제 차량 위치를 30초마다 확인하는 앱 조회에 사용합니다.

기존 서버 전용 `TAGO_BUS_API_KEY`, `TAGO_BUS_ARRIVAL_ENDPOINT`, `TAGO_BUS_LOCATION_ENDPOINT` 설정을 사용합니다. 정류장 전체 순서 갱신은 `node scripts/capture-gunpo-bus.mjs`로 수동 실행하며, `TAGO_BUS_ROUTE_ENDPOINT`와 `TAGO_BUS_STOP_ENDPOINT`도 필요합니다. 공개 필드만 파일에 저장하고 인증키·인증 URL은 저장하지 않습니다. 과거 도착·위치 fixture는 테스트에만 사용합니다.

상세 범위와 거리 기반 시간 모델은 [군포 버스 시범 연결](../docs/gunpo-bus-pilot.md)에 기록합니다. 백엔드 코드를 바꾼 후에는 서버를 다시 실행해야 합니다.

```powershell
node --test test-gunpo-bus.mjs test-bus-vehicles.mjs test-route-provider.mjs test-tago-bus.mjs
```

키는 `.env`에만 보관합니다. 기본적으로 localhost에서만 수신합니다.
전체 설정은 [개발 계획](../docs/development-plan.md)을 참고하세요.

공식 경로는 `SUBWAY_API_KEY`를 사용합니다. 인증키를 `EXPO_PUBLIC_` 변수로 만들지 마세요. 군포 최초 검색은 정류장 도착정보와 추정 이동시간을 사용하며, 실차 선택 뒤에는 그 차량 위치로 남은 시간을 추정합니다. 상세 기준은 [공식 경로 연동](../docs/official-routes.md)을 참고하세요.
