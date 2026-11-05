import {
  PROMPT_COMMON, PROMPT_KOREAN, buildPrompt3, buildOrderForm, START_MSG, QUICK_REQUESTS,
} from './prompts.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm';
const KIND_LABEL = { textbook: '교과서 단원', past: '기존 평가지(문제+정답)', form: '출제원안 양식' };
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_REQUEST_BYTES = 30 * 1024 * 1024; // API 한도 32MB, 여유분 확보
const SECTION_RE = /^# \[(.+?)\]\s*$/gm;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- 저장소 (실패해도 동작) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

// ---------- 상태 ----------
const files = { textbook: [], past: [], form: [] };
let messages = [];          // API 대화 기록 (추가만 함)
let phase = 'idle';         // idle → analyzed → generated
let running = null;         // 진행 중 스트림
let sections = [];          // [{title, md}]
let activeTab = 0;
let Anthropic = null;

// ---------- 단계 이동 ----------
function go(n) {
  $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${n}`; });
  $$('.step').forEach((b) => b.classList.toggle('active', b.dataset.step === String(n)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.step').forEach((b) => b.addEventListener('click', () => go(b.dataset.step)));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ---------- 주문서 ----------
const FIELDS = ['school', 'grade', 'subject', 'subjectOther', 'examName', 'range', 'mcq', 'essay', 'total',
  'choices', 'scoreRule', 'diffHigh', 'diffMid', 'diffLow', 'extra', 'subjectGuide', 'model'];

function settings() {
  const s = {};
  FIELDS.forEach((f) => { s[f] = $(`#${f}`).value.trim(); });
  if (s.subject === '기타') s.subject = s.subjectOther || '기타';
  return s;
}
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(store.get('examMaker.settings') || '{}'); } catch { saved = {}; }
  FIELDS.forEach((f) => { if (saved[f] != null) $(`#${f}`).value = saved[f]; });
  const key = store.get('examMaker.apiKey');
  if (key) { $('#apiKey').value = key; $('#rememberKey').checked = true; }
}
function saveSettings() {
  const raw = {};
  FIELDS.forEach((f) => { raw[f] = $(`#${f}`).value; });
  store.set('examMaker.settings', JSON.stringify(raw));
}
function onSubjectChange() {
  const sub = $('#subject').value;
  $('#subjectOtherWrap').hidden = sub !== '기타';
  const guide = $('#subjectGuide');
  if (sub === '국어' && !guide.value.trim()) guide.value = PROMPT_KOREAN;
  if (sub !== '국어' && guide.value.trim() === PROMPT_KOREAN.trim()) guide.value = '';
  refreshPromptPreview();
}
FIELDS.forEach((f) => $(`#${f}`).addEventListener('input', () => { saveSettings(); refreshPromptPreview(); }));
$('#subject').addEventListener('change', () => { onSubjectChange(); saveSettings(); });

function systemPrompt() {
  const g = $('#subjectGuide').value.trim();
  return g ? `${PROMPT_COMMON}\n\n${g}` : PROMPT_COMMON;
}
function refreshPromptPreview() { $('#promptText').textContent = systemPrompt(); }
$('#viewPrompt').addEventListener('click', () => {
  refreshPromptPreview();
  $('#promptPreview').open = !$('#promptPreview').open;
});

// ---------- 파일 ----------
function readAs(file, how) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    if (how === 'text') r.readAsText(file); else r.readAsDataURL(file);
  });
}
async function addFile(kind, file) {
  const name = file.name;
  const lower = name.toLowerCase();
  const entry = { name, size: file.size };
  if (lower.endsWith('.hwp') || lower.endsWith('.hwpx')) {
    entry.type = 'hwp';
  } else if (file.type === 'application/pdf' || lower.endsWith('.pdf')) {
    entry.type = 'pdf';
    entry.data = (await readAs(file, 'url')).split(',')[1];
  } else if (file.type.startsWith('image/')) {
    if (!IMAGE_TYPES.includes(file.type)) {
      entry.type = 'bad';
    } else {
      entry.type = 'image';
      entry.media = file.type;
      entry.data = (await readAs(file, 'url')).split(',')[1];
    }
  } else {
    entry.type = 'text';
    entry.text = await readAs(file, 'text');
  }
  files[kind].push(entry);
  renderFiles(kind);
}
function renderFiles(kind) {
  const ul = $(`.drop[data-kind="${kind}"] .files`);
  ul.innerHTML = '';
  files[kind].forEach((f, i) => {
    const li = document.createElement('li');
    const warn = f.type === 'hwp' ? ' — HWP는 읽을 수 없어 전송하지 않습니다. PDF로 저장해 주세요.'
      : f.type === 'bad' ? ' — 지원하지 않는 이미지 형식(JPG·PNG·GIF·WEBP만 가능)' : '';
    li.className = warn ? 'bad' : '';
    li.textContent = `${f.name} (${fmtSize(f.size)})${warn}`;
    const x = document.createElement('button');
    x.textContent = '삭제';
    x.className = 'x';
    x.addEventListener('click', () => { files[kind].splice(i, 1); renderFiles(kind); });
    li.appendChild(x);
    ul.appendChild(li);
  });
  updateSize();
}
function fmtSize(b) { return b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.ceil(b / 1024)}KB`; }
function usable(f) { return f.type === 'pdf' || f.type === 'image' || f.type === 'text'; }
function totalBytes() {
  let n = 0;
  Object.values(files).flat().filter(usable).forEach((f) => { n += f.data ? f.data.length : f.text.length * 3; });
  return n;
}
function updateSize() {
  const n = totalBytes();
  const el = $('#sizeStatus');
  el.textContent = n ? `전송 크기 약 ${fmtSize(n)} / 최대 30MB` : '';
  el.classList.toggle('err', n > MAX_REQUEST_BYTES);
}
$$('.drop').forEach((d) => {
  const kind = d.dataset.kind;
  const input = $('input[type=file]', d);
  input.addEventListener('change', async () => {
    for (const f of input.files) {
      try { await addFile(kind, f); } catch (e) { alert(`${f.name} 읽기 실패: ${e.message}`); }
    }
    input.value = '';
  });
  d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', async (e) => {
    e.preventDefault();
    d.classList.remove('over');
    for (const f of e.dataTransfer.files) {
      try { await addFile(kind, f); } catch (err) { alert(`${f.name} 읽기 실패: ${err.message}`); }
    }
  });
  $('textarea', d).addEventListener('input', updateSize);
});
function pasted(kind) { return $(`.drop[data-kind="${kind}"] textarea`).value.trim(); }

function fileSummary() {
  return Object.keys(files).map((k) => {
    const names = files[k].filter(usable).map((f) => f.name);
    if (pasted(k)) names.push('(붙여 넣은 본문)');
    return `- ${KIND_LABEL[k]}: ${names.length ? names.join(', ') : '없음'}`;
  }).join('\n');
}

function firstUserContent() {
  const blocks = [];
  for (const kind of Object.keys(files)) {
    for (const f of files[kind].filter(usable)) {
      const title = `[${KIND_LABEL[kind]}] ${f.name}`;
      if (f.type === 'pdf') {
        blocks.push({ type: 'document', title, source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
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
  // 자료는 대화 내내 그대로이므로 캐시해 수정 요청 비용을 줄인다
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  blocks.push({ type: 'text', text: buildOrderForm(settings(), fileSummary()) });
  return blocks;
}

// ---------- API ----------
async function client() {
  const key = $('#apiKey').value.trim();
  if (!key) throw new Error('API 키를 입력해 주세요. (키가 없으면 B. 프롬프트만 복사를 쓰세요)');
  if ($('#rememberKey').checked) store.set('examMaker.apiKey', key); else store.del('examMaker.apiKey');
  if (!Anthropic) {
    try { Anthropic = (await import(SDK_URL)).default; } catch {
      throw new Error('Anthropic SDK를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }
  }
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

function requestParams(system, msgs) {
  return {
    model: $('#model').value,
    max_tokens: 64000,
    system,
    messages: msgs,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
    // 안전 분류기가 거절하면 서버가 다른 모델로 자동 재시도
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
}

function errText(e) {
  if (!Anthropic) return e.message;
  if (e instanceof Anthropic.APIUserAbortError) return '중단했습니다.';
  if (e instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다.';
  if (e instanceof Anthropic.PermissionDeniedError) return '이 키로는 해당 모델을 쓸 수 없습니다.';
  if (e instanceof Anthropic.RateLimitError) return '요청 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요.';
  if (e instanceof Anthropic.BadRequestError) return `요청 오류: ${e.message} (파일이 너무 크거나 페이지가 많으면 나눠 올려 주세요)`;
  if (e instanceof Anthropic.InternalServerError) return '서버가 혼잡합니다. 잠시 뒤 다시 시도해 주세요.';
  if (e instanceof Anthropic.APIConnectionError) return '네트워크 연결에 실패했습니다.';
  return e.message;
}

// ---------- 대화 화면 ----------
function md(text) { return DOMPurify.sanitize(marked.parse(text || '')); }

function addBubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  if (role === 'user') div.textContent = text;
  else div.innerHTML = '<details class="think" hidden><summary>AI의 생각 요약</summary><div class="tt"></div></details><div class="body"></div>';
  $('#chat').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function setBusy(on, msg = '') {
  $('#runStatus').textContent = msg;
  $('#runStatus').classList.remove('err');
  $('#stopBtn').disabled = !on;
  $('#analyzeBtn').disabled = on || phase !== 'idle';
  $('#startBtn').disabled = on || phase !== 'analyzed';
  $('#sendBtn').disabled = on;
  $('#genGuide').disabled = on;
}
function showErr(msg) {
  $('#runStatus').textContent = msg;
  $('#runStatus').classList.add('err');
}

async function send(userContent, label) {
  let c;
  try { c = await client(); } catch (e) { showErr(e.message); return null; }
  messages.push({ role: 'user', content: userContent });
  addBubble('user', label);
  const bubble = addBubble('assistant');
  const body = $('.body', bubble);
  const think = $('.think', bubble);
  setBusy(true, 'AI가 자료를 읽고 있습니다…');

  let frame = 0;
  let snapshot = '';
  try {
    const stream = c.beta.messages.stream(requestParams(systemPrompt(), messages));
    running = stream;
    stream.on('thinking', (_d, snap) => {
      think.hidden = false;
      $('.tt', think).textContent = snap;
      $('#runStatus').textContent = 'AI가 검토 중입니다…';
    });
    stream.on('text', (_d, snap) => {
      snapshot = snap;
      $('#runStatus').textContent = '작성 중…';
      if (!frame) frame = requestAnimationFrame(() => { body.innerHTML = md(snapshot); frame = 0; });
    });
    const msg = await stream.finalMessage();
    running = null;
    if (msg.stop_reason === 'refusal') {
      messages.pop();
      body.innerHTML = md(snapshot);
      setBusy(false);
      showErr('AI가 이 요청을 거절했습니다. 자료나 요청 문구를 바꿔 다시 시도해 주세요.');
      return null;
    }
    messages.push({ role: 'assistant', content: msg.content });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    body.innerHTML = md(text);
    setBusy(false, msg.stop_reason === 'max_tokens' ? '출력이 길어 중간에 끊겼습니다. "이어서 써 줘"라고 요청하세요.' : '완료');
    return text;
  } catch (e) {
    running = null;
    messages.pop(); // 실패한 요청은 기록에서 뺀다 (마지막 항목이라 이전 기록은 그대로)
    if (snapshot) body.innerHTML = md(snapshot); else bubble.remove();
    setBusy(false);
    showErr(errText(e));
    return null;
  }
}

$('#stopBtn').addEventListener('click', () => { if (running) running.abort(); });

$('#analyzeBtn').addEventListener('click', async () => {
  const hasBook = files.textbook.some(usable) || pasted('textbook');
  if (!hasBook) { showErr('교과서 단원 자료가 없으면 출제할 수 없습니다. 2단계에서 첨부해 주세요.'); return; }
  if (totalBytes() > MAX_REQUEST_BYTES) { showErr('첨부 자료가 30MB를 넘습니다. 필요한 쪽만 남겨 주세요.'); return; }
  if (!(files.past.some(usable) || pasted('past')) && !confirm('기존 평가지가 없으면 중복 판정을 할 수 없습니다. 그래도 진행할까요?')) return;
  const text = await send(firstUserContent(), `자료 분석 요청\n${fileSummary()}`);
  if (text != null) { phase = 'analyzed'; setBusy(false, '분석 보고를 확인하고 "출제 시작"을 누르세요.'); }
});

$('#startBtn').addEventListener('click', async () => {
  const text = await send([{ type: 'text', text: START_MSG }], '출제 시작');
  if (text != null) {
    phase = 'generated';
    $('#followup').hidden = false;
    updateResults(text);
    setBusy(false, '완료 — 아래 최종 산출물을 확인하세요.');
  }
});

$('#sendBtn').addEventListener('click', async () => {
  const t = $('#followText').value.trim();
  if (!t) return;
  const text = await send([{ type: 'text', text: t }], t);
  if (text != null) {
    $('#followText').value = '';
    updateResults(text);
  }
});

$('#resetBtn').addEventListener('click', () => {
  if (running) return;
  if (messages.length && !confirm('대화를 초기화할까요? 첨부 파일과 주문서는 그대로 남습니다.')) return;
  messages = []; phase = 'idle'; sections = [];
  $('#chat').innerHTML = '';
  $('#followup').hidden = true;
  $('#results').hidden = true;
  setBusy(false);
});

// 빠른 요청
QUICK_REQUESTS.forEach((q) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = q.replace('{n}번 ', '').replace('{n}번', '');
  b.addEventListener('click', () => {
    const n = $('#qNum').value || '1';
    $('#followText').value = q.replaceAll('{n}', n);
    $('#followText').focus();
  });
  $('#quick').appendChild(b);
});

// ---------- 결과 탭 ----------
function splitSections(text) {
  const marks = [...text.matchAll(SECTION_RE)];
  return marks.map((m, i) => ({
    title: m[1],
    md: text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length).trim(),
  }));
}
function updateResults(text) {
  const found = splitSections(text);
  if (!found.length) return; // 부분 수정 답변은 대화창에만 표시
  if (found.length >= 3) {
    sections = found;
  } else {
    // 일부 제목만 다시 낸 경우 해당 탭만 교체
    found.forEach((f) => {
      const i = sections.findIndex((s) => s.title === f.title);
      if (i >= 0) sections[i] = f; else sections.push(f);
    });
  }
  activeTab = Math.min(activeTab, sections.length - 1);
  renderTabs();
  $('#results').hidden = false;
}
function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  sections.forEach((s, i) => {
    const b = document.createElement('button');
    b.textContent = s.title;
    b.setAttribute('role', 'tab');
    b.className = i === activeTab ? 'on' : '';
    b.addEventListener('click', () => { activeTab = i; renderTabs(); });
    tabs.appendChild(b);
  });
  $('#tabbody').innerHTML = sections.length ? md(sections[activeTab].md) : '';
}

// ---------- 내보내기 ----------
const DOC_CSS = `body{font-family:'바탕',Batang,serif;font-size:11pt;line-height:1.6}
h1{font-size:16pt;text-align:center}h2{font-size:13pt}h3{font-size:12pt}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #000;padding:4px 6px;vertical-align:top}
th{background:#eee}blockquote{border:1px solid #000;padding:6px 10px;margin:8px 0}`;

function docHtml(parts) {
  const s = settings();
  const head = `${s.school} ${s.grade} ${s.subject} ${s.examName}`.trim();
  const body = parts.map((p) => `<h1>${escapeHtml(p.title)}</h1><p style="text-align:center">${escapeHtml(head)}</p>${md(p.md)}`)
    .join('<br style="page-break-before:always">');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>${DOC_CSS}</style></head><body>${body}</body></html>`;
}
function escapeHtml(t) { return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿', content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function baseName() { const s = settings(); return `${s.subject}_${s.examName || '평가문항'}`.replace(/[\\/:*?"<>|\s]+/g, '_'); }

$('#dlDoc').addEventListener('click', () => {
  const s = sections[activeTab];
  if (s) download(`${baseName()}_${s.title}.doc`, docHtml([s]), 'application/msword');
});
$('#dlAll').addEventListener('click', () => download(`${baseName()}_전체.doc`, docHtml(sections), 'application/msword'));
$('#dlMd').addEventListener('click', () => download(`${baseName()}.md`, sections.map((s) => `# [${s.title}]\n\n${s.md}`).join('\n\n'), 'text/markdown'));
$('#printBtn').addEventListener('click', () => {
  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되었습니다.'); return; }
  w.document.write(docHtml(sections));
  w.document.close();
  w.focus();
  w.print();
});

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
$('#copySystem').addEventListener('click', (e) => copy(systemPrompt(), e.currentTarget));
$('#copyOrder').addEventListener('click', (e) => {
  const extra = Object.keys(files).map((k) => (pasted(k) ? `\n\n[${KIND_LABEL[k]} — 붙여 넣은 본문]\n${pasted(k)}` : '')).join('');
  copy(buildOrderForm(settings(), fileSummary()) + extra, e.currentTarget);
});

// ---------- 프롬프트 3: 교과 응용본 생성 ----------
$('#genGuide').addEventListener('click', async () => {
  const st = $('#guideStatus');
  st.classList.remove('err');
  let c;
  try { c = await client(); } catch (e) {
    st.textContent = `${e.message} (3단계에서 키를 입력하세요)`; st.classList.add('err'); return;
  }
  const s = settings();
  const ta = $('#subjectGuide');
  const before = ta.value;
  st.textContent = `${s.subject} 응용 지침을 만드는 중…`;
  $('#genGuide').disabled = true;
  try {
    const params = requestParams('당신은 중학교 평가 전문가입니다.', [{ role: 'user', content: buildPrompt3(s.subject, s.grade, s.extra) }]);
    params.max_tokens = 8000;
    params.output_config = { effort: 'medium' };
    const stream = c.beta.messages.stream(params);
    stream.on('text', (_d, snap) => { ta.value = snap; });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('AI가 요청을 거절했습니다.');
    ta.value = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    st.textContent = '완료 — 내용을 확인하고 필요하면 고쳐 쓰세요.';
    saveSettings(); refreshPromptPreview();
  } catch (e) {
    ta.value = before;
    st.textContent = errText(e); st.classList.add('err');
  } finally {
    $('#genGuide').disabled = false;
  }
});

// ---------- 시작 ----------
loadSettings();
onSubjectChange();
setBusy(false);
