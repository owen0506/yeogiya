import { createServer } from 'node:http';

// 개발용 중계 서버. 서울시 키는 프런트엔드에 전달하지 않습니다.
const port = Number(process.env.PORT || 8083);
const origin = process.env.FRONTEND_ORIGIN || 'http://localhost:8081';
const key = process.env.SEOUL_SUBWAY_API_KEY;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', origin);
  const reply = (status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); };
  if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: 'ORIGIN_NOT_ALLOWED' });
  if (req.method !== 'GET') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return reply(200, { configured: Boolean(key) });
  const endpoints = { '/arrivals': ['realtimeStationArrival', 'station'], '/positions': ['realtimePosition', 'line'] };
  const endpoint = endpoints[url.pathname];
  if (!endpoint) return reply(404, { error: 'NOT_FOUND' });
  const value = url.searchParams.get(endpoint[1])?.trim();
  if (!value || value.length > 50 || !/^[가-힣a-zA-Z0-9()·,\s]+$/.test(value)) return reply(400, { error: 'INVALID_QUERY' });
  if (!key) return reply(503, { error: 'API_KEY_NOT_CONFIGURED' });
  try {
    const response = await fetch(`http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(key)}/json/${endpoint[0]}/0/100/${encodeURIComponent(value)}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return reply(502, { error: 'UPSTREAM_ERROR' });
    reply(200, await response.json());
  } catch {
    // 원본 오류에는 키가 포함된 URL이 들어갈 수 있어 로그/응답에 노출하지 않습니다.
    reply(502, { error: 'UPSTREAM_UNAVAILABLE' });
  }
});
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Subway proxy ready on port ${port}; API key ${key ? 'configured' : 'not configured'}`));
