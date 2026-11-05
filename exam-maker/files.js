// 첨부 파일 읽기: PDF·이미지·텍스트·HWPX. PDF는 필요한 쪽만 잘라 보낼 수 있다.
/* global JSZip, PDFLib */

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function usable(f) { return f.type === 'pdf' || f.type === 'image' || f.type === 'text'; }
export function fmtSize(b) { return b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.ceil(b / 1024))}KB`; }

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// HWPX = zip 안의 Contents/section*.xml. 문단(<hp:p>)마다 글자(<hp:t>)를 모은다.
export async function extractHwpx(buf) {
  if (typeof JSZip === 'undefined') throw new Error('HWPX 읽기 도구를 불러오지 못했습니다.');
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/i)[1]) - Number(b.match(/(\d+)\.xml$/i)[1]));
  if (!names.length) throw new Error('HWPX 본문을 찾지 못했습니다.');
  const lines = [];
  for (const n of names) {
    const xml = new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml');
    for (const p of xml.getElementsByTagNameNS('*', 'p')) {
      // 표 안 문단이 바깥 문단에도 잡혀 두 번 나오지 않도록, 자식 문단이 있는 문단은 건너뜀
      if (p.getElementsByTagNameNS('*', 'p').length) continue;
      const text = [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('');
      if (text.trim()) lines.push(text);
    }
  }
  return lines.join('\n');
}

async function pdfPageCount(buf) {
  if (typeof PDFLib === 'undefined') return null;
  try {
    const doc = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch { return null; }
}

export async function toEntry(file) {
  const name = file.name;
  const lower = name.toLowerCase();
  const entry = { name, size: file.size };
  if (lower.endsWith('.hwp')) {
    entry.type = 'hwp';
  } else if (lower.endsWith('.hwpx')) {
    entry.type = 'text';
    entry.text = await extractHwpx(await file.arrayBuffer());
    entry.note = 'HWPX에서 글자만 추출';
  } else if (file.type === 'application/pdf' || lower.endsWith('.pdf')) {
    const buf = await file.arrayBuffer();
    entry.type = 'pdf';
    entry.data = bufToB64(buf);
    entry.pages = await pdfPageCount(buf);
    entry.pageSpec = '';
  } else if (file.type.startsWith('image/')) {
    if (IMAGE_TYPES.includes(file.type)) {
      entry.type = 'image';
      entry.media = file.type;
      entry.data = bufToB64(await file.arrayBuffer());
    } else {
      entry.type = 'bad';
    }
  } else {
    entry.type = 'text';
    entry.text = await file.text();
  }
  return entry;
}

// "3-10, 15, 20-22" → 0부터 시작하는 쪽 번호 배열. 형식이 틀리면 null
export function parsePages(spec, max) {
  const t = String(spec || '').replace(/\s/g, '');
  if (!t) return [];
  const out = new Set();
  for (const part of t.split(',')) {
    const m = part.match(/^(\d+)(?:[-~](\d+))?$/);
    if (!m) return null;
    let a = Number(m[1]);
    let b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || (max && b > max)) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

const trimCache = new Map();
// 보낼 PDF 데이터(base64). 쪽 지정이 있으면 그 쪽만 담은 새 PDF
export async function pdfData(entry) {
  const idx = parsePages(entry.pageSpec, entry.pages);
  if (!idx || !idx.length || typeof PDFLib === 'undefined') return entry.data;
  const key = `${entry.name}|${entry.size}|${idx.join(',')}`;
  if (trimCache.has(key)) return trimCache.get(key);
  const src = await PDFLib.PDFDocument.load(b64ToBuf(entry.data), { ignoreEncryption: true });
  const out = await PDFLib.PDFDocument.create();
  const pages = await out.copyPages(src, idx);
  pages.forEach((p) => out.addPage(p));
  const b64 = bufToB64(await out.save());
  trimCache.set(key, b64);
  return b64;
}

// 대략적인 전송 크기(바이트). 쪽 지정 PDF는 쪽 비율로 추정
export function approxBytes(entry) {
  if (entry.type === 'text') return entry.text.length * 3;
  if (!entry.data) return 0;
  const idx = entry.type === 'pdf' ? parsePages(entry.pageSpec, entry.pages) : null;
  if (idx && idx.length && entry.pages) return Math.round(entry.data.length * (idx.length / entry.pages));
  return entry.data.length;
}

export { bufToB64 };
