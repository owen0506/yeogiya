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
- `GET /route?from=금정&to=이수&preference=fastest`: 서울교통공사 최단경로·거리·시간표. `fewest-transfers`로 최소 환승을 조회합니다. 서버의 현재 한국 시각으로 검색하며 첫 열차 탑승 전 대기는 소요시간에서 제외합니다.
- `GET /bus-vehicles?cityCode=23&routeId=ICB161000002&nearSequence=12`: 해당 TAGO 노선에서 정류장 순번 12의 앞뒤 8개 순번 안에 현재 보고된 버스를 조회합니다. `TAGO_BUS_API_KEY`와 `TAGO_BUS_LOCATION_ENDPOINT`만 설정하면 됩니다. `vehicles`는 `providerId`, `cityCode`, `routeId`, `vehicleNumber`, `stopId`, `stopSequence`, 위도·경도를 담고, 응답에는 `fetchedAt`, `sequenceRange`, `coverage`가 함께 옵니다. `coverage.partial`은 TAGO 결과를 모두 받지 못했거나 근처 차량 목록이 30건으로 잘렸을 때 참입니다. 최대 100건씩 3페이지를 조회하며 결과가 없으면 빈 배열을 반환합니다. `vehicleNumber`는 현재 보고된 실차 번호이며 시간표의 Trip ID가 아닙니다.
- 인증키 미설정: 503, 입력 오류: 400, 외부 연결/응답 오류: 502

키는 `.env`에만 보관합니다. 기본적으로 localhost에서만 수신합니다.
전체 설정은 [개발 계획](../docs/development-plan.md)을 참고하세요.

공식 경로는 `SUBWAY_API_KEY`를 사용합니다. 인증키를 `EXPO_PUBLIC_` 변수로 만들지 마세요. TAGO 차량 위치는 후보 표시용이며 현재 경로 계산에는 사용하지 않습니다. 상세 기준은 [공식 경로 연동](../docs/official-routes.md)을 참고하세요.
