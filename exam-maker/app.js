import {
  PROMPT_COMMON, SUBJECT_GUIDES, DIFF_PRESETS, EXAM_SCHEMA, ITEM_REPLY_SCHEMA, REVIEW_SCHEMA,
  buildPrompt3, buildOrderForm, AUTO_MSG, ANALYZE_MSG, START_MSG, currentExamBlock, QUICK_REQUESTS, ITEM_ACTIONS,
} from './prompts.js';
import { store, idb } from './storage.js';
import { usable, fmtSize, toEntry, parsePages, pdfData, approxBytes } from './files.js';
import {
  SYMBOLS, newUid, esc, md, cleanItem, normalizeExam, labelMap, examForAI, runChecks, makeBForm, bItems, bChecks,
  paperHTML, answersHTML, essayHTML, tableHTML, PRINT_CSS, buildDocx, examMarkdown,
} from './exam.js';
import {
  makeClient, schoolStatus, requestParams, errText, usageCost, outputEstimate, won, PRICES,
} from './api.js';

const KIND_LABEL = {
  lesson: '이번 학습 자료',
  past: '기존 틀 ① 지난 문제지(문제+정답)',
  table: '기존 틀 ② 이원목적분류표 양식',
  essay: '기존 틀 ③ 서술형 답안·채점 기준 양식',
};
const TEMPLATE_KINDS = ['past', 'table', 'essay'];
const LIMIT_PERSONAL = 30 * 1024 * 1024;
const LIMIT_SCHOOL = 4.2 * 1024 * 1024;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- 상태 ----------
const files = { lesson: [], past: [], table: [], essay: [] };
let messages = [];      // API 대화 기록 (추가만 함)
let phase = 'idle';     // idle → analyzed → generated
let running = null;     // 진행 중 스트림
let exam = null;        // 현재 시험지
let examId = null;      // 이력 저장 키
let activeTab = 0;
let sessionUsd = 0;

// ---------- 단계 이동 ----------
function go(n) {
  $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${n}`; });
  $$('.step').forEach((b) => b.classList.toggle('active', b.dataset.step === String(n)));
  if (String(n) === '2') updateHistoryCount();
  if (String(n) === '3') renderSummary();
  if (String(n) === '4') renderLists();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.step').forEach((b) => b.addEventListener('click', () => go(b.dataset.step)));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ---------- 설정 ----------
const FIELDS = ['school', 'grade', 'subject', 'subjectOther', 'examName', 'range', 'lesson', 'mcq', 'essay', 'total',
  'choices', 'scoreRule', 'diffPreset', 'diffHigh', 'diffMid', 'diffLow', 'extra', 'model', 'authMode'];

function settings() {
  const s = {};
  FIELDS.forEach((f) => { s[f] = $(`#${f}`).value.trim(); });
  if (s.subject === '기타') s.subject = s.subjectOther || '기타';
  return s;
}
function saveSettings() {
  const raw = {};
  FIELDS.forEach((f) => { raw[f] = $(`#${f}`).value; });
  raw.useHistory = $('#useHistory').checked;
  store.set('examMaker.settings', JSON.stringify(raw));
}
function loadSettings() {
  const saved = store.json('examMaker.settings', {});
  FIELDS.forEach((f) => { if (saved[f] != null && $(`#${f}`)) $(`#${f}`).value = saved[f]; });
  if (!['사회', '역사', '도덕', '기타'].includes($('#subject').value)) $('#subject').value = '사회';
  if (!PRICES[$('#model').value]) $('#model').value = 'claude-opus-5-5';
  if (saved.useHistory === false) $('#useHistory').checked = false;
  const key = store.get('examMaker.apiKey');
  if (key) { $('#apiKey').value = key; $('#rememberKey').checked = true; }
  const pw = store.get('examMaker.schoolPw');
  if (pw) { $('#schoolPw').value = pw; $('#rememberPw').checked = true; }
}
FIELDS.forEach((f) => $(`#${f}`).addEventListener('input', () => { saveSettings(); refreshPromptPreview(); }));
$('#model').addEventListener('change', saveSettings);
$('#useHistory').addEventListener('change', saveSettings);

function syncSeg() {
  $$('.seg').forEach((seg) => {
    const v = $(`#${seg.dataset.target}`).value;
    $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  const school = $('#authMode').value === 'school';
  $('#personalBox').hidden = school;
  $('#schoolBox').hidden = !school;
}
$$('.seg').forEach((seg) => {
  $$('button', seg).forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    $(`#${seg.dataset.target}`).value = b.dataset.v;
    if (seg.dataset.target === 'subject') onSubjectChange();
    if (seg.dataset.target === 'diffPreset') applyPreset();
    syncSeg();
    saveSettings();
    updateSize();
  }));
});

function applyPreset() {
  const p = DIFF_PRESETS[$('#diffPreset').value];
  if (p) [$('#diffHigh').value, $('#diffMid').value, $('#diffLow').value] = p;
  updateDiffCount();
}
['diffHigh', 'diffMid', 'diffLow'].forEach((id) => $(`#${id}`).addEventListener('input', () => {
  const cur = [$('#diffHigh').value, $('#diffMid').value, $('#diffLow').value].map(Number).join();
  const match = Object.entries(DIFF_PRESETS).find(([, v]) => v.join() === cur);
  $('#diffPreset').value = match ? match[0] : '직접 설정';
  syncSeg(); saveSettings(); updateDiffCount();
}));
['mcq', 'essay'].forEach((id) => $(`#${id}`).addEventListener('input', updateDiffCount));

function diffCounts() {
  const n = (Number($('#mcq').value) || 0) + (Number($('#essay').value) || 0);
  const r = [$('#diffHigh').value, $('#diffMid').value, $('#diffLow').value].map((v) => Number(v) || 0);
  const sum = r[0] + r[1] + r[2];
  if (!sum || !n) return null;
  const hi = Math.round((n * r[0]) / sum);
  const lo = Math.round((n * r[2]) / sum);
  return [hi, Math.max(0, n - hi - lo), lo];
}
function updateDiffCount() {
  const c = diffCounts();
  $('#diffCount').textContent = c ? `→ 상 ${c[0]} · 중 ${c[1]} · 하 ${c[2]}문항` : '';
  if (exam) renderChecks();
}

// 교과 응용 지침
function guideKey() { return `examMaker.guide.${$('#subject').value}`; }
function onSubjectChange() {
  const sub = $('#subject').value;
  $('#subjectOtherWrap').hidden = sub !== '기타';
  $('#genGuide').hidden = sub !== '기타';
  const custom = store.get(guideKey());
  $('#subjectGuide').value = custom != null ? custom : (SUBJECT_GUIDES[sub] || '');
  refreshPromptPreview();
}
$('#subjectGuide').addEventListener('input', () => { store.set(guideKey(), $('#subjectGuide').value); refreshPromptPreview(); });
$('#resetGuide').addEventListener('click', () => { store.del(guideKey()); onSubjectChange(); });
function systemPrompt() {
  const g = $('#subjectGuide').value.trim();
  return g ? `${PROMPT_COMMON}\n\n${g}` : PROMPT_COMMON;
}
function refreshPromptPreview() { $('#promptText').textContent = systemPrompt(); }

// ---------- 파일 ----------
async function addFiles(kind, list) {
  for (const f of list) {
    try { files[kind].push(await toEntry(f)); } catch (e) { alert(`${f.name} 읽기 실패: ${e.message}`); }
  }
  renderFiles(kind);
  if (TEMPLATE_KINDS.includes(kind)) saveTemplates();
}
function renderFiles(kind) {
  const ul = $(`.drop[data-kind="${kind}"] .files`);
  ul.innerHTML = '';
  files[kind].forEach((f, i) => {
    const li = document.createElement('li');
    const warn = f.type === 'hwp' ? ' — 예전 HWP는 읽을 수 없어 전송하지 않습니다. HWPX나 PDF로 저장해 주세요.'
      : f.type === 'bad' ? ' — 지원하지 않는 이미지 형식(JPG·PNG·GIF·WEBP만 가능)' : '';
    li.className = warn ? 'bad' : '';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = `${f.name} (${fmtSize(f.size)})${f.note ? ` · ${f.note}` : ''}${f.pages ? ` · 전체 ${f.pages}쪽` : ''}${warn}`;
    li.appendChild(name);
    if (f.type === 'pdf' && f.pages && kind === 'lesson') {
      const inp = document.createElement('input');
      inp.className = 'pages';
      inp.placeholder = `보낼 쪽 (예: 12-40) · 비우면 전체`;
      inp.value = f.pageSpec || '';
      inp.setAttribute('aria-label', `${f.name} 보낼 쪽`);
      inp.addEventListener('input', () => {
        f.pageSpec = inp.value;
        const ok = parsePages(inp.value, f.pages) !== null;
        inp.classList.toggle('invalid', !ok);
        updateSize();
      });
      li.appendChild(inp);
    }
    const x = document.createElement('button');
    x.textContent = '삭제';
    x.className = 'x';
    x.addEventListener('click', () => {
      files[kind].splice(i, 1);
      renderFiles(kind);
      if (TEMPLATE_KINDS.includes(kind)) saveTemplates();
    });
    li.appendChild(x);
    ul.appendChild(li);
  });
  updateSize();
}
function pasted(kind) { return $(`.drop[data-kind="${kind}"] textarea`).value.trim(); }
function has(kind) { return files[kind].some(usable) || !!pasted(kind); }
function totalBytes() {
  let n = 0;
  Object.values(files).flat().filter(usable).forEach((f) => { n += approxBytes(f); });
  Object.keys(files).forEach((k) => { n += pasted(k).length * 3; });
  return n;
}
function sizeLimit() { return $('#authMode').value === 'school' ? LIMIT_SCHOOL : LIMIT_PERSONAL; }
function updateSize() {
  const n = totalBytes();
  const el = $('#sizeStatus');
  el.textContent = n ? `전송 크기 약 ${fmtSize(n)} / 최대 ${fmtSize(sizeLimit())}${$('#authMode').value === 'school' ? ' (학교 공용 키)' : ''}` : '';
  el.classList.toggle('err', n > sizeLimit());
}
$$('.drop').forEach((d) => {
  const kind = d.dataset.kind;
  const input = $('input[type=file]', d);
  input.addEventListener('change', async () => { await addFiles(kind, [...input.files]); input.value = ''; });
  d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', async (e) => {
    e.preventDefault();
    d.classList.remove('over');
    await addFiles(kind, [...e.dataTransfer.files]);
  });
  $('textarea', d).addEventListener('input', () => {
    updateSize();
    if (TEMPLATE_KINDS.includes(kind)) saveTemplatesSoon();
  });
});

// 기존 틀 저장·불러오기·주고받기
let saveTimer = 0;
function saveTemplatesSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveTemplates, 600); }
function templateData() {
  const data = {};
  TEMPLATE_KINDS.forEach((k) => { data[k] = { files: files[k], text: pasted(k) }; });
  return data;
}
async function saveTemplates() {
  const ok = await idb.put('templates', templateData(), 'templates');
  $('#savedBadge').hidden = !(ok && TEMPLATE_KINDS.some(has));
}
function applyTemplates(data) {
  TEMPLATE_KINDS.forEach((k) => {
    if (!data[k]) return;
    files[k] = Array.isArray(data[k].files) ? data[k].files : [];
    $(`.drop[data-kind="${k}"] textarea`).value = data[k].text || '';
    renderFiles(k);
  });
}
async function loadTemplates() {
  const data = await idb.get('templates', 'templates');
  if (!data) return;
  applyTemplates(data);
  $('#savedBadge').hidden = !TEMPLATE_KINDS.some(has);
}
$('#clearTemplates').addEventListener('click', async () => {
  if (!confirm('저장된 기존 틀(지난 문제지·이원목적분류표·서술형 양식)을 모두 지울까요?')) return;
  await idb.del('templates', 'templates');
  TEMPLATE_KINDS.forEach((k) => { files[k] = []; $(`.drop[data-kind="${k}"] textarea`).value = ''; renderFiles(k); });
  $('#savedBadge').hidden = true;
});
$('#exportTemplates').addEventListener('click', () => {
  if (!TEMPLATE_KINDS.some(has)) { alert('내보낼 기존 틀이 없습니다.'); return; }
  const pack = { kind: 'examMaker-templates', version: 1, savedAt: new Date().toISOString(), templates: templateData() };
  download(`기존틀_${settings().school || '학교'}.json`, new Blob([JSON.stringify(pack)], { type: 'application/json' }));
});
$('#importTemplates').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const pack = JSON.parse(await f.text());
    if (pack.kind !== 'examMaker-templates' || !pack.templates) throw new Error('기존 틀 파일이 아닙니다.');
    if (TEMPLATE_KINDS.some(has) && !confirm('지금 있는 기존 틀을 불러온 파일로 바꿀까요?')) return;
    applyTemplates(pack.templates);
    await saveTemplates();
    alert('기존 틀을 불러왔습니다.');
  } catch (err) { alert(`불러오기 실패: ${err.message}`); }
});

function fileSummary(withHistory) {
  const lines = Object.keys(files).map((k) => {
    const names = files[k].filter(usable).map((f) => (f.type === 'pdf' && parsePages(f.pageSpec, f.pages)?.length ? `${f.name}(${f.pageSpec}쪽)` : f.name));
    if (pasted(k)) names.push('(붙여 넣은 본문)');
    return `- ${KIND_LABEL[k]}: ${names.length ? names.join(', ') : '없음'}`;
  });
  if (withHistory) lines.push('- 출제 이력·문항 은행: 첨부함 (이미 출제된 조합으로 취급)');
  return lines.join('\n');
}

// 출제 이력·문항 은행을 중복 판정용 글로
async function historyText() {
  if (!$('#useHistory').checked) return '';
  const subject = settings().subject;
  const exams = (await idb.all('exams')).filter((r) => r.subject === subject && r.id !== examId);
  const bank = (await idb.all('bank')).filter((r) => r.subject === subject);
  const fmt = (it, label) => `${label}. [평가 요소: ${it.element || '-'} / 근거: ${it.evidence || '-'}] ${it.stem}${it.choices?.length ? ` / 선지: ${it.choices.join(' | ')} / 정답 ${it.answer}` : ''}`;
  const parts = [];
  exams.forEach((r) => {
    const labels = labelMap(r.exam.items);
    parts.push(`### 출제 이력: ${r.examName || '(시험명 없음)'} · ${r.grade} · ${new Date(r.savedAt).toLocaleDateString('ko-KR')}`);
    r.exam.items.forEach((it) => parts.push(fmt(it, labels.get(it.uid))));
  });
  if (bank.length) {
    parts.push('### 문항 은행');
    bank.forEach((r, i) => parts.push(fmt(r.item, `은행${i + 1}`)));
  }
  return parts.join('\n');
}
async function updateHistoryCount() {
  const subject = settings().subject;
  const e = (await idb.all('exams')).filter((r) => r.subject === subject && r.id !== examId).length;
  const b = (await idb.all('bank')).filter((r) => r.subject === subject).length;
  $('#historyCount').textContent = `(${subject}: 이력 ${e}건, 문항 은행 ${b}문항)`;
}

async function docBlocks() {
  const blocks = [];
  for (const kind of Object.keys(files)) {
    for (const f of files[kind].filter(usable)) {
      const title = `[${KIND_LABEL[kind]}] ${f.name}`;
      if (f.type === 'pdf') {
        blocks.push({ type: 'document', title, source: { type: 'base64', media_type: 'application/pdf', data: await pdfData(f) } });
      } else if (f.type === 'text') {
        blocks.push({ type: 'document', title, source: { type: 'text', media_type: 'text/plain', data: f.text } });
      } else {
        blocks.push({ type: 'text', text: `다음 이미지: ${title}` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: f.media, data: f.data } });
      }
    }
    const p = pasted(kind);
    if (p) blocks.push({ type: 'document', title: `[${KIND_LABEL[kind]}] 붙여 넣은 본문`, source: { type: 'text', media_type: 'text/plain', data: p } });
  }
  const hist = await historyText();
  if (hist) blocks.push({ type: 'document', title: '[출제 이력·문항 은행] 이미 출제된 문항', source: { type: 'text', media_type: 'text/plain', data: hist } });
  // 자료는 대화 내내 그대로이므로 캐시해 수정 요청 비용을 줄인다
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return { blocks, withHistory: !!hist };
}

// 대화 첫 요청이면 자료+주문서를 함께, 아니면 요청문만
async function userContent(text) {
  if (messages.length) return [{ type: 'text', text }];
  const { blocks, withHistory } = await docBlocks();
  return [...blocks, { type: 'text', text: buildOrderForm(settings(), fileSummary(withHistory), diffCounts()) }, { type: 'text', text }];
}

function renderSummary() {
  const s = settings();
  const c = diffCounts();
  const t = TEMPLATE_KINDS.filter(has).map((k) => KIND_LABEL[k].replace(/^기존 틀 . /, '')).join(', ');
  const items = [
    ['과목·학년', `${s.subject} · ${s.grade}`],
    ['난이도', `${s.diffPreset} (${s.diffHigh}:${s.diffMid}:${s.diffLow})${c ? ` → 상${c[0]}·중${c[1]}·하${c[2]}` : ''}`],
    ['문항', `선택형 ${s.mcq} · 서술형 ${s.essay} · ${s.total}점`],
    ['출제 범위', s.range || '⚠ 미입력'],
    ['학습 자료', has('lesson') ? `${files.lesson.filter(usable).length}개 파일${pasted('lesson') ? ' + 붙여 넣은 본문' : ''} · 약 ${fmtSize(totalBytes())}` : '⚠ 없음'],
    ['기존 틀', t || '없음 (기본 양식으로 출력)'],
  ];
  const box = $('#summary');
  box.innerHTML = '';
  items.forEach(([k, v]) => {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = k;
    const sp = document.createElement('span'); sp.textContent = v;
    if (v.startsWith('⚠')) sp.className = 'warn';
    d.append(b, sp);
    box.appendChild(d);
  });
  updateSize();
}

// ---------- API ----------
async function client() {
  const mode = $('#authMode').value;
  const secret = mode === 'school' ? $('#schoolPw').value.trim() : $('#apiKey').value.trim();
  if (mode === 'school') {
    if ($('#rememberPw').checked) store.set('examMaker.schoolPw', secret); else store.del('examMaker.schoolPw');
  } else if ($('#rememberKey').checked) store.set('examMaker.apiKey', secret); else store.del('examMaker.apiKey');
  return makeClient(mode, secret);
}

function addBubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  if (role === 'user') div.textContent = text;
  else div.innerHTML = '<details class="think" hidden><summary>AI의 생각 요약</summary><div class="tt"></div></details><div class="body"></div>';
  $('#chat').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return div;
}

function setBusy(on, msg = '') {
  running = on ? running : null;
  $('#runStatus').textContent = msg;
  $('#runStatus').classList.remove('err');
  $('#stopBtn').disabled = !on;
  $('#autoBtn').disabled = on || phase !== 'idle';
  $('#analyzeBtn').disabled = on || phase !== 'idle';
  $('#startBtn').disabled = on || phase !== 'analyzed';
  $$('.ai').forEach((b) => { b.disabled = on; });
  document.body.classList.toggle('busy', on);
}
function showErr(msg) {
  $('#runStatus').textContent = msg;
  $('#runStatus').classList.add('err');
}

// 한 번의 AI 요청. schema가 있으면 JSON을 해석해 돌려준다
async function callAI({ text, label, schema, effort = 'high', maxTokens = 64000 }) {
  if (running) return null;
  if (totalBytes() > sizeLimit() && !messages.length) { showErr(`첨부 자료가 ${fmtSize(sizeLimit())}를 넘습니다. PDF 쪽 범위를 줄여 주세요.`); return null; }
  let c;
  try { c = await client(); } catch (e) { showErr(e.message); return null; }
  let content;
  try { content = await userContent(text); } catch (e) { showErr(`자료 준비 실패: ${e.message}`); return null; }
  messages.push({ role: 'user', content });
  addBubble('user', label);
  const bubble = addBubble('assistant');
  const body = $('.body', bubble);
  const think = $('.think', bubble);
  setBusy(true, 'AI가 자료를 읽고 있습니다… (자료 양에 따라 몇 분 걸릴 수 있습니다)');
  running = true;
  let frame = 0;
  let snapshot = '';
  const model = $('#model').value;
  try {
    const stream = c.beta.messages.stream(requestParams({ model, system: systemPrompt(), messages, schema, effort, maxTokens }));
    running = stream;
    stream.on('thinking', (_d, snap) => {
      think.hidden = false;
      $('.tt', think).textContent = snap;
      $('#runStatus').textContent = 'AI가 문항을 만들고 점검하는 중입니다…';
    });
    stream.on('text', (_d, snap) => {
      snapshot = snap;
      if (schema) {
        const n = (snap.match(/"stem"\s*:/g) || []).length;
        $('#runStatus').textContent = n ? `작성 중… 문항 ${n}개` : '작성 중…';
      } else {
        $('#runStatus').textContent = '작성 중…';
        if (!frame) frame = requestAnimationFrame(() => { body.innerHTML = md(snapshot); frame = 0; });
      }
    });
    const msg = await stream.finalMessage();
    running = null;
    const usd = usageCost(model, msg.usage || {});
    sessionUsd += usd;
    $('#costStatus').textContent = `이번 요청 약 ${won(usd)} · 지금까지 약 ${won(sessionUsd)} (1달러=1,400원 기준)`;
    if (msg.stop_reason === 'refusal') {
      messages.pop();
      bubble.remove();
      setBusy(false);
      showErr('AI가 이 요청을 거절했습니다. 자료나 요청 문구를 바꿔 다시 시도해 주세요.');
      return null;
    }
    const out = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed = null;
    if (schema) {
      try { parsed = JSON.parse(out); } catch {
        messages.pop();
        bubble.remove();
        setBusy(false);
        showErr(msg.stop_reason === 'max_tokens' ? '출력이 너무 길어 끊겼습니다. 문항 수를 줄이거나 다시 시도해 주세요.' : 'AI 응답을 읽지 못했습니다. 다시 시도해 주세요.');
        return null;
      }
      body.innerHTML = md(parsed.message || parsed.summary || '완료');
      if (parsed.analysisSummary) body.insertAdjacentHTML('beforeend', `<details><summary>자료 분석 요약</summary>${md(parsed.analysisSummary)}</details>`);
    } else {
      body.innerHTML = md(out);
    }
    messages.push({ role: 'assistant', content: msg.content });
    setBusy(false, '완료');
    return { text: out, parsed };
  } catch (e) {
    running = null;
    messages.pop(); // 실패한 요청은 기록에서 뺀다 (마지막 항목이라 이전 기록은 그대로)
    if (snapshot && !schema) body.innerHTML = md(snapshot); else bubble.remove();
    setBusy(false);
    showErr(errText(e));
    return null;
  }
}

$('#stopBtn').addEventListener('click', () => { if (running && running.abort) running.abort(); });

function checkReady() {
  if (!has('lesson')) { showErr('학습 자료가 없으면 출제할 수 없습니다. 2단계에서 첨부해 주세요.'); return false; }
  if (!$('#range').value.trim()) { showErr('출제 범위를 2단계에 입력해 주세요.'); return false; }
  const badPages = files.lesson.find((f) => f.type === 'pdf' && parsePages(f.pageSpec, f.pages) === null);
  if (badPages) { showErr(`"${badPages.name}"의 보낼 쪽 형식이 잘못되었습니다. 예: 12-40, 45`); return false; }
  if (!has('past') && !confirm('지난 문제지가 없으면 중복 판정을 할 수 없고 일반 양식으로 출력됩니다. 그래도 진행할까요?')) return false;
  return true;
}

$('#autoBtn').addEventListener('click', async () => {
  if (!checkReady()) return;
  const s = settings();
  const r = await callAI({ text: AUTO_MSG, schema: EXAM_SCHEMA, label: `⚡ 자동 출제 — ${s.subject} · ${s.grade} · 난이도 ${s.diffPreset}\n범위: ${s.range}` });
  if (r) { phase = 'generated'; setExam(normalizeExam(r.parsed, null), true); setBusy(false, '완료 — 아래에서 문항을 검토·편집하세요.'); }
});
$('#analyzeBtn').addEventListener('click', async () => {
  if (!checkReady()) return;
  const r = await callAI({ text: ANALYZE_MSG, label: '자료 분석 요청' });
  if (r) { phase = 'analyzed'; setBusy(false, '분석 보고를 확인하고 "출제 시작"을 누르세요.'); }
});
$('#startBtn').addEventListener('click', async () => {
  const r = await callAI({ text: START_MSG, schema: EXAM_SCHEMA, label: '출제 시작' });
  if (r) { phase = 'generated'; setExam(normalizeExam(r.parsed, null), true); setBusy(false, '완료 — 아래에서 문항을 검토·편집하세요.'); }
});

// 시험지 전체를 다시 받는 요청
async function examRequest(request, label) {
  if (!exam) return;
  const text = `${currentExamBlock(examForAI(exam))}\n\n## 요청\n${request}`;
  const r = await callAI({ text, schema: EXAM_SCHEMA, label });
  if (r) { setExam(normalizeExam(r.parsed, exam)); setBusy(false, '반영했습니다.'); }
}
$('#sendBtn').addEventListener('click', async () => {
  const t = $('#followText').value.trim();
  if (!t) return;
  await examRequest(t, t);
  if (!$('#runStatus').classList.contains('err')) $('#followText').value = '';
});
QUICK_REQUESTS.forEach((q) => {
  const b = document.createElement('button');
  b.className = 'chip ai';
  b.textContent = q.label;
  b.addEventListener('click', () => examRequest(q.text, q.label));
  $('#quick').appendChild(b);
});

// 한 문항만 다시 받는 요청
async function itemRequest(uid, kind) {
  const it = exam.items.find((x) => x.uid === uid);
  if (!it) return;
  const label = labelMap(exam.items).get(uid);
  const issues = (exam.review?.issues || []).filter((i) => i.uid === uid);
  const extra = kind === 'fix' ? `검토 지적: ${issues.map((i) => `${i.category} — ${i.message} (제안: ${i.suggestion})`).join(' / ')}\n이 지적을 고쳐 줘.` : ITEM_ACTIONS[kind];
  const text = `${currentExamBlock(examForAI(exam))}\n\n## 요청\n대상: ${label}번 문항 (uid: ${uid})\n${extra}\n결과는 바뀐 그 문항 하나만 item으로 내 주세요.`;
  const r = await callAI({ text, schema: ITEM_REPLY_SCHEMA, label: `${label}번: ${{ regen: '다시 만들기', harder: '난이도 ↑', easier: '난이도 ↓', choices: '선지 다듬기', fix: '검토 지적 고치기' }[kind]}`, effort: 'medium', maxTokens: 16000 });
  if (!r) return;
  const idx = exam.items.findIndex((x) => x.uid === uid);
  if (idx < 0) return;
  const next = cleanItem(r.parsed.item);
  next.uid = uid;
  next.locked = false;
  if (!next.tableCells.length) next.tableCells = exam.items[idx].tableCells;
  exam.items[idx] = next;
  if (exam.review) exam.review.issues = exam.review.issues.filter((i) => i.uid !== uid);
  commit();
  setBusy(false, `${label}번을 바꿨습니다.`);
}

// AI 검토
$('#reviewBtn').addEventListener('click', async () => {
  if (!exam) return;
  const text = `${currentExamBlock(examForAI(exam))}\n\n## 요청\n당신은 이제 출제자가 아니라 깐깐한 검토 위원입니다. 위 시험지를 첨부 자료와 대조해 문항마다 복수 정답, 정답 오류, 교과서 근거 없음, 범위 밖, 지난 문제지·출제 이력과 중복, 난이도 표기 부적절, 학년 수준, 오탈자를 점검하세요. 문제가 없는 문항은 issues에 넣지 마세요. uid는 시험지의 uid를 그대로 씁니다.`;
  const r = await callAI({ text, schema: REVIEW_SCHEMA, label: '🔎 AI 검토', effort: 'high', maxTokens: 32000 });
  if (!r) return;
  const uids = new Set(exam.items.map((it) => it.uid));
  exam.review = { summary: r.parsed.summary, issues: r.parsed.issues.filter((i) => uids.has(i.uid)), at: Date.now() };
  commit();
  setBusy(false, exam.review.issues.length ? `검토 결과 ${exam.review.issues.length}건을 찾았습니다. 카드에 표시했습니다.` : '검토 결과 문제를 찾지 못했습니다.');
});
$('#applyReviewBtn').addEventListener('click', async () => {
  if (!exam?.review?.issues.length) return;
  const req = `아래 검토 지적이 있는 문항만 고쳐 줘. 나머지 문항과 고정 문항은 그대로 둬.\n${exam.review.issues.map((i) => `- uid ${i.uid}: [${i.severity}/${i.category}] ${i.message} → 제안: ${i.suggestion}`).join('\n')}`;
  await examRequest(req, '검토 지적 고치기');
});

// ---------- 시험지 상태 ----------
function setExam(next, fresh = false) {
  exam = next;
  if (fresh || !examId) examId = `e${Date.now().toString(36)}`;
  activeTab = Math.min(activeTab, 6);
  commit();
  $('#editor').hidden = false;
}
let histTimer = 0;
function commit() {
  renderEditor();
  clearTimeout(histTimer);
  histTimer = setTimeout(saveHistory, 400);
}
async function saveHistory() {
  if (!exam) return;
  const s = settings();
  await idb.put('exams', {
    id: examId, savedAt: Date.now(), subject: s.subject, grade: s.grade, examName: s.examName,
    settings: Object.fromEntries(FIELDS.map((f) => [f, $(`#${f}`).value])), exam,
  });
  if (!$('#panel-4').hidden) renderLists();
}
function emptyExam() {
  const s = settings();
  return {
    header: { title: `${s.examName} ${s.subject} (${s.grade})`.trim(), notices: [] },
    items: [], tableColumns: [], analysisSummary: '', duplicateReport: '', message: '', review: null, bForm: null,
  };
}

// ---------- 편집기 화면 ----------
function renderEditor() {
  if (!exam) { $('#editor').hidden = true; return; }
  $('#editor').hidden = false;
  const lock = exam.items.filter((it) => it.locked).length;
  $('#editorInfo').textContent = `${exam.items.length}문항 · 고정 ${lock}`;
  $('#bClearBtn').hidden = !exam.bForm;
  $('#bFormBtn').textContent = exam.bForm ? 'B형 다시 섞기' : 'A/B형 만들기';
  renderChecks();
  renderReview();
  renderCards();
  renderTabs();
}

function renderChecks() {
  if (!exam) return;
  const s = settings();
  const list = [...runChecks(exam, s, diffCounts()), ...(exam.bForm ? bChecks(exam, s) : [])];
  $('#checks').innerHTML = list.map((c) => `<span class="ck ${c.ok ? 'ok' : c.warn ? 'warn' : 'bad'}">${c.ok ? '✓' : c.warn ? '!' : '✗'} ${esc(c.text)}</span>`).join('');
}

function renderReview() {
  const box = $('#reviewBox');
  const rv = exam.review;
  $('#applyReviewBtn').hidden = !(rv && rv.issues.length);
  if (!rv) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<b>AI 검토</b> ${md(rv.summary)}${rv.issues.length ? `<p>${rv.issues.length}건 — 해당 문항 카드에 표시했습니다.</p>` : ''}`;
}

function renderCards() {
  const labels = labelMap(exam.items);
  const issuesBy = new Map();
  (exam.review?.issues || []).forEach((i) => { if (!issuesBy.has(i.uid)) issuesBy.set(i.uid, []); issuesBy.get(i.uid).push(i); });
  const box = $('#cards');
  box.innerHTML = '';
  exam.items.forEach((it, idx) => {
    const card = document.createElement('article');
    card.className = `card${it.locked ? ' locked' : ''}`;
    card.draggable = true;
    card.dataset.uid = it.uid;
    const iss = issuesBy.get(it.uid) || [];
    const choices = it.type === '선택형'
      ? `<ol class="ch">${it.choices.map((c, i) => `<li class="${String(i + 1) === it.answer ? 'ans' : ''}"><span>${SYMBOLS[i]}</span> ${esc(c)}</li>`).join('')}</ol>` : '';
    card.innerHTML = `
      <header><span class="drag" title="끌어서 순서 바꾸기">⠿</span><b>${esc(labels.get(it.uid))}</b>
        <span class="badge d${esc(it.difficulty)}">${esc(it.difficulty)}</span><span class="badge">${it.points}점</span><span class="badge">${esc(it.type)}</span>
        ${it.locked ? '<span class="badge lock">🔒 고정</span>' : ''}${iss.length ? `<span class="badge issue">검토 ${iss.length}</span>` : ''}
        <span class="meta">${esc(it.element)}</span></header>
      ${it.passage ? `<div class="passage">${md(it.passage)}</div>` : ''}
      <p class="stem">${esc(it.stem)}</p>${choices}
      ${it.type === '서술형' ? `${it.conditions ? `<p class="cond"><b>조건</b> ${esc(it.conditions)}</p>` : ''}<details><summary>모범 답안·채점 기준</summary>${md(it.answer)}<ul>${it.rubric.map((r) => `<li>${esc(r.criterion)} — ${r.points}점 (${esc(r.partial)})</li>`).join('')}</ul></details>` : ''}
      <details><summary>근거·해설</summary><p class="meta">${esc(it.unit)} · ${esc(it.standard)} · 근거: ${esc(it.evidence)}</p>${md(it.explanation)}</details>
      ${iss.map((i) => `<div class="issue-box ${i.severity === '오류' ? 'err' : ''}"><b>${esc(i.severity)} · ${esc(i.category)}</b> ${esc(i.message)}<br><small>제안: ${esc(i.suggestion)}</small></div>`).join('')}
      <footer>
        <button data-a="up" title="위로" ${idx === 0 ? 'disabled' : ''}>↑</button><button data-a="down" title="아래로" ${idx === exam.items.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-a="lock">${it.locked ? '고정 해제' : '🔒 고정'}</button>
        <button data-a="edit">✏️ 수정</button>
        <button data-a="regen" class="ai" ${it.locked ? 'disabled' : ''}>🔄 다시 만들기</button>
        <button data-a="harder" class="ai" ${it.locked ? 'disabled' : ''}>난이도↑</button>
        <button data-a="easier" class="ai" ${it.locked ? 'disabled' : ''}>난이도↓</button>
        ${it.type === '선택형' ? `<button data-a="choices" class="ai" ${it.locked ? 'disabled' : ''}>선지 다듬기</button>` : ''}
        ${iss.length ? `<button data-a="fix" class="ai" ${it.locked ? 'disabled' : ''}>지적 고치기</button>` : ''}
        <button data-a="bank">⭐ 은행에 저장</button>
        <button data-a="del" class="danger">삭제</button>
      </footer>`;
    box.appendChild(card);
  });
  if (running) $$('#cards .ai').forEach((b) => { b.disabled = true; });
}

$('#cards').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn || btn.disabled) return;
  const uid = btn.closest('.card').dataset.uid;
  const idx = exam.items.findIndex((x) => x.uid === uid);
  const it = exam.items[idx];
  const a = btn.dataset.a;
  if (a === 'up' || a === 'down') {
    const j = a === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= exam.items.length) return;
    [exam.items[idx], exam.items[j]] = [exam.items[j], exam.items[idx]];
    sortTypes(); commit();
  } else if (a === 'lock') {
    it.locked = !it.locked; commit();
  } else if (a === 'edit') {
    openEdit(uid);
  } else if (a === 'bank') {
    await saveToBank(it);
    btn.textContent = '저장됨 ✓';
  } else if (a === 'del') {
    if (!confirm(`${labelMap(exam.items).get(uid)}번 문항을 삭제할까요?`)) return;
    exam.items.splice(idx, 1);
    if (exam.review) exam.review.issues = exam.review.issues.filter((i) => i.uid !== uid);
    commit();
  } else {
    await itemRequest(uid, a);
  }
});

// 끌어서 순서 바꾸기
let dragUid = null;
$('#cards').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  dragUid = card.dataset.uid;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragUid);
});
$('#cards').addEventListener('dragend', () => { dragUid = null; $$('.card.dragging, .card.dropto').forEach((c) => c.classList.remove('dragging', 'dropto')); });
$('#cards').addEventListener('dragover', (e) => {
  if (!dragUid) return;
  e.preventDefault();
  $$('.card.dropto').forEach((c) => c.classList.remove('dropto'));
  const card = e.target.closest('.card');
  if (card && card.dataset.uid !== dragUid) card.classList.add('dropto');
});
$('#cards').addEventListener('drop', (e) => {
  e.preventDefault();
  const card = e.target.closest('.card');
  if (!dragUid || !card || card.dataset.uid === dragUid) return;
  const from = exam.items.findIndex((x) => x.uid === dragUid);
  const [moved] = exam.items.splice(from, 1);
  const to = exam.items.findIndex((x) => x.uid === card.dataset.uid);
  exam.items.splice(from <= to ? to + 1 : to, 0, moved);
  dragUid = null;
  sortTypes(); commit();
});
// 선택형이 서술형보다 앞에 오도록 (각자 순서 유지)
function sortTypes() {
  exam.items = [...exam.items.filter((x) => x.type === '선택형'), ...exam.items.filter((x) => x.type !== '선택형')];
}

$('#addItemBtn').addEventListener('click', () => {
  if (!exam) setExam(emptyExam(), true);
  const it = cleanItem({ type: '선택형', difficulty: '중', points: 4, choices: Array(Number(settings().choices) || 5).fill('') });
  it.uid = newUid();
  exam.items.push(it);
  sortTypes(); commit();
  openEdit(it.uid);
});

// A/B형
$('#bFormBtn').addEventListener('click', () => { if (!exam) return; exam.bForm = makeBForm(exam); activeTab = 5; commit(); });
$('#bClearBtn').addEventListener('click', () => { if (!exam) return; exam.bForm = null; activeTab = 0; commit(); });

// ---------- 수정 창 ----------
let editUid = null;
function openEdit(uid) {
  const it = exam.items.find((x) => x.uid === uid);
  if (!it) return;
  editUid = uid;
  const f = $('#editForm');
  $('#editLabel').textContent = `${labelMap(exam.items).get(uid)}번`;
  f.type.value = it.type;
  f.difficulty.value = it.difficulty;
  f.points.value = it.points;
  f.answerNo.value = it.type === '선택형' ? it.answer : '';
  f.stem.value = it.stem;
  f.passage.value = it.passage;
  f.choices.value = it.choices.join('\n');
  f.fixedChoiceOrder.checked = it.fixedChoiceOrder;
  f.conditions.value = it.conditions;
  f.essayAnswer.value = it.type === '서술형' ? it.answer : '';
  f.rubric.value = it.rubric.map((r) => `${r.criterion} | ${r.points} | ${r.partial}`).join('\n');
  f.explanation.value = it.explanation;
  f.unit.value = it.unit;
  f.standard.value = it.standard;
  f.element.value = it.element;
  f.evidence.value = it.evidence;
  $('#editDlg').showModal();
}
$('#editDlg').addEventListener('close', () => {
  if ($('#editDlg').returnValue !== 'save' || !editUid) { editUid = null; return; }
  const idx = exam.items.findIndex((x) => x.uid === editUid);
  if (idx < 0) return;
  const f = $('#editForm');
  const old = exam.items[idx];
  const type = f.type.value;
  const next = cleanItem({
    ...old,
    type,
    difficulty: f.difficulty.value,
    points: f.points.value,
    stem: f.stem.value,
    passage: f.passage.value,
    choices: type === '선택형' ? f.choices.value.split('\n').map((c) => c.trim()).filter(Boolean) : [],
    answer: type === '선택형' ? f.answerNo.value : f.essayAnswer.value,
    fixedChoiceOrder: f.fixedChoiceOrder.checked,
    conditions: f.conditions.value,
    rubric: f.rubric.value.split('\n').map((l) => l.split('|').map((p) => p.trim())).filter((p) => p[0])
      .map(([criterion, points, partial]) => ({ criterion, points, partial: partial || '' })),
    explanation: f.explanation.value,
    unit: f.unit.value,
    standard: f.standard.value,
    element: f.element.value,
    evidence: f.evidence.value,
  });
  next.uid = old.uid;
  next.locked = old.locked;
  exam.items[idx] = next;
  if (exam.review) exam.review.issues = exam.review.issues.filter((i) => i.uid !== old.uid);
  editUid = null;
  sortTypes(); commit();
});

// ---------- 결과물 탭 ----------
function tabList() {
  const t = [
    ['시험지', () => paperHTML(exam, exam.items, settings(), exam.bForm ? 'A형' : '')],
    ['정답·해설', () => answersHTML(exam, exam.items, exam.bForm ? 'A형' : '')],
    ['서술형 채점', () => essayHTML(exam)],
    ['이원목적분류표', () => tableHTML(exam)],
    ['분석·중복 점검', () => `<h2>자료 분석 요약</h2>${md(exam.analysisSummary || '(없음)')}<h2>중복 점검 결과</h2>${md(exam.duplicateReport || '(없음)')}`],
  ];
  if (exam.bForm) {
    t.push(['B형 시험지', () => paperHTML(exam, bItems(exam), settings(), 'B형')]);
    t.push(['B형 정답', () => answersHTML(exam, bItems(exam), 'B형')]);
  }
  return t;
}
function renderTabs() {
  const list = tabList();
  if (activeTab >= list.length) activeTab = 0;
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  list.forEach(([name], i) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === activeTab));
    b.className = i === activeTab ? 'on' : '';
    b.addEventListener('click', () => { activeTab = i; renderTabs(); });
    tabs.appendChild(b);
  });
  $('#tabbody').innerHTML = `<div class="preview">${list[activeTab][1]()}</div>`;
}

// ---------- 내보내기 ----------
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function baseName() { const s = settings(); return `${s.subject}_${s.examName || '평가문항'}`.replace(/[\\/:*?"<>|\s]+/g, '_'); }

function printHTML(html) {
  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되었습니다. 팝업을 허용해 주세요.'); return; }
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(baseName())}</title><style>${PRINT_CSS}</style></head><body>${html}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
$('#printTabBtn').addEventListener('click', () => { if (exam) printHTML(tabList()[activeTab][1]()); });
$('#printAllBtn').addEventListener('click', () => {
  if (!exam) return;
  printHTML(tabList().filter(([n]) => n !== '분석·중복 점검').map(([, f], i) => `<div class="${i ? 'pb' : ''}">${f()}</div>`).join(''));
});
$('#docxBtn').addEventListener('click', async () => {
  if (!exam) return;
  try { download(`${baseName()}.docx`, await buildDocx(exam, settings())); } catch (e) { alert(`Word 저장 실패: ${e.message}`); }
});
$('#mdBtn').addEventListener('click', () => { if (exam) download(`${baseName()}.md`, new Blob([examMarkdown(exam, settings())], { type: 'text/markdown' })); });

// ---------- 예상 비용 ----------
$('#estimateBtn').addEventListener('click', async () => {
  const out = $('#estimate');
  out.classList.remove('err');
  if (!has('lesson')) { out.textContent = '학습 자료를 먼저 첨부하세요.'; return; }
  out.textContent = '계산 중…';
  try {
    const c = await client();
    const model = $('#model').value;
    const msgs = messages.length ? [...messages, { role: 'user', content: [{ type: 'text', text: '요청' }] }]
      : [{ role: 'user', content: await userContent(AUTO_MSG) }];
    const r = await c.beta.messages.countTokens({ model, system: systemPrompt(), messages: msgs });
    const p = PRICES[model];
    const s = settings();
    const [lo, hi] = outputEstimate(Number(s.mcq) || 0, Number(s.essay) || 0);
    const inUsd = (r.input_tokens * p.cw) / 1e6; // 첫 요청은 캐시에 쓰므로 캐시 쓰기 단가
    out.textContent = `자동 출제 1회: 입력 ${r.input_tokens.toLocaleString()}토큰 · 예상 ${won(inUsd + (lo * p.out) / 1e6)} ~ ${won(inUsd + (hi * p.out) / 1e6)} (수정 요청은 자료가 캐시되어 훨씬 저렴)`;
  } catch (e) { out.textContent = errText(e); out.classList.add('err'); }
});

// ---------- 새 시험지 ----------
$('#resetBtn').addEventListener('click', () => {
  if (running) return;
  if ((messages.length || exam) && !confirm('새 시험지를 시작할까요? 지금 시험지는 출제 이력에 저장되어 있습니다.')) return;
  messages = []; phase = 'idle'; exam = null; examId = null; activeTab = 0;
  $('#chat').innerHTML = '';
  $('#editor').hidden = true;
  setBusy(false);
});

// ---------- 이력·문항 은행 ----------
async function saveToBank(it) {
  const s = settings();
  const { locked, ...item } = it;
  await idb.put('bank', { id: `${it.uid}_${Date.now().toString(36)}`, savedAt: Date.now(), subject: s.subject, grade: s.grade, unit: it.unit, item });
}
async function renderLists() {
  const exams = (await idb.all('exams')).sort((a, b) => b.savedAt - a.savedAt);
  const hl = $('#historyList');
  hl.innerHTML = exams.length ? '' : '<p class="hint">아직 출제 이력이 없습니다.</p>';
  exams.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    row.innerHTML = `<div><b>${esc(r.examName || '(시험명 없음)')}</b> <span class="badge">${esc(r.subject)}</span> <span class="badge">${esc(r.grade)}</span>${r.id === examId ? ' <span class="badge lock">편집 중</span>' : ''}<br><small>${new Date(r.savedAt).toLocaleString('ko-KR')} · ${r.exam.items.length}문항</small></div>
      <div class="acts"><button class="ghost" data-a="load">불러오기</button><button class="ghost danger" data-a="del">삭제</button></div>`;
    row.querySelector('[data-a=load]').addEventListener('click', () => loadHistory(r));
    row.querySelector('[data-a=del]').addEventListener('click', async () => {
      if (!confirm('이 출제 이력을 삭제할까요?')) return;
      await idb.del('exams', r.id);
      if (r.id === examId) examId = null;
      renderLists();
    });
    hl.appendChild(row);
  });

  const bank = (await idb.all('bank')).sort((a, b) => b.savedAt - a.savedAt);
  const sel = $('#bankSubject');
  const cur = sel.value;
  const subjects = [...new Set(bank.map((r) => r.subject))];
  sel.innerHTML = '<option value="">모든 과목</option>' + subjects.map((s) => `<option>${esc(s)}</option>`).join('');
  sel.value = subjects.includes(cur) ? cur : '';
  const q = $('#bankSearch').value.trim();
  const shown = bank.filter((r) => (!sel.value || r.subject === sel.value)
    && (!q || [r.item.stem, r.unit, r.item.element, r.item.passage].join(' ').includes(q)));
  const bl = $('#bankList');
  bl.innerHTML = shown.length ? '' : '<p class="hint">문항 은행이 비어 있습니다. 문항 카드의 ⭐ 버튼으로 저장하세요.</p>';
  shown.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    row.innerHTML = `<div><span class="badge">${esc(r.subject)}</span> <span class="badge d${esc(r.item.difficulty)}">${esc(r.item.difficulty)}</span> <span class="badge">${esc(r.item.type)}</span> ${esc(r.unit)}<br>${esc(r.item.stem)}</div>
      <div class="acts"><button class="ghost" data-a="add">현재 시험지에 넣기</button><button class="ghost danger" data-a="del">삭제</button></div>`;
    row.querySelector('[data-a=add]').addEventListener('click', () => {
      if (!exam) setExam(emptyExam(), true);
      const it = cleanItem(r.item);
      it.uid = newUid();
      it.locked = true;
      exam.items.push(it);
      sortTypes(); commit();
      alert('현재 시험지에 고정 문항으로 넣었습니다. 3단계에서 확인하세요.');
    });
    row.querySelector('[data-a=del]').addEventListener('click', async () => { await idb.del('bank', r.id); renderLists(); });
    bl.appendChild(row);
  });
}
$('#bankSearch').addEventListener('input', renderLists);
$('#bankSubject').addEventListener('change', renderLists);

function loadHistory(r) {
  if (running) return;
  if (exam && r.id !== examId && !confirm('지금 시험지를 닫고 이 이력을 불러올까요? (지금 시험지도 이력에 저장되어 있습니다)')) return;
  Object.entries(r.settings || {}).forEach(([f, v]) => { if ($(`#${f}`) && f !== 'authMode') $(`#${f}`).value = v; });
  saveSettings(); syncSeg(); onSubjectChange(); updateDiffCount();
  messages = []; phase = 'generated';
  $('#chat').innerHTML = '';
  exam = r.exam;
  examId = r.id;
  activeTab = 0;
  renderEditor();
  setBusy(false, '이력을 불러왔습니다. AI 수정 요청을 보내면 지금 첨부된 자료와 함께 새로 대화를 시작합니다.');
  go(3);
}

// ---------- 프롬프트 복사 ----------
async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  const old = btn.textContent;
  btn.textContent = '복사했습니다 ✓';
  setTimeout(() => { btn.textContent = old; }, 1500);
}
const MANUAL_FORMAT = `\n\n(이 대화에서는 JSON 대신 마크다운으로, # [시험지] / # [정답 및 해설] / # [서술형 답안 및 채점 기준] / # [이원목적분류표] / # [중복 점검 결과] 다섯 제목으로 나눠 출력해 주세요.)`;
$('#copySystem').addEventListener('click', (e) => copy(systemPrompt() + MANUAL_FORMAT, e.currentTarget));
$('#copyOrder').addEventListener('click', async (e) => {
  const extra = Object.keys(files).map((k) => (pasted(k) ? `\n\n[${KIND_LABEL[k]} — 붙여 넣은 본문]\n${pasted(k)}` : '')).join('');
  copy(`${buildOrderForm(settings(), fileSummary(false), diffCounts())}${extra}\n\n자료 분석부터 출제·자체 점검까지 한 번에 마친 뒤 최종 결과를 내 주세요.`, e.currentTarget);
});

// ---------- 프롬프트 3: 기타 교과 응용본 ----------
$('#genGuide').addEventListener('click', async () => {
  const st = $('#guideStatus');
  st.classList.remove('err');
  let c;
  try { c = await client(); } catch (e) { st.textContent = `${e.message} (3단계에서 키를 입력하세요)`; st.classList.add('err'); return; }
  const s = settings();
  const ta = $('#subjectGuide');
  const before = ta.value;
  st.textContent = `${s.subject} 응용 지침을 만드는 중…`;
  $('#genGuide').disabled = true;
  try {
    const params = requestParams({ model: $('#model').value, system: '당신은 중학교 평가 전문가입니다.', messages: [{ role: 'user', content: buildPrompt3(s.subject, s.grade, s.extra) }], effort: 'medium', maxTokens: 8000 });
    const stream = c.beta.messages.stream(params);
    stream.on('text', (_d, snap) => { ta.value = snap; });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('AI가 요청을 거절했습니다.');
    ta.value = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    store.set(guideKey(), ta.value);
    st.textContent = '완료 — 내용을 확인하고 필요하면 고쳐 쓰세요.';
    refreshPromptPreview();
  } catch (e) {
    ta.value = before;
    st.textContent = errText(e); st.classList.add('err');
  } finally {
    $('#genGuide').disabled = false;
  }
});

// ---------- 시작 ----------
async function init() {
  loadSettings();
  onSubjectChange();
  const school = await schoolStatus();
  if (!school.enabled) {
    $('#authSeg button[data-v=school]').disabled = true;
    $('#schoolOff').hidden = false;
    $('#authMode').value = 'personal';
  }
  syncSeg();
  updateDiffCount();
  setBusy(false);
  await loadTemplates();
  updateSize();
}
init();
