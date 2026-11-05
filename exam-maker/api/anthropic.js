// 학교 공용 키 중계 서버 (Vercel 함수)
// Vercel 프로젝트 환경 변수에 다음 두 개를 넣으면 켜진다.
//   ANTHROPIC_API_KEY : 학교(관리자)의 Anthropic API 키
//   SCHOOL_PASSWORD   : 선생님들께 알려 줄 비밀번호
// 키는 서버에만 있고 브라우저로 내려가지 않는다. 비용 한도는 Anthropic 콘솔의 월 사용 한도로 관리한다.

import { timingSafeEqual } from 'node:crypto';

const ALLOWED_PATHS = new Set(['v1/messages', 'v1/messages/count_tokens']);
const ALLOWED_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const MAX_BODY = 4.4 * 1024 * 1024; // Vercel 함수 요청 한도(4.5MB)보다 조금 작게

function apiError(status, type, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function samePassword(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function enabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.SCHOOL_PASSWORD);
}

export function GET() {
  return new Response(JSON.stringify({ enabled: enabled() }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function POST(request) {
  if (!enabled()) return apiError(503, 'api_error', '학교 공용 키가 설정되지 않았습니다.');

  const url = new URL(request.url);
  const path = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
  if (!ALLOWED_PATHS.has(path)) return apiError(404, 'not_found_error', '허용되지 않은 경로입니다.');

  if (!samePassword(request.headers.get('x-api-key') || '', process.env.SCHOOL_PASSWORD)) {
    return apiError(401, 'authentication_error', '학교 비밀번호가 올바르지 않습니다.');
  }

  const body = await request.text();
  if (body.length > MAX_BODY) return apiError(413, 'request_too_large', '보내는 자료가 너무 큽니다. PDF 쪽 범위를 줄여 주세요.');
  let model = '';
  try { model = JSON.parse(body).model; } catch { return apiError(400, 'invalid_request_error', '요청 형식이 올바르지 않습니다.'); }
  if (!ALLOWED_MODELS.has(model)) return apiError(400, 'invalid_request_error', '허용되지 않은 모델입니다.');

  const qs = new URLSearchParams(url.search);
  qs.delete('path');
  const target = `https://api.anthropic.com/${path}${qs.toString() ? `?${qs}` : ''}`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
  };
  const beta = request.headers.get('anthropic-beta');
  if (beta) headers['anthropic-beta'] = beta;

  let upstream;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body, signal: request.signal });
  } catch {
    return apiError(502, 'api_error', 'Anthropic 서버에 연결하지 못했습니다.');
  }
  // 스트리밍 응답을 그대로 흘려보낸다
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    },
  });
}
