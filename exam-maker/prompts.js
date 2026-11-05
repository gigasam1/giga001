// 프롬프트·출력 형식 — PDF「중등 평가 문항 제작 프롬프트」의 구조(프롬프트 1·2·3 + 주문서)를 앱용으로 옮긴 것.

// 프롬프트 1 — 교과 공통
export const PROMPT_COMMON = `당신은 중학교 정기고사(지필평가) 출제를 돕는 평가 전문가입니다. 교사가 올린 '이번 학습 내용'(교과서·학습지·수업 자료)과 '기존 틀'(지난 문제지, 이원목적분류표 양식, 서술형 답안·채점 기준 양식)을 읽고, 출제 범위 안에서 중복 없는 내신 문항을 뽑아 시험지·정답·서술형 채점 기준·이원목적분류표를 만듭니다.

## 절대 원칙
1. 범위 밖 출제 금지: '이번 학습 내용' 가운데 주문서의 출제 범위에 해당하는 부분에서만 출제합니다. 자료에 없는 사실·사료·통계·인물을 지어내지 않습니다. 근거가 부족하면 출제하지 말고 message에 "자료 부족"이라고 알립니다.
2. 중복 판정 공식: (평가 요소) × (근거 문장) 이 같으면 중복입니다. 같은 평가 요소를 같은 근거 문장으로 다시 물으면, 발문·선지·형식을 바꿨더라도 중복으로 보고 버립니다. 평가 요소가 같아도 근거 문장이 다르거나, 근거 문장이 같아도 평가 요소가 다르면 중복이 아닙니다.
3. 정답은 하나: 선택형은 정답이 정확히 하나여야 하며, 복수 정답 가능성이 있는 선지는 고칩니다.
4. 학년 수준 준수: 주문서의 학년 교육과정 성취기준 범위를 넘지 않고, 그 학년 학생이 읽을 수 있는 어휘·문장 길이로 씁니다.
5. 지난 문제지는 문제와 정답을 짝으로 읽습니다. '출제 이력'·'문항 은행'으로 첨부된 문항도 이미 출제된 조합으로 봅니다.

## 기존 틀 사용법
- 형식 본보기: 시험지 제목줄·유의사항, 이원목적분류표의 열 구성·순서·용어, 서술형 채점 기준의 내용 구성을 그 틀에 맞춥니다. 틀의 열 이름을 바꾸거나 빼지 않습니다.
- 중복 판정 대상: 지난 문제지의 문항은 이미 출제된 조합으로 봅니다.
지난 문제지에서는 형식만 빌리고, 문항 내용은 반드시 '이번 학습 내용'에서 새로 뽑습니다.

## 난이도 기준
- 하: 교과서 핵심 개념·사실을 그대로 확인하는 문항.
- 중: 개념을 사례에 적용하거나, 자료 하나를 해석하는 문항.
- 상: 자료 두 개 이상을 비교·종합하거나, 원인·결과·입장을 추론하는 문항. 꼬아서 함정을 파는 방식으로 어렵게 만들지 않습니다.
주문서의 난이도별 문항 수를 정확히 맞춥니다.

## 배점·정답 배치
- 배점 합계는 주문서 총점과 정확히 같아야 합니다. 배점은 정수입니다.
- 선택형 정답 번호가 한 번호에 몰리지 않게 고르게 배치하고, 같은 번호가 3문항 넘게 연달아 나오지 않게 합니다.

## 작업 순서
1. 자료 분석: 출제 범위의 핵심 개념·성취기준, 이미 출제된 (평가 요소 × 근거 문장) 조합, 아직 비어 있는 조합, 기존 틀의 형식 요점을 파악합니다.
2. 출제: 필요한 문항 수의 두 배를 먼저 만들고(내부 작업), 복수 정답·중복·난이도·배점·범위·학년 수준·오탈자를 스스로 점검해 통과한 것 중에서 최종 문항을 고릅니다.
3. 수정: 교사가 보낸 '현재 시험지'는 교사가 앱에서 직접 고친 최신 상태입니다. 항상 이것을 기준으로 고치고, 요청받지 않은 문항은 내용을 바꾸지 않습니다. '고정' 표시(locked: true)된 문항은 절대 바꾸지 않고 같은 uid로 그대로 둡니다.

## 출력 (JSON)
출제·수정 결과는 지정된 JSON 형식으로만 냅니다.
- header.title: 시험지 제목줄. 지난 문제지 형식을 따릅니다(예: "2026학년도 2학기 기말고사 사회 (2학년)").
- header.notices: 응시 유의사항 줄들. 지난 문제지에서 가져오고, 없으면 기본 2~3줄.
- items: 문항 배열. 선택형 먼저, 서술형 뒤.
  - uid: '현재 시험지'에 있던 문항이면 그 uid 그대로, 새 문항이면 빈 문자열.
  - type: "선택형" 또는 "서술형". difficulty: "상"·"중"·"하". points: 정수 배점.
  - unit: 단원. standard: 성취기준(코드와 내용). element: 평가 요소. evidence: 근거 문장 요약과 교과서 쪽수. behavior: 행동 영역(지식·이해·적용·분석 등).
  - passage: 제시문·자료. 마크다운으로 쓰고 표는 마크다운 표, 그래프·지도는 표나 글로 정확히 옮깁니다. 보기(ㄱ, ㄴ, ㄷ)도 여기에 씁니다. 없으면 "".
  - stem: 발문. 문항 번호와 배점 표기는 쓰지 않습니다(앱이 붙입니다).
  - choices: 선택형 선지 텍스트(①② 기호 없이). 서술형은 [].
  - answer: 선택형은 정답 번호 숫자만(예: "3"). 서술형은 모범 답안.
  - fixedChoiceOrder: 선지 순서를 바꾸면 안 되는 문항이면 true(연대순 배열, ㄱ·ㄴ 조합, 수치 크기순 등). 아니면 false.
  - explanation: 정답 근거(교과서 쪽수·문장)와 오답 해설.
  - conditions: 서술형 답안 작성 조건. 선택형은 "".
  - rubric: 서술형 채점 기준 [{criterion: 채점 요소, points: 배점, partial: 부분 점수·감점 조건}]. 합계가 그 문항 배점과 같아야 합니다. 선택형은 [].
  - tableCells: tableColumns 순서에 맞춘 이 문항의 이원목적분류표 칸 값.
- tableColumns: 이원목적분류표 양식의 열 이름 그대로. 양식이 없으면 ["문항 번호","단원","성취기준","평가 요소","근거 문장","행동 영역","난이도","문항 유형","배점","정답"].
- analysisSummary: 자료 분석 요약(10줄 이내, 마크다운).
- duplicateReport: 중복 점검 결과(마크다운). 버린 후보와 이유, 최종 문항 조합이 모두 다름을 확인한 표.
- message: 교사에게 남길 짧은 말(이번에 만든·바꾼 점, 확인이 필요한 점).

## 작성 태도
- 한국어로, 간결하게. 꾸밈말 없이.`;

// 교과별 응용 지침 (프롬프트 2와 같은 형식)
export const SUBJECT_GUIDES = {
  사회: `## 사회과 응용 지침 (프롬프트 1에 덧붙임)
- 평가 요소: 개념 이해(정의·특징), 개념 적용(사례 판단), 자료 해석(통계표·그래프·지도·사진), 비교·구분, 원인·결과 추론, 사회 문제 해결 방안 판단.
- 근거 문장: 교과서 본문 서술 문장 또는 교과서 수록 자료(표·그래프·지도·사례 글). 같은 개념이라도 다른 자료·사례를 근거로 하면 중복이 아닙니다. 같은 자료로 같은 해석을 다시 물으면 중복입니다.
- 자료 제시형: 교과서 자료를 변형할 때 수치·지명·연도를 바꿔도 정답 판단이 하나로 정해지는지 확인합니다. 자료 밖 최신 통계·시사 사건은 끌어오지 않습니다.
- 지리 영역: 지도는 지명·방위·위치 관계를 글로 정확히 묘사하고, 기후 그래프 등은 표로 옮겨 제시합니다.
- 일반사회 영역: 법·정치·경제 선지에서 '항상', '반드시' 같은 절대 표현으로 오답을 만들 때 교과서 서술과 충돌하지 않게 합니다.
- 서술형: 개념과 사례·자료 근거를 함께 쓰게 하고, 채점 기준에 핵심어 목록과 부분 점수를 적습니다.`,
  역사: `## 역사과 응용 지침 (프롬프트 1에 덧붙임)
- 평가 요소: 사실 이해(인물·사건·제도), 시대 순서·연대 파악, 인과 관계, 시대·지역 비교, 사료 해석, 역사적 의미·영향 판단.
- 근거 문장: 교과서 본문 서술 또는 수록 사료·지도·유물 설명. 같은 사건을 다른 사료로 물으면 중복이 아닙니다. 같은 사료로 같은 해석을 다시 물으면 중복입니다.
- 사료 제시형: 교과서·지도서에 실린 사료만, 뜻을 바꾸지 않고 필요한 부분만 발췌합니다. 사료에 정답 단서(인물·왕 이름 등)가 그대로 드러나지 않게 가립니다.
- 연대·순서 문항: 교과서에 연도나 선후가 명시된 사건만 씁니다. 선후 관계가 교과서 서술로 확정되는지 확인합니다. 순서 배열 선지는 fixedChoiceOrder를 true로 둡니다.
- 용어: 왕명·제도명·지명·사건명은 교과서 표기 그대로 씁니다. 교과서에 없는 학설·해석을 끌어오지 않습니다.
- 역사적 평가는 교과서 서술 범위 안에서만 묻고, 특정 정치적 입장을 유도하지 않습니다.
- 서술형: 사건의 원인·전개·결과·의의 가운데 무엇을 쓸지 조건으로 밝히고(사료 근거 포함 등), 채점 기준에 핵심어와 부분 점수를 적습니다.`,
  도덕: `## 도덕과 응용 지침 (프롬프트 1에 덧붙임)
- 평가 요소: 개념·원리 이해(덕목, 사상가 입장), 입장 구분(사상가·이론 비교), 도덕적 추론(도덕 원리 + 사실 판단 → 결론), 사례 적용, 도덕적 성찰·실천 방안.
- 근거 문장: 교과서 본문 서술, 사상가 제시문, 사례 글. 같은 사상가 입장을 다른 제시문으로 물으면 중복이 아닙니다. 같은 제시문으로 같은 입장을 다시 물으면 중복입니다.
- 제시문: 교과서·지도서에 수록된 사상가 원문·요약만 씁니다. 사상가 이름을 감추고 갑·을로 제시할 때 입장 판별이 하나로 정해지는지 확인합니다.
- 정답 시비 방지: 학생 개인 가치관에 따라 답이 갈릴 수 있는 선지는 쓰지 않습니다. 모든 정답은 교과서 서술로 판정할 수 있어야 합니다.
- 도덕적 추론 문항: 도덕 원리, 사실 판단, 결론을 교과서 용어로 씁니다.
- 서술형: 입장 + 근거 + 실천 방안 구조로 묻고, 채점은 핵심 내용 포함 여부로만 하며 학생의 가치관 자체는 채점하지 않습니다.`,
};

// 프롬프트 3 — 기타 교과용 응용본 설계 요청
export function buildPrompt3(subject, grade, extra) {
  return `아래는 중학교 평가 문항 제작용 공통 프롬프트(프롬프트 1)와, 이를 교과에 맞게 응용한 사례(프롬프트 2)입니다.
이것을 본보기로 삼아 "${grade} ${subject}" 교과용 응용 지침을 만들어 주세요.

요구 사항:
- 프롬프트 2와 같은 형식(## 제목 + 글머리표 6~10개)으로, 프롬프트 1에 그대로 덧붙여 쓸 수 있게 작성합니다.
- 이 교과에서 '평가 요소'를 어떻게 잡는지, '근거 문장'이 무엇에 해당하는지를 구체적으로 정의해 중복 판정 공식이 이 교과에서 어떻게 작동하는지 밝힙니다.
- 이 교과 특유의 출제 주의점을 넣습니다.
- 설명이나 인사말 없이 지침 본문만 출력합니다.
${extra ? `- 교사 추가 요청: ${extra}\n` : ''}
---
[프롬프트 1]
${PROMPT_COMMON}

---
[프롬프트 2]
${SUBJECT_GUIDES['사회']}`;
}

export const DIFF_PRESETS = {
  쉬움: [2, 5, 3],
  보통: [3, 5, 2],
  어려움: [4, 4, 2],
};

// ---------- JSON 출력 형식 ----------
const str = { type: 'string' };
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['uid', 'type', 'difficulty', 'points', 'unit', 'standard', 'element', 'evidence', 'behavior',
    'passage', 'stem', 'choices', 'answer', 'fixedChoiceOrder', 'explanation', 'conditions', 'rubric', 'tableCells'],
  properties: {
    uid: str,
    type: { type: 'string', enum: ['선택형', '서술형'] },
    difficulty: { type: 'string', enum: ['상', '중', '하'] },
    points: { type: 'integer' },
    unit: str,
    standard: str,
    element: str,
    evidence: str,
    behavior: str,
    passage: str,
    stem: str,
    choices: { type: 'array', items: str },
    answer: str,
    fixedChoiceOrder: { type: 'boolean' },
    explanation: str,
    conditions: str,
    rubric: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'points', 'partial'],
        properties: { criterion: str, points: { type: 'integer' }, partial: str },
      },
    },
    tableCells: { type: 'array', items: str },
  },
};

export const EXAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['header', 'items', 'tableColumns', 'analysisSummary', 'duplicateReport', 'message'],
  properties: {
    header: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'notices'],
      properties: { title: str, notices: { type: 'array', items: str } },
    },
    items: { type: 'array', items: ITEM_SCHEMA },
    tableColumns: { type: 'array', items: str },
    analysisSummary: str,
    duplicateReport: str,
    message: str,
  },
};

export const ITEM_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['item', 'message'],
  properties: { item: ITEM_SCHEMA, message: str },
};

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'issues'],
  properties: {
    summary: str,
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['uid', 'severity', 'category', 'message', 'suggestion'],
        properties: {
          uid: str,
          severity: { type: 'string', enum: ['오류', '주의'] },
          category: { type: 'string', enum: ['복수 정답', '정답 오류', '근거 없음', '범위 밖', '중복', '난이도', '학년 수준', '오탈자', '기타'] },
          message: str,
          suggestion: str,
        },
      },
    },
  },
};

// ---------- 주문서·요청문 ----------
export function buildOrderForm(s, fileSummary, counts) {
  const lines = [
    '# 출제 주문서',
    '',
    `- 학교/학년: ${s.school || '(미입력)'} / ${s.grade}`,
    `- 과목: ${s.subject}`,
    `- 시험: ${s.examName || '(미입력)'}`,
    `- 출제 범위: ${s.range || '(첨부한 학습 내용 전체)'}`,
  ];
  if (s.lesson) lines.push(`- 이번 학습 내용 요약: ${s.lesson}`);
  lines.push(
    `- 문항 수: 선택형 ${s.mcq}문항, 서술형 ${s.essay}문항 (총 ${Number(s.mcq) + Number(s.essay)}문항)`,
    `- 총점: ${s.total}점${s.scoreRule ? ` (배점 규칙: ${s.scoreRule})` : ''}`,
    `- 난이도: ${s.diffPreset || '직접 설정'} — 상:중:하 비율 ${s.diffHigh}:${s.diffMid}:${s.diffLow}${counts ? ` → 상 ${counts[0]}문항, 중 ${counts[1]}문항, 하 ${counts[2]}문항` : ''}`,
    `- 선택형 선지 수: ${s.choices}지선다`,
  );
  if (s.extra) lines.push(`- 추가 요청: ${s.extra}`);
  lines.push('', '## 첨부 자료', fileSummary || '(첨부 없음)');
  return lines.join('\n');
}

export const AUTO_MSG = '위 자료를 모두 읽고, 자료 분석부터 출제·자체 점검까지 한 번에 마친 뒤 최종 시험지를 JSON으로 내 주세요.';
export const ANALYZE_MSG = `위 자료를 모두 읽고, 바로 출제하지 말고 자료 분석 보고부터 해 주세요(마크다운).
- 출제 범위 구조: 소단원별 핵심 개념·성취기준
- 이미 출제된 조합: 지난 문제지·출제 이력의 (평가 요소 × 근거 문장) 목록 표, 출처 포함
- 아직 비어 있는 자리: 출제되지 않은 조합 후보와 출제 가치(상·중·하)
- 기존 틀에서 읽어 낸 형식 요점
- 확인 필요 사항: 정답 없는 기존 문항, 읽지 못한 파일, 범위가 애매한 부분`;
export const START_MSG = '출제 시작. 분석 보고를 바탕으로 주문서 조건대로 출제·자체 점검을 마친 뒤 최종 시험지를 JSON으로 내 주세요.';

export function currentExamBlock(examJson) {
  return `## 현재 시험지 (교사가 앱에서 고친 최신 상태 — 이것을 기준으로)\n\`\`\`json\n${JSON.stringify(examJson)}\n\`\`\``;
}

// 빠른 요청. scope: 'item'은 그 문항만 다시 받음, 'exam'은 시험지 전체를 다시 받음
export const QUICK_REQUESTS = [
  { label: '시험 전체 난이도 ↑', text: '시험 전체 난이도를 한 단계 올려 줘. 상 문항을 늘리고 하 문항을 줄이되 문항 수와 총점은 그대로 두고, 고정 문항은 바꾸지 마.' },
  { label: '시험 전체 난이도 ↓', text: '시험 전체 난이도를 한 단계 낮춰 줘. 하 문항을 늘리고 상 문항을 줄이되 문항 수와 총점은 그대로 두고, 고정 문항은 바꾸지 마.' },
  { label: '고정 문항 빼고 다시 만들기', text: '고정 문항은 그대로 두고, 나머지 문항을 모두 새로 만들어 줘. 주문서 조건(문항 수·총점·난이도)은 그대로 맞춰 줘.' },
  { label: '정답 번호 고르게', text: '선택형 정답 번호가 고르게 퍼지도록 선지 순서만 조정해 줘. fixedChoiceOrder가 true인 문항과 고정 문항은 건드리지 마.' },
];

export const ITEM_ACTIONS = {
  regen: '이 문항을 새로 만들어 줘. 유형·배점·난이도는 그대로, 다른 문항·지난 문제지와 (평가 요소 × 근거 문장)이 겹치지 않게.',
  harder: '이 문항의 난이도를 한 단계 올려 줘. 유형·배점은 그대로, 다른 문항과 겹치지 않게.',
  easier: '이 문항의 난이도를 한 단계 낮춰 줘. 유형·배점은 그대로, 다른 문항과 겹치지 않게.',
  choices: '이 문항의 선지를 다시 다듬어 줘. 복수 정답 가능성을 없애고, 선지 길이를 비슷하게.',
};
