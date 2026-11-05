// Claude 호출: 개인 API 키(브라우저에서 직접) 또는 학교 공용 키(이 사이트의 서버 함수 경유)

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm';
let Anthropic = null;

export async function loadSdk() {
  if (!Anthropic) {
    try { Anthropic = (await import(SDK_URL)).default; } catch {
      throw new Error('Anthropic SDK를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }
  }
  return Anthropic;
}

// mode: 'personal' → secret = API 키, 'school' → secret = 학교 비밀번호
export async function makeClient(mode, secret) {
  if (!secret) throw new Error(mode === 'school' ? '학교 비밀번호를 입력해 주세요.' : 'API 키를 입력해 주세요. (키가 없으면 "프롬프트만 복사"를 쓰세요)');
  const A = await loadSdk();
  if (mode === 'school') {
    return new A({ apiKey: secret, baseURL: `${location.origin}/api/anthropic`, dangerouslyAllowBrowser: true, maxRetries: 1 });
  }
  return new A({ apiKey: secret, dangerouslyAllowBrowser: true });
}

export async function schoolStatus() {
  try {
    const r = await fetch('/api/anthropic', { method: 'GET', cache: 'no-store' });
    if (!r.ok) return { enabled: false };
    return await r.json();
  } catch { return { enabled: false }; }
}

export function requestParams({ model, system, messages, schema, effort = 'high', maxTokens = 64000 }) {
  const p = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
    // 안전 분류기가 거절하면 서버가 다른 모델로 자동 재시도
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  if (schema) p.output_config.format = { type: 'json_schema', schema };
  return p;
}

export function errText(e) {
  if (!Anthropic) return e.message;
  if (e instanceof Anthropic.APIUserAbortError) return '중단했습니다.';
  if (e instanceof Anthropic.AuthenticationError) return 'API 키(또는 학교 비밀번호)가 올바르지 않습니다.';
  if (e instanceof Anthropic.PermissionDeniedError) return '이 키로는 해당 모델을 쓸 수 없습니다.';
  if (e instanceof Anthropic.RateLimitError) return '요청 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요.';
  if (e instanceof Anthropic.BadRequestError) return `요청 오류: ${e.message} (파일이 너무 크면 PDF 쪽 범위를 줄여 주세요)`;
  if (e instanceof Anthropic.InternalServerError) return '서버가 혼잡합니다. 잠시 뒤 다시 시도해 주세요.';
  if (e instanceof Anthropic.APIConnectionError) return '네트워크 연결에 실패했습니다.';
  if (e instanceof Anthropic.APIError && e.status === 413) return '보내는 자료가 너무 큽니다. 학교 공용 키는 한 번에 약 4MB까지 보낼 수 있으니 PDF 쪽 범위를 줄여 주세요.';
  return e.message;
}

// ---------- 비용 ----------
// 100만 토큰당 달러 (입력, 출력, 캐시 쓰기, 캐시 읽기)
export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.2 },
};
export const KRW_PER_USD = 1400;

export function usageCost(model, u) {
  const p = PRICES[model] || PRICES['claude-opus-5-5'];
  const usd = ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out
    + (u.cache_creation_input_tokens || 0) * p.cw + (u.cache_read_input_tokens || 0) * p.cr) / 1e6;
  return usd;
}
// 출력(생각 포함) 예상 토큰: 문항 수 기준 대략치
export function outputEstimate(nMcq, nEssay) {
  const base = nMcq * 550 + nEssay * 900 + 1500;
  return [base * 1.5, base * 3.5];
}
export function won(usd) { return `${Math.round(usd * KRW_PER_USD).toLocaleString('ko-KR')}원`; }
