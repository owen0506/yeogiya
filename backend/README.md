# 서울시 API 개발용 중계 서버

추가 패키지 없이 Node.js로 실행합니다. Spring Boot 도입 전 사용할 로컬 개발 서버입니다.

```powershell
Copy-Item .env.example .env
# .env의 SEOUL_SUBWAY_API_KEY 설정 후
node --env-file=.env seoul-proxy.mjs
```

키 없이 실행: `node seoul-proxy.mjs`. `/health`로 설정 여부를 확인합니다.

- `GET /arrivals?station=강남`: 서울시 실시간 도착정보 원본 JSON
- `GET /positions?line=2호선`: 서울시 실시간 열차 위치정보 원본 JSON
- 인증키 미설정: 503, 입력 오류: 400, 외부 연결/응답 오류: 502

키는 `.env`에만 보관합니다. 기본적으로 localhost에서만 수신합니다.
전체 설정은 [개발 계획](../docs/development-plan.md)을 참고하세요.
