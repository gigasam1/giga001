// 시험지 데이터 모델: 번호 매기기, 자동 검사, A/B형, 화면·인쇄용 HTML, .docx 만들기
/* global marked, DOMPurify, JSZip */

export const SYMBOLS = ['①', '②', '③', '④', '⑤', '⑥'];

export function newUid() { return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }

export function esc(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function md(text) { return DOMPurify.sanitize(marked.parse(String(text || ''))); }

const isMcq = (it) => it.type === '선택형';

function cleanItem(raw) {
  const it = {
    uid: String(raw.uid || ''),
    type: raw.type === '서술형' ? '서술형' : '선택형',
    difficulty: ['상', '중', '하'].includes(raw.difficulty) ? raw.difficulty : '중',
    points: Math.max(0, Math.round(Number(raw.points) || 0)),
    unit: String(raw.unit || ''),
    standard: String(raw.standard || ''),
    element: String(raw.element || ''),
    evidence: String(raw.evidence || ''),
    behavior: String(raw.behavior || ''),
    passage: String(raw.passage || ''),
    stem: String(raw.stem || ''),
    choices: Array.isArray(raw.choices) ? raw.choices.map((c) => String(c).replace(/^\s*[①②③④⑤⑥]\s*/, '')) : [],
    answer: String(raw.answer ?? '').trim(),
    fixedChoiceOrder: !!raw.fixedChoiceOrder,
    explanation: String(raw.explanation || ''),
    conditions: String(raw.conditions || ''),
    rubric: Array.isArray(raw.rubric) ? raw.rubric.map((r) => ({
      criterion: String(r.criterion || ''), points: Math.round(Number(r.points) || 0), partial: String(r.partial || ''),
    })) : [],
    tableCells: Array.isArray(raw.tableCells) ? raw.tableCells.map(String) : [],
    locked: !!raw.locked,
  };
  if (it.type === '선택형') {
    const m = it.answer.match(/[1-6]|[①②③④⑤⑥]/);
    it.answer = m ? String(SYMBOLS.includes(m[0]) ? SYMBOLS.indexOf(m[0]) + 1 : m[0]) : '';
  } else {
    it.choices = [];
  }
  return it;
}
export { cleanItem };

// AI 응답을 시험지로. 고정 문항은 이전 내용 그대로 지키고, uid를 이어 준다
export function normalizeExam(raw, prev) {
  const prevItems = prev ? prev.items : [];
  const prevByUid = new Map(prevItems.map((it) => [it.uid, it]));
  const seen = new Set();
  let items = (raw.items || []).map((r) => {
    const it = cleanItem(r);
    if (!prevByUid.has(it.uid) || seen.has(it.uid)) { it.uid = newUid(); it.locked = false; } else it.locked = prevByUid.get(it.uid).locked;
    seen.add(it.uid);
    return it;
  });
  prevItems.forEach((old, idx) => {
    if (!old.locked) return;
    const i = items.findIndex((x) => x.uid === old.uid);
    if (i >= 0) items[i] = { ...old };
    else items.splice(Math.min(idx, items.length), 0, { ...old });
  });
  // 선택형 먼저, 서술형 뒤 (각각 원래 순서 유지)
  items = [...items.filter(isMcq), ...items.filter((x) => !isMcq(x))];
  return {
    header: {
      title: String(raw.header?.title || prev?.header.title || ''),
      notices: (raw.header?.notices || prev?.header.notices || []).map(String),
    },
    items,
    tableColumns: (raw.tableColumns && raw.tableColumns.length ? raw.tableColumns : prev?.tableColumns || []).map(String),
    analysisSummary: String(raw.analysisSummary || prev?.analysisSummary || ''),
    duplicateReport: String(raw.duplicateReport || prev?.duplicateReport || ''),
    message: String(raw.message || ''),
    review: null,
    bForm: prev?.bForm || null,
  };
}

// 번호표: 선택형 1, 2, … / 서술형 1, 2, …
export function labelMap(items) {
  const map = new Map();
  let m = 0; let e = 0;
  items.forEach((it) => map.set(it.uid, isMcq(it) ? String(++m) : `서술형 ${++e}`));
  return map;
}

// AI에게 보낼 현재 상태
export function examForAI(exam) {
  const labels = labelMap(exam.items);
  return {
    header: exam.header,
    tableColumns: exam.tableColumns,
    items: exam.items.map((it) => {
      const { tableCells, ...rest } = it;
      return { label: labels.get(it.uid), ...rest, tableCells };
    }),
  };
}

// ---------- 자동 검사 ----------
export function answerDistribution(items, nChoices) {
  const counts = Array(nChoices).fill(0);
  items.filter(isMcq).forEach((it) => { const a = Number(it.answer); if (a >= 1 && a <= nChoices) counts[a - 1]++; });
  return counts;
}

export function runChecks(exam, s, target) {
  const out = [];
  const add = (ok, text, warn = false) => out.push({ ok, warn: !ok && warn, text });
  const mcq = exam.items.filter(isMcq);
  const essay = exam.items.filter((x) => !isMcq(x));
  const n = Number(s.choices) || 5;
  add(mcq.length === Number(s.mcq), `선택형 ${mcq.length}문항 (목표 ${s.mcq})`);
  add(essay.length === Number(s.essay), `서술형 ${essay.length}문항 (목표 ${s.essay})`);
  const sum = exam.items.reduce((a, it) => a + it.points, 0);
  add(sum === Number(s.total), `배점 합계 ${sum}점 (총점 ${s.total})`);
  if (target) {
    const c = ['상', '중', '하'].map((d) => exam.items.filter((it) => it.difficulty === d).length);
    add(c.join() === target.join(), `난이도 상 ${c[0]} · 중 ${c[1]} · 하 ${c[2]} (목표 ${target.join(' · ')})`, true);
  }
  const labels = labelMap(exam.items);
  const badChoice = mcq.filter((it) => it.choices.length !== n).map((it) => labels.get(it.uid));
  add(!badChoice.length, badChoice.length ? `선지 수가 ${n}개가 아닌 문항: ${badChoice.join(', ')}번` : `선지 수 모두 ${n}개`);
  const badAns = mcq.filter((it) => !(Number(it.answer) >= 1 && Number(it.answer) <= it.choices.length)).map((it) => labels.get(it.uid));
  add(!badAns.length, badAns.length ? `정답 번호가 없거나 잘못된 문항: ${badAns.join(', ')}번` : '선택형 정답 모두 지정됨');
  const badRubric = essay.filter((it) => it.rubric.length && it.rubric.reduce((a, r) => a + r.points, 0) !== it.points).map((it) => labels.get(it.uid));
  if (essay.length) add(!badRubric.length, badRubric.length ? `채점 기준 합계가 배점과 다른 문항: ${badRubric.join(', ')}` : '서술형 채점 기준 합계 = 배점', true);
  const empty = exam.items.filter((it) => !it.stem.trim()).map((it) => labels.get(it.uid));
  if (empty.length) add(false, `발문이 비어 있는 문항: ${empty.join(', ')}`);
  out.push(...distChecks(mcq, n, 'A형'));
  return out;
}

function distChecks(mcq, n, tag) {
  const out = [];
  if (mcq.length < n) return out;
  const counts = answerDistribution(mcq, n);
  const avg = mcq.length / n;
  const okDist = counts.every((c) => Math.abs(c - avg) <= Math.max(2, avg * 0.5));
  out.push({ ok: okDist, warn: !okDist, text: `${tag} 정답 분포 ${counts.map((c, i) => `${SYMBOLS[i]}${c}`).join(' ')}` });
  let run = 1; let worst = 1;
  for (let i = 1; i < mcq.length; i++) {
    run = mcq[i].answer && mcq[i].answer === mcq[i - 1].answer ? run + 1 : 1;
    worst = Math.max(worst, run);
  }
  out.push({ ok: worst <= 3, warn: worst > 3, text: worst > 3 ? `${tag} 같은 정답 번호가 ${worst}문항 연속` : `${tag} 같은 정답 연속 3문항 이하` });
  return out;
}

// ---------- A/B형 ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function makeBForm(exam) {
  const mcq = exam.items.filter(isMcq).map((it) => it.uid);
  const essay = exam.items.filter((x) => !isMcq(x)).map((it) => it.uid);
  let order = shuffle(mcq);
  if (order.length > 2) for (let k = 0; k < 10 && order.some((u, i) => u === mcq[i]); k++) order = shuffle(mcq); // 같은 자리 최소화
  const perms = {};
  exam.items.filter(isMcq).forEach((it) => {
    const idx = it.choices.map((_, i) => i);
    perms[it.uid] = it.fixedChoiceOrder ? idx : shuffle(idx);
  });
  return { order: [...order, ...essay], perms };
}
// B형 문항 목록(선지·정답 바뀐 사본). 새로 생긴 문항은 뒤에 붙고, 지워진 문항은 빠짐
export function bItems(exam) {
  if (!exam.bForm) return null;
  const byUid = new Map(exam.items.map((it) => [it.uid, it]));
  const order = exam.bForm.order.filter((u) => byUid.has(u));
  exam.items.forEach((it) => { if (!order.includes(it.uid)) order.push(it.uid); });
  const list = order.map((u) => {
    const it = byUid.get(u);
    if (!isMcq(it)) return it;
    let perm = exam.bForm.perms[u];
    if (!perm || perm.length !== it.choices.length || it.fixedChoiceOrder) perm = it.choices.map((_, i) => i);
    const choices = perm.map((i) => it.choices[i]);
    const ans = Number(it.answer);
    const answer = ans >= 1 ? String(perm.indexOf(ans - 1) + 1) : '';
    return { ...it, choices, answer };
  });
  return [...list.filter(isMcq), ...list.filter((x) => !isMcq(x))];
}
export function bChecks(exam, s) {
  const items = bItems(exam);
  return items ? distChecks(items.filter(isMcq), Number(s.choices) || 5, 'B형') : [];
}

// ---------- 이원목적분류표 ----------
export function tableRows(exam, items = exam.items) {
  const labels = labelMap(items);
  const cols = exam.tableColumns.length ? exam.tableColumns
    : ['문항 번호', '단원', '성취기준', '평가 요소', '근거 문장', '행동 영역', '난이도', '문항 유형', '배점', '정답'];
  const auto = (col, it, i) => {
    if (/번호|^\s*문항\s*$|^\s*no\.?\s*$/i.test(col)) return labels.get(it.uid);
    if (/배점|점수/.test(col)) return String(it.points);
    if (/난이도/.test(col)) return it.difficulty;
    if (/정답/.test(col)) return isMcq(it) ? (SYMBOLS[Number(it.answer) - 1] || '') : '서술형';
    if (/유형|형태/.test(col)) return it.type;
    return it.tableCells[i] ?? '';
  };
  const rows = items.map((it) => cols.map((c, i) => auto(c, it, i)));
  const total = cols.map((c, i) => {
    if (i === 0) return '합계';
    if (/배점|점수/.test(c)) return String(items.reduce((a, it) => a + it.points, 0));
    if (/난이도/.test(c)) return ['상', '중', '하'].map((d) => `${d}${items.filter((it) => it.difficulty === d).length}`).join(' ');
    if (/번호|^\s*문항\s*$|^\s*no\.?\s*$/i.test(c)) return `${items.length}문항`;
    return '';
  });
  return { cols, rows, total };
}

// ---------- 화면·인쇄용 HTML ----------
export function paperHTML(exam, items, s, variant = '') {
  const labels = labelMap(items);
  const title = exam.header.title || `${s.examName} ${s.subject}`;
  const notices = exam.header.notices.map((n) => `<li>${esc(n)}</li>`).join('');
  let essayStarted = false;
  const qs = items.map((it) => {
    let pre = '';
    if (!isMcq(it) && !essayStarted) { essayStarted = true; pre = '<h3 class="essay-h">서술형</h3>'; }
    const choices = isMcq(it) ? `<ol class="ch">${it.choices.map((c, i) => `<li><span>${SYMBOLS[i]}</span> ${esc(c)}</li>`).join('')}</ol>` : '';
    const cond = it.conditions ? `<div class="cond"><b>조건</b> ${esc(it.conditions)}</div>` : '';
    const box = isMcq(it) ? '' : `<div class="ansbox" style="min-height:${Math.min(12, 3 + it.points)}em"></div>`;
    return `${pre}<div class="q"><div class="qh"><b>${esc(labels.get(it.uid))}.</b> ${esc(it.stem)} <span class="pt">[${it.points}점]</span></div>${it.passage ? `<div class="passage">${md(it.passage)}</div>` : ''}${choices}${cond}${box}</div>`;
  }).join('');
  return `<div class="paper"><div class="ph"><h1>${esc(title)}${variant ? ` <span class="variant">${esc(variant)}</span>` : ''}</h1>
<table class="who"><tr><td>${esc(s.grade)}</td><td>( )반</td><td>( )번</td><td>이름 (            )</td></tr></table>
${notices ? `<ul class="notices">${notices}</ul>` : ''}</div><div class="cols">${qs}</div></div>`;
}

export function answersHTML(exam, items, variant = '') {
  const labels = labelMap(items);
  const rows = items.filter(isMcq).map((it) => `<tr><td>${esc(labels.get(it.uid))}</td><td>${SYMBOLS[Number(it.answer) - 1] || ''}</td><td>${it.points}</td><td>${esc(it.difficulty)}</td><td class="l">${md(it.explanation)}</td></tr>`).join('');
  return `<h2>선택형 정답${variant ? ` (${esc(variant)})` : ''}</h2><table class="grid-t"><thead><tr><th>번호</th><th>정답</th><th>배점</th><th>난이도</th><th>근거·해설</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function essayHTML(exam) {
  const labels = labelMap(exam.items);
  const essays = exam.items.filter((x) => !isMcq(x));
  if (!essays.length) return '<p>서술형 문항이 없습니다.</p>';
  return essays.map((it) => `<h2>${esc(labels.get(it.uid))} <small>[${it.points}점]</small></h2>
<p><b>발문</b> ${esc(it.stem)}</p>${it.conditions ? `<p><b>조건</b> ${esc(it.conditions)}</p>` : ''}
<div class="model"><b>모범 답안</b>${md(it.answer)}</div>
<table class="grid-t"><thead><tr><th>채점 요소</th><th>배점</th><th>부분 점수·감점</th></tr></thead><tbody>
${it.rubric.map((r) => `<tr><td class="l">${esc(r.criterion)}</td><td>${r.points}</td><td class="l">${esc(r.partial)}</td></tr>`).join('')}
</tbody></table>`).join('');
}

export function tableHTML(exam) {
  const { cols, rows, total } = tableRows(exam);
  return `<table class="grid-t small"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
<tr class="sum">${total.map((c) => `<td>${esc(c)}</td>`).join('')}</tr></tbody></table>`;
}

export const PRINT_CSS = `@page{size:A4;margin:14mm 12mm}
body{font-family:'Batang','바탕','AppleMyungjo',serif;font-size:10.5pt;line-height:1.55;color:#000;margin:0}
h1{font-size:15pt;text-align:center;margin:0 0 6px}h2{font-size:12.5pt;margin:14px 0 6px}h3{font-size:11pt}
.variant{border:1.5px solid #000;padding:0 6px;font-size:12pt}
.who{width:100%;border-collapse:collapse;margin:6px 0}.who td{border:1px solid #000;padding:4px 8px;text-align:center}
.notices{margin:4px 0 8px;padding-left:18px;font-size:9.5pt}
.cols{column-count:2;column-gap:9mm;column-rule:1px solid #000}
.q{break-inside:avoid;margin:0 0 12px}.qh{margin-bottom:4px}.pt{white-space:nowrap}
.passage{border:1px solid #000;padding:4px 8px;margin:4px 0;font-size:9.8pt}.passage p{margin:2px 0}
.passage table{border-collapse:collapse;margin:4px 0}.passage td,.passage th{border:1px solid #000;padding:2px 5px}
.ch{list-style:none;padding:0 0 0 6px;margin:2px 0}.ch li{margin:1px 0}
.cond{font-size:9.5pt;margin:4px 0}.ansbox{border:1px solid #000;margin-top:4px}
.essay-h{column-span:none;border-top:2px solid #000;padding-top:4px;break-after:avoid}
.grid-t{width:100%;border-collapse:collapse;margin:6px 0}.grid-t th,.grid-t td{border:1px solid #000;padding:3px 5px;text-align:center;vertical-align:top}
.grid-t th{background:#eee}.grid-t td.l{text-align:left}.grid-t.small{font-size:8.5pt}.grid-t .sum td{font-weight:bold}
.grid-t p{margin:0}.model{border:1px solid #000;padding:4px 8px;margin:4px 0}
.pb{break-before:page}`;

// ---------- .docx ----------
const XML_BAD = /[^\u0009\u000A\u000D -퟿-�]/g;
const x = (t) => String(t ?? '').replace(XML_BAD, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function runs(text, opt = {}) {
  // **굵게** 처리, 줄바꿈은 <w:br/>
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '');
  return parts.map((p) => {
    const bold = opt.b || /^\*\*[^*]+\*\*$/.test(p);
    const t = /^\*\*[^*]+\*\*$/.test(p) ? p.slice(2, -2) : p;
    const rpr = `<w:rPr>${bold ? '<w:b/>' : ''}${opt.sz ? `<w:sz w:val="${opt.sz}"/><w:szCs w:val="${opt.sz}"/>` : ''}</w:rPr>`;
    return t.split('\n').map((line, i) => `<w:r>${rpr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${x(line)}</w:t></w:r>`).join('');
  }).join('') || '<w:r><w:t></w:t></w:r>';
}
function para(inner, opt = {}) {
  const ppr = [
    opt.align ? `<w:jc w:val="${opt.align}"/>` : '',
    opt.box ? '<w:pBdr><w:top w:val="single" w:sz="4" w:space="2" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="2" w:color="000000"/><w:right w:val="single" w:sz="4" w:space="4" w:color="000000"/></w:pBdr>' : '',
    opt.keep ? '<w:keepNext/><w:keepLines/>' : '',
    `<w:spacing w:before="${opt.before || 0}" w:after="${opt.after ?? 60}"/>`,
    opt.ind ? `<w:ind w:left="${opt.ind}"/>` : '',
    opt.sect || '',
  ].join('');
  return `<w:p><w:pPr>${ppr}</w:pPr>${inner}</w:p>`;
}
const P = (text, opt = {}) => para(runs(text, opt), opt);
function table(rows, width, opt = {}) {
  const n = Math.max(1, ...rows.map((r) => r.length));
  const w = Math.floor(width / n);
  const border = '<w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/>';
  const trs = rows.map((r, ri) => {
    const tcs = Array.from({ length: n }, (_, ci) => {
      const head = opt.header && ri === 0;
      const shade = head ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' : '';
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shade}</w:tcPr>${P(r[ci] ?? '', { sz: opt.sz, b: head || (opt.boldLast && ri === rows.length - 1), after: 0, align: opt.align })}</w:tc>`;
    }).join('');
    const h = opt.height ? `<w:trPr><w:trHeight w:val="${opt.height}" w:hRule="atLeast"/></w:trPr>` : '';
    return `<w:tr>${h}${tcs}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${w * n}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + w + '"/>'.repeat(n)}</w:tblGrid>${trs}</w:tbl>${P('', { after: 40 })}`;
}
// 마크다운 제시문 → 문단·표
function mdBlocks(text, width) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/^\s*>\s?/, '');
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i].replace(/^\s*>\s?/, ''))) {
        const l = lines[i].replace(/^\s*>\s?/, '').trim();
        if (!/^\|[\s:|-]+\|$/.test(l)) rows.push(l.slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      i--;
      out.push(table(rows, width, { header: true, sz: 18, align: 'center' }));
    } else if (raw.trim()) {
      out.push(P(raw.replace(/^#+\s*/, '').replace(/^\s*[-*]\s+/, '• '), { box: true, sz: 19, after: 0 }));
    }
  }
  return out.join('');
}

const PAGE = { w: 11906, h: 16838, m: 851 };
const FULL = PAGE.w - PAGE.m * 2;
const COL = Math.floor((FULL - 425) / 2);
function sect(cols, next = true) {
  return `<w:sectPr>${next ? '<w:type w:val="nextPage"/>' : ''}<w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/><w:pgMar w:top="${PAGE.m}" w:right="${PAGE.m}" w:bottom="${PAGE.m}" w:left="${PAGE.m}" w:header="567" w:footer="567" w:gutter="0"/>${cols > 1 ? '<w:cols w:num="2" w:space="425" w:sep="1"/>' : '<w:cols w:space="425"/>'}</w:sectPr>`;
}

function paperDocx(exam, items, s, variant) {
  const labels = labelMap(items);
  const head = [
    P(`${exam.header.title || `${s.examName} ${s.subject}`}${variant ? `  [${variant}]` : ''}`, { b: true, sz: 30, align: 'center', after: 120 }),
    table([[s.grade, '(   )반', '(   )번', '이름 (                )']], FULL, { align: 'center' }),
    ...exam.header.notices.map((n) => P(`• ${n}`, { sz: 18, after: 20 })),
  ].join('');
  let essayStarted = false;
  const body = items.map((it) => {
    let pre = '';
    if (!isMcq(it) && !essayStarted) { essayStarted = true; pre = P('[서술형]', { b: true, before: 120, keep: true }); }
    const q = P(`${labels.get(it.uid)}. ${it.stem} [${it.points}점]`, { keep: true, before: 120 });
    const passage = it.passage ? mdBlocks(it.passage, COL) : '';
    const choices = isMcq(it) ? it.choices.map((c, i) => P(`${SYMBOLS[i]} ${c}`, { ind: 200, after: 20 })).join('') : '';
    const cond = it.conditions ? P(`조건: ${it.conditions}`, { sz: 18 }) : '';
    const box = isMcq(it) ? '' : table([['']], COL, { height: 400 + it.points * 160 });
    return pre + q + passage + choices + cond + box;
  }).join('');
  // 머리말 구역(1단) → 문항 구역(2단)
  return `${head}${para('', { sect: sect(1, false) })}${body}${para('', { sect: sect(2) })}`;
}

function answersDocx(items, variant) {
  const labels = labelMap(items);
  const rows = [['번호', '정답', '배점', '난이도', '근거·해설']]
    .concat(items.filter(isMcq).map((it) => [labels.get(it.uid), SYMBOLS[Number(it.answer) - 1] || '', String(it.points), it.difficulty, it.explanation]));
  return P(`선택형 정답${variant ? ` (${variant})` : ''}`, { b: true, sz: 26, after: 80 }) + table(rows, FULL, { header: true, sz: 18 });
}

export async function buildDocx(exam, s) {
  if (typeof JSZip === 'undefined') throw new Error('Word 저장 도구를 불러오지 못했습니다.');
  const labels = labelMap(exam.items);
  const parts = [];
  parts.push(paperDocx(exam, exam.items, s, exam.bForm ? 'A형' : ''));
  parts.push(answersDocx(exam.items, exam.bForm ? 'A형' : ''));
  const essays = exam.items.filter((it) => !isMcq(it));
  if (essays.length) {
    parts.push(P('서술형 모범 답안 및 채점 기준', { b: true, sz: 26, before: 200, after: 80 }));
    essays.forEach((it) => {
      parts.push(P(`${labels.get(it.uid)} [${it.points}점] ${it.stem}`, { b: true, keep: true, before: 120 }));
      if (it.conditions) parts.push(P(`조건: ${it.conditions}`, { sz: 18 }));
      parts.push(P(`모범 답안: ${it.answer}`, { box: true }));
      parts.push(table([['채점 요소', '배점', '부분 점수·감점']].concat(it.rubric.map((r) => [r.criterion, String(r.points), r.partial])), FULL, { header: true, sz: 18 }));
    });
  }
  const t = tableRows(exam);
  parts.push(P('이원목적분류표', { b: true, sz: 26, before: 200, after: 80 }));
  parts.push(table([t.cols, ...t.rows, t.total], FULL, { header: true, sz: 15, boldLast: true, align: 'center' }));
  parts.push(para('', { sect: sect(1) }));
  const bi = bItems(exam);
  if (bi) {
    parts.push(paperDocx(exam, bi, s, 'B형'));
    parts.push(answersDocx(bi, 'B형'));
  }
  const body = `${parts.join('')}${sect(1, false)}`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Batang" w:hAnsi="Batang" w:eastAsia="바탕" w:cs="Batang"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/document.xml', doc);
  zip.file('word/styles.xml', styles);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

// 마크다운 전체 내보내기
export function examMarkdown(exam, s) {
  const labels = labelMap(exam.items);
  const lines = [`# ${exam.header.title || `${s.examName} ${s.subject}`}`, '', ...exam.header.notices.map((n) => `- ${n}`), ''];
  exam.items.forEach((it) => {
    lines.push(`**${labels.get(it.uid)}.** ${it.stem} [${it.points}점]`, '');
    if (it.passage) lines.push(it.passage.split('\n').map((l) => `> ${l}`).join('\n'), '');
    it.choices.forEach((c, i) => lines.push(`${SYMBOLS[i]} ${c}  `));
    if (it.conditions) lines.push(`조건: ${it.conditions}`);
    lines.push('');
  });
  lines.push('## 정답', '');
  exam.items.forEach((it) => lines.push(`- ${labels.get(it.uid)}: ${isMcq(it) ? SYMBOLS[Number(it.answer) - 1] || '' : it.answer.replace(/\n/g, ' ')}`));
  const t = tableRows(exam);
  lines.push('', '## 이원목적분류표', '', `| ${t.cols.join(' | ')} |`, `|${t.cols.map(() => '---').join('|')}|`,
    ...t.rows.map((r) => `| ${r.map((c) => c.replace(/\|/g, '/')).join(' | ')} |`), `| ${t.total.join(' | ')} |`);
  return lines.join('\n');
}
