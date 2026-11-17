import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const LIB = new URL('./lib/', import.meta.url).href;
const VERSION = '1.1.0';

const $ = (s) => document.querySelector(s);
const scroller = $('#scroller'), pagesEl = $('#pages'), bar = $('#bar'), topbar = $('#topbar');
const pageBtn = $('#btnPage'), titleEl = $('#title'), zoomPill = $('#zoomPill');
const emptyEl = $('#empty'), busyEl = $('#busy'), toastEl = $('#toast');
const sheet = $('#sheet'), sheetBody = $('#sheetBody'), fileInput = $('#file');

const dpr = Math.min(window.devicePixelRatio || 1, 3);
const MAX_PIXELS = 6e6;          // 캔버스 한 장의 최대 화소 수 (폰 메모리 보호)
const MIN_Z = 1, MAX_Z = 8;      // 1 = 화면 폭에 맞춤
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const store = {
  get(k, d) { try { const v = localStorage.getItem('pdfv:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pdfv:' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids) el.append(c);
  return el;
}

/* ---------- 알림 ---------- */
let toastTimer = 0;
function toast(msg, ms = 2400) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}
function busy(msg) { busyEl.textContent = msg || ''; busyEl.hidden = !msg; }

/* ---------- 상태 ---------- */
let pdf = null, pages = [], fit = 0, zoom = 1, docKey = '', docName = '';
const live = new Set();            // 캔버스를 가진 페이지
let curJob = null, pumping = false;
let uiHidden = false;
const hl = { rects: new Map(), stamp: 0 };   // 검색 강조

document.body.classList.toggle('dark', !!store.get('dark', false));
document.body.classList.add('noDoc');

/* ---------- 문서 열기 ---------- */
async function openBuffer(buf, name, fromStore) {
  closeSheet();
  busy('불러오는 중...');
  // pdf.js가 데이터를 가져가 버리므로, 보관할 사본은 먼저 떠 둔다
  const keep = (!fromStore && buf.byteLength <= KEEP_MAX) ? buf.slice(0) : null;
  let doc, task;
  try {
    task = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: LIB + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: LIB + 'standard_fonts/',
      wasmUrl: LIB + 'wasm/', iccUrl: LIB + 'iccs/',
      isEvalSupported: false,
    });
    task.onPassword = (update, reason) => askPassword(task, update, reason);
    doc = await task.promise;
  } catch (err) {
    busy('');
    if (err && err.name === 'PasswordException') toast('암호가 맞지 않아 열지 못했습니다');
    else { toast('열 수 없는 파일입니다'); console.error(err); }
    return false;
  }
  closeDoc();
  pdf = doc; docName = name || '문서.pdf';
  docKey = (doc.fingerprints && doc.fingerprints[0]) || docName;

  const n = doc.numPages;
  const sizes = new Array(n);
  const p1 = await doc.getPage(1);
  const v1 = p1.getViewport({ scale: 1 });
  sizes[0] = [v1.width, v1.height];
  if (n <= 400) {
    for (let s = 1; s < n; s += 24) {
      busy(`페이지 정보 읽는 중 ${s}/${n}`);
      const len = Math.min(24, n - s);
      await Promise.all(Array.from({ length: len }, async (_, i) => {
        const pg = await doc.getPage(s + i + 1);
        const v = pg.getViewport({ scale: 1 });
        sizes[s + i] = [v.width, v.height];
      }));
    }
  } else {
    for (let i = 1; i < n; i++) sizes[i] = sizes[0];
  }

  const frag = document.createDocumentFragment();
  pages = [];
  for (let i = 0; i < n; i++) {
    const el = h('div', { class: 'page' });
    el.style.setProperty('--ar', `${sizes[i][0]} / ${sizes[i][1]}`);
    frag.append(el);
    pages.push({ n: i + 1, el, ar: sizes[i][1] / sizes[i][0], svg: null, cvs: null, info: null, failW: -1, hlDiv: null, hlStamp: -1 });
  }
  pagesEl.append(frag);

  emptyEl.hidden = true; scroller.hidden = false;
  document.body.classList.remove('noDoc');
  titleEl.textContent = docName;
  fit = scroller.clientWidth; zoom = 1; applyWidth();

  const pos = store.get('pos:' + docKey, null);
  if (pos) goPage(pos.p, pos.f); else scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
  await loadAnno();
  busy('');
  updateIndicator(); refresh(); saveRecent();
  if (keep) keepCopy(docKey, docName, keep);
  return true;
}

function closeDoc() {
  if (curJob) { try { curJob.task.cancel(); } catch { /* 무시 */ } curJob = null; }
  for (const p of pages) freeCanvas(p);
  pagesEl.replaceChildren(); pages = []; live.clear();
  if (pdf) { pdf.destroy().catch(() => {}); pdf = null; }
  hl.rects.clear(); hl.stamp++; searchRun++; textCache.clear();
  annoReset();
}

function askPassword(task, update, reason) {
  busy('');
  const wrong = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
  const input = h('input', { type: 'password', placeholder: '암호', autocomplete: 'off' });
  const go = () => { const v = input.value; closeSheet(true); busy('불러오는 중...'); update(v); };
  openSheet(() => [
    h('h3', {}, '암호가 걸린 문서입니다'),
    wrong ? h('p', {}, '암호가 맞지 않습니다. 다시 입력해 주세요.') : '',
    h('div', { class: 'row' }, input),
    h('div', { class: 'row' },
      h('button', { class: 'pri', onclick: go }, '열기'),
      h('button', { class: 'sec', onclick: () => { closeSheet(true); busy(''); task.destroy(); } }, '취소')),
  ]);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => input.focus(), 50);
}

/* ---------- 레이아웃 ---------- */
function applyWidth() { pagesEl.style.setProperty('--pw', (fit * zoom) + 'px'); }

function pageAt(y) {
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1, e = pages[mid].el;
    if (e.offsetTop + e.offsetHeight < y) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function goPage(n, f = 0) {
  if (!pages.length) return;
  const p = pages[clamp(Math.round(n), 1, pages.length) - 1];
  scroller.scrollTop = p.el.offsetTop + clamp(f, 0, 1) * p.el.offsetHeight;
}

function currentPos() {
  const st = scroller.scrollTop;
  const i = pageAt(st + 1), e = pages[i].el;
  return { p: i + 1, f: clamp((st - e.offsetTop) / e.offsetHeight, 0, 0.999) };
}

function updateIndicator() {
  if (!pages.length) return;
  const i = pageAt(scroller.scrollTop + scroller.clientHeight * 0.35);
  pageBtn.textContent = `${i + 1} / ${pages.length}`;
}

/* ---------- 확대 ---------- */
let pillTimer = 0;
function showPill(z = zoom) {
  zoomPill.textContent = Math.round(z * 100) + '%'; zoomPill.hidden = false;
  clearTimeout(pillTimer); pillTimer = setTimeout(() => { zoomPill.hidden = true; }, 900);
}

// 키보드·마우스 휠용: 배율을 바로 바꾼다 (손가락 확대는 아래 제스처 방식)
// cx, cy: 화면 위 기준점. 그 점 아래의 내용이 제자리에 있도록 확대한다.
function setZoom(z, cx, cy) {
  z = clamp(z, MIN_Z, MAX_Z);
  if (Math.abs(z - zoom) < 1e-4) return;
  const r = z / zoom;
  const sx = scroller.scrollLeft + cx, sy = scroller.scrollTop + cy;
  zoom = z; applyWidth();
  scroller.scrollLeft = sx * r - cx;
  scroller.scrollTop = sy * r - cy;
  showPill();
}

// 손가락 확대: 움직이는 동안은 화면을 GPU로 늘이기만 하고(레이아웃·다시 그리기 없음),
// 손을 떼는 순간 한 번만 배율을 확정한 뒤 그 배율로 선명하게 다시 그린다.
let gz = null, gzRaf = 0, gzTimer = 0;
function gestureBegin(mx, my) {
  if (curJob) { try { curJob.task.cancel(); } catch { /* 무시 */ } }
  // P: 첫 쪽 위의 고정 여백. 이 여백은 확대해도 늘어나지 않으므로 기준 높이로 쓴다.
  const P = pages.length ? pages[0].el.offsetTop : 0;
  gz = { z0: zoom, sx: scroller.scrollLeft + mx, sy: scroller.scrollTop + my, mx0: mx, my0: my, mx, my, s: 1, P };
  pagesEl.style.transition = 'none';
  pagesEl.style.transformOrigin = `${gz.sx}px ${gz.P}px`;
  pagesEl.style.willChange = 'transform';
}
// 손가락 밑의 내용이 손가락을 따라가도록 이동량을 계산한다
function gzTransform() {
  const tx = gz.mx - gz.mx0;
  const ty = (gz.my - gz.my0) + (gz.sy - gz.P) * (1 - gz.s);
  return `translate(${tx}px, ${ty}px) scale(${gz.s})`;
}
function gestureApply() {
  gzRaf = 0;
  if (!gz) return;
  pagesEl.style.transform = gzTransform();
  showPill(gz.z0 * gz.s);
}
function gestureUpdate(s, mx, my) {
  if (!gz) return;
  gz.s = clamp(s, MIN_Z / gz.z0, MAX_Z / gz.z0); gz.mx = mx; gz.my = my;
  if (!gzRaf) gzRaf = requestAnimationFrame(gestureApply);
}
function gestureEnd() {
  if (!gz) return;
  clearTimeout(gzTimer); cancelAnimationFrame(gzRaf); gzRaf = 0;
  const g = gz; gz = null;
  const r = clamp(g.z0 * g.s, MIN_Z, MAX_Z) / g.z0;
  pagesEl.style.transition = 'none';
  pagesEl.style.transform = ''; pagesEl.style.willChange = ''; pagesEl.style.transformOrigin = '';
  zoom = g.z0 * r; applyWidth();
  scroller.scrollLeft = g.sx * r - g.mx;
  scroller.scrollTop = g.P + (g.sy - g.P) * r - g.my;
  showPill(); updateIndicator(); scheduleRefresh(60, true); savePosSoon();
}

// 두 번 탭 확대: 변환 애니메이션으로 부드럽게
function animateZoom(target, cx, cy) {
  if (gz) return;
  target = clamp(target, MIN_Z, MAX_Z);
  if (Math.abs(target - zoom) < 1e-3) return;
  gestureBegin(cx, cy);
  pagesEl.style.transition = 'transform .18s ease-out';
  void pagesEl.offsetWidth;            // 변환이 현재 상태에서 출발하도록 반영
  gz.s = target / zoom;
  pagesEl.style.transform = gzTransform();
  showPill(target);
  gzTimer = setTimeout(gestureEnd, 210);
}

/* ---------- 그리기 ---------- */
let refreshTimer = 0;
function scheduleRefresh(ms, debounce) {
  if (debounce) clearTimeout(refreshTimer);
  else if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = 0; refresh(); }, ms);
}

function wanted() {
  const st = scroller.scrollTop, vh = scroller.clientHeight, cy = st + vh / 2;
  const hi = st + vh * 1.6;
  const out = [];
  for (let i = pageAt(st - vh * 0.6); i < pages.length; i++) {
    if (pages[i].el.offsetTop > hi) break;
    out.push(pages[i]);
  }
  const dist = (p) => Math.abs(p.el.offsetTop + p.el.offsetHeight / 2 - cy);
  out.sort((a, b) => dist(a) - dist(b));
  return out;
}

// 이 페이지에 새로 그려야 하면 그릴 영역(CSS px)을, 지금 그림으로 충분하면 null을 돌려준다.
function plan(p) {
  const pr = p.el.getBoundingClientRect(), W = pr.width, H = pr.height;
  if (!W || !H) return null;
  if (Math.abs(p.failW - W) < 1) return null;
  const inf = p.info;
  const full = W * H * dpr * dpr <= MAX_PIXELS;
  if (full) {
    if (inf && inf.full && Math.abs(inf.W - W) / W < 0.02) return null;
    return { x: 0, y: 0, w: W, h: H, W, H, full: true };
  }
  const vr = scroller.getBoundingClientRect();
  const vx0 = Math.max(0, vr.left - pr.left), vy0 = Math.max(0, vr.top - pr.top);
  const vx1 = Math.min(W, vr.right - pr.left), vy1 = Math.min(H, vr.bottom - pr.top);
  if (vx1 <= vx0 || vy1 <= vy0) return null;      // 큰 확대 상태에서는 보이는 페이지만 그림
  if (inf && !inf.full && Math.abs(inf.W - W) / W < 0.02 &&
      inf.x <= vx0 + 1 && inf.y <= vy0 + 1 && inf.x + inf.w >= vx1 - 1 && inf.y + inf.h >= vy1 - 1) return null;
  const mx = (vx1 - vx0) * 0.2, my = (vy1 - vy0) * 0.2;
  const x = Math.max(0, Math.floor(vx0 - mx)), y = Math.max(0, Math.floor(vy0 - my));
  const x1 = Math.min(W, Math.ceil(vx1 + mx)), y1 = Math.min(H, Math.ceil(vy1 + my));
  return { x, y, w: x1 - x, h: y1 - y, W, H, full: false };
}

function freeCanvas(p) {
  if (p.cvs) { p.cvs.remove(); p.cvs.width = 0; p.cvs = null; }
  p.info = null; live.delete(p);
}

function refresh() {
  if (!pdf || gz) return;
  // 확대 배율이 바뀌어 낡은 그리기는 중단
  if (curJob && Math.abs(curJob.p.el.getBoundingClientRect().width - curJob.r.W) > 1) {
    try { curJob.task.cancel(); } catch { /* 무시 */ }
  }
  // 멀리 벗어난 페이지의 캔버스는 해제
  const st = scroller.scrollTop, vh = scroller.clientHeight;
  for (const p of [...live]) {
    const t = p.el.offsetTop, b = t + p.el.offsetHeight;
    if (b < st - vh * 3 || t > st + vh * 4) freeCanvas(p);
  }
  paintHighlights();
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (gz) break;
      let job = null;
      for (const p of wanted()) { const r = plan(p); if (r) { job = { p, r }; break; } }
      if (!job) break;
      await renderJob(job);
      await new Promise((r) => setTimeout(r, 0));   // 사이사이 터치 입력에 양보
    }
  } finally { pumping = false; }
}

async function renderJob({ p, r }) {
  const doc = pdf;
  let task, cvs;
  try {
    const pdfPage = await doc.getPage(p.n);
    if (doc !== pdf) return;
    const base = pdfPage.getViewport({ scale: 1 });
    let k = dpr;
    const area = r.w * r.h * k * k;
    if (area > MAX_PIXELS) k *= Math.sqrt(MAX_PIXELS / area);
    const viewport = pdfPage.getViewport({ scale: (r.W / base.width) * k });
    cvs = document.createElement('canvas');
    cvs.width = Math.max(1, Math.round(r.w * k)); cvs.height = Math.max(1, Math.round(r.h * k));
    cvs.style.cssText = `left:${r.x / r.W * 100}%;top:${r.y / r.H * 100}%;width:${r.w / r.W * 100}%;height:${r.h / r.H * 100}%`;
    task = pdfPage.render({ canvas: cvs, viewport, transform: [1, 0, 0, 1, -Math.round(r.x * k), -Math.round(r.y * k)] });
    curJob = { p, r, task };
    await task.promise;
  } catch (e) {
    if (cvs) cvs.width = 0;
    if (!e || e.name !== 'RenderingCancelledException') { console.error(e); p.failW = r.W; }
    return;
  } finally {
    if (curJob && curJob.task === task) curJob = null;
  }
  if (doc !== pdf || !p.el.isConnected) { cvs.width = 0; return; }
  const old = p.cvs;
  p.el.prepend(cvs);
  if (old) { old.remove(); old.width = 0; }
  p.cvs = cvs;
  p.info = { W: r.W, x: r.x, y: r.y, w: r.w, h: r.h, full: r.full };
  live.add(p);
}

/* ---------- 검색 강조 ---------- */
function paintHighlights() {
  for (const p of wanted()) {
    if (p.hlStamp === hl.stamp) continue;
    p.hlStamp = hl.stamp;
    if (p.hlDiv) { p.hlDiv.remove(); p.hlDiv = null; }
    const rs = hl.rects.get(p.n);
    if (!rs) continue;
    const div = h('div', { class: 'hl' });
    for (const q of rs) {
      const b = h('div', { class: 'hlbox' });
      b.style.cssText = `left:${q.x0 * 100}%;top:${q.y0 * 100}%;width:${(q.x1 - q.x0) * 100}%;height:${(q.y1 - q.y0) * 100}%`;
      div.append(b);
    }
    p.el.append(div); p.hlDiv = div;
  }
}
function setHighlights(map) {
  hl.rects = map; hl.stamp++;
  for (const p of pages) if (p.hlDiv) { p.hlDiv.remove(); p.hlDiv = null; }
  paintHighlights();
}

/* ---------- 시트 ---------- */
function openSheet(build) {
  sheetBody.replaceChildren(...build().filter(Boolean));
  sheet.hidden = false;
}
function closeSheet(keepSearch) {
  if (!keepSearch) searchRun++;
  sheet.hidden = true; sheetBody.replaceChildren();
}
$('#sheetBack').addEventListener('click', () => closeSheet());

function openGoto() {
  if (!pages.length) return;
  const n = pages.length, cur = currentPos().p;
  const num = h('input', { type: 'number', min: 1, max: n, value: cur, inputmode: 'numeric' });
  const rng = h('input', { type: 'range', min: 1, max: n, value: cur });
  num.addEventListener('input', () => { rng.value = num.value; });
  rng.addEventListener('input', () => { num.value = rng.value; });
  const go = () => { goPage(Number(num.value) || 1); closeSheet(); };
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  openSheet(() => [
    h('h3', {}, `쪽 이동 (전체 ${n}쪽)`),
    h('div', { class: 'row' }, num, h('button', { class: 'pri', onclick: go }, '이동')),
    h('div', { class: 'row' }, rng),
    h('div', { class: 'row' },
      h('button', { class: 'sec', onclick: () => { goPage(1); closeSheet(); } }, '처음'),
      h('button', { class: 'sec', onclick: () => { goPage(n); closeSheet(); } }, '끝')),
  ]);
  setTimeout(() => { num.focus(); num.select(); }, 60);
}

function openInfo() {
  openSheet(() => [
    h('h3', {}, `PDF 뷰어 ${VERSION}`),
    h('p', {}, '두 번 탭하면 확대·원래 크기로 바뀌고, 두 손가락으로 벌리면 원하는 만큼 확대됩니다. 확대할 때마다 그 배율로 다시 그려서 글자가 흐려지지 않습니다.'),
    h('p', {}, '한 번 탭하면 위아래 메뉴가 숨겨지거나 나타납니다. 읽던 쪽은 문서마다 기억합니다.'),
    h('p', {}, '스캔본이나 사진으로 만든 PDF는 원본 해상도 이상으로는 선명해지지 않습니다.'),
    h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => closeSheet() }, '닫기')),
  ]);
}

/* ---------- 검색 ---------- */
let searchRun = 0;
const textCache = new Map();   // 쪽 번호 -> { norm, map, items }

async function pageText(n) {
  let t = textCache.get(n);
  if (t) return t;
  const pg = await pdf.getPage(n);
  const tc = await pg.getTextContent();
  let norm = '', orig = '';
  const map = [], oi = [];
  tc.items.forEach((it, idx) => {
    if (typeof it.str !== 'string') return;
    for (const ch of it.str) {
      if (/\s/.test(ch)) { orig += ' '; continue; }
      for (const c of ch.toLowerCase()) { norm += c; map.push(idx); oi.push(orig.length); }
      orig += ch;
    }
    if (it.hasEOL) orig += ' ';
  });
  t = { norm, orig, map, oi, items: tc.items, vp: pg.getViewport({ scale: 1 }) };
  textCache.set(n, t);
  if (textCache.size > 80) textCache.delete(textCache.keys().next().value);
  return t;
}

// 글자 종류별 대략적인 가로 폭 (한글·한자는 넓고 숫자·영문은 좁다)
function charW(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x1100) return 1;
  if (ch === ' ') return 0.3;
  if (c >= 48 && c <= 57) return 0.55;
  if (c >= 65 && c <= 90) return 0.66;
  if (c >= 97 && c <= 122) return 0.5;
  return 0.4;
}

function hitRect(t, itemIdx, normStart, normEnd) {
  const it = t.items[itemIdx];
  const [, b, , , e, f] = it.transform;
  const w = it.width || 0, hh = it.height || Math.abs(it.transform[3]) || 10;
  let x0 = e, x1 = e + w;
  if (Math.abs(b) < 0.01 && w > 0 && it.str) {
    // 이 글자 조각 안에서 찾은 말의 시작·끝을 글자 폭 비율로 계산
    let first = normStart, last = normStart;
    while (first > 0 && t.map[first - 1] === itemIdx) first--;
    while (last < t.map.length && t.map[last] === itemIdx) last++;
    const k0 = normStart - first, k1 = Math.min(normEnd, last) - first;
    let total = 0, a0 = 0, a1 = -1, seen = 0;
    for (const ch of it.str) {
      const cw = charW(ch);
      if (!/\s/.test(ch)) {
        if (seen === k0) a0 = total;
        seen++;
        if (seen === k1) a1 = total + cw;
      }
      total += cw;
    }
    if (a1 < 0) a1 = total;
    if (total > 0) { x1 = e + w * (a1 / total); x0 = e + w * (a0 / total); }
  }
  const [rx0, ry0] = t.vp.convertToViewportPoint(x0, f - hh * 0.2);
  const [rx1, ry1] = t.vp.convertToViewportPoint(x1, f + hh * 0.95);
  const W = t.vp.width, H = t.vp.height;
  return { x0: clamp(Math.min(rx0, rx1) / W, 0, 1), x1: clamp(Math.max(rx0, rx1) / W, 0, 1),
           y0: clamp(Math.min(ry0, ry1) / H, 0, 1), y1: clamp(Math.max(ry0, ry1) / H, 0, 1) };
}

function openSearch() {
  if (!pdf) return;
  const input = h('input', { type: 'search', placeholder: '찾을 말', autocomplete: 'off', enterkeyhint: 'search' });
  const stat = h('div', { class: 'stat' });
  const list = h('ul', { id: 'hits' });
  const run = async () => {
    const q = input.value.replace(/\s+/g, '').toLowerCase();
    const my = ++searchRun;
    list.replaceChildren(); setHighlights(new Map());
    if (!q) { stat.textContent = ''; return; }
    const rects = new Map(); let found = 0, shown = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      if (my !== searchRun) return;
      stat.textContent = `찾는 중 ${n}/${pdf.numPages}쪽 · ${found}건`;
      let t;
      try { t = await pageText(n); } catch { continue; }
      let from = 0, idx;
      while ((idx = t.norm.indexOf(q, from)) !== -1 && found < 500) {
        found++;
        let r;
        try { r = hitRect(t, t.map[idx], idx, idx + q.length); } catch (e) { console.error(e); r = { x0: 0, x1: 1, y0: 0, y1: 0 }; }
        if (!rects.has(n)) rects.set(n, []);
        rects.get(n).push(r);
        if (shown < 200) {
          shown++;
          const o0 = t.oi[idx], o1 = t.oi[idx + q.length - 1] + 1;
          const li = h('li', {},
            h('span', { class: 'pn' }, `${n}쪽`),
            t.orig.slice(Math.max(0, o0 - 14), o0), h('b', {}, t.orig.slice(o0, o1)), t.orig.slice(o1, o1 + 22));
          li.addEventListener('click', () => {
            closeSheet(true);
            const p = pages[n - 1];
            const H = p.el.offsetHeight, W = p.el.offsetWidth;
            scroller.scrollTop = p.el.offsetTop + r.y0 * H - scroller.clientHeight * 0.3;
            if (W > scroller.clientWidth) scroller.scrollLeft = p.el.offsetLeft + r.x0 * W - scroller.clientWidth * 0.3;
            toast(`${n}쪽`, 1200);
          });
          list.append(li);
        }
        from = idx + q.length;
      }
      if (n % 5 === 0 || n === pdf.numPages) setHighlights(rects);
      if (found >= 500) break;
    }
    if (my !== searchRun) return;
    setHighlights(rects);
    stat.textContent = found ? `${found}건${found >= 500 ? ' 이상' : ''} · 눌러서 이동` : '찾는 글이 없습니다 (스캔본은 글자 검색이 안 됩니다)';
  };
  const start = () => run().catch((e) => { console.error(e); stat.textContent = '검색 중 문제가 생겼습니다'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); start(); } });
  openSheet(() => [
    h('h3', {}, '문서 안에서 찾기'),
    h('div', { class: 'row' }, input, h('button', { class: 'pri', onclick: start }, '찾기')),
    h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => { searchRun++; setHighlights(new Map()); list.replaceChildren(); stat.textContent = ''; input.value = ''; } }, '강조 지우기')),
    stat, list,
  ]);
  setTimeout(() => input.focus(), 60);
}

/* ---------- 파일 열기 ---------- */
function pickFile() { fileInput.value = ''; fileInput.click(); }
async function openFile(file) {
  if (!file) return;
  busy('파일 읽는 중...');
  try { await openBuffer(await file.arrayBuffer(), file.name); }
  catch (e) { busy(''); toast('파일을 읽지 못했습니다'); console.error(e); }
}
fileInput.addEventListener('change', () => openFile(fileInput.files[0]));
$('#btnOpenBig').addEventListener('click', pickFile);
$('#btnOpen').addEventListener('click', pickFile);
$('#btnSearch').addEventListener('click', openSearch);
$('#btnPage').addEventListener('click', openGoto);
$('#btnInfo').addEventListener('click', openInfo);
$('#btnDark').addEventListener('click', () => {
  const on = document.body.classList.toggle('dark'); store.set('dark', on);
});

// 안드로이드 앱이 PDF를 넘겨줄 때 (파일 관리자에서 PDF를 누른 경우, 열기 버튼으로 고른 경우)
// 앱이 PdfNative라는 이름으로 파일 읽기 통로를 열어 두고, 여기서 조각 단위로 받아 합친다.
window.openNativePdf = async function () {
  const N = window.PdfNative;
  if (!N) { toast('앱 안에서만 쓸 수 있습니다'); return; }
  busy('파일 받는 중...');
  try {
    const size = Number(N.size());
    const name = N.name() || '문서.pdf';
    if (!size) throw new Error('빈 파일');
    const out = new Uint8Array(size);
    const CH = 3 * 256 * 1024;   // 3의 배수여야 조각마다 base64가 끊김 없이 이어진다
    for (let off = 0; off < size; off += CH) {
      const len = Math.min(CH, size - off);
      const b64 = N.chunk(off, len);
      if (!b64) throw new Error('읽기 실패');
      const buf = await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer();
      out.set(new Uint8Array(buf), off);
      busy(`파일 받는 중 ${Math.round((off + len) / size * 100)}%`);
    }
    await openBuffer(out.buffer, name);
  } catch (e) { busy(''); toast('파일을 받지 못했습니다'); console.error(e); }
};
if (new URLSearchParams(location.search).has('native')) window.openNativePdf();

// 앱의 뒤로 가기 버튼: 열린 창이 있으면 닫고 true, 없으면 false(앱 종료)
window.onNativeBack = function () {
  if (!sheet.hidden) { closeSheet(); return true; }
  if (an.on) { annoMode(false); return true; }
  return false;
};

// 데스크톱 크롬에 설치했을 때 "연결 프로그램"으로 열기
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (p) => {
    if (p.files && p.files.length) openFile(await p.files[0].getFile());
  });
}

/* ---------- 최근 문서 (열어 본 PDF는 이 앱 안에 보관) ---------- */
const KEEP_MAX = 40 * 1024 * 1024;   // 이보다 큰 파일은 보관하지 않음
const KEEP_COUNT = 6;                // 최근 이만큼만 보관

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('pdfv-files', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('f');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('f', mode);
    const req = fn(tx.objectStore('f'));
    tx.oncomplete = () => { db.close(); resolve(req && req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
const idbPut = (k, v) => idbDo('readwrite', (st) => st.put(v, k));
const idbGet = (k) => idbDo('readonly', (st) => st.get(k));
const idbDel = (k) => idbDo('readwrite', (st) => st.delete(k));

async function keepCopy(key, name, buf) {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await idbPut(key, { name, buf });
    const list = store.get('recent', []);
    const r = list.find((x) => x.k === key);
    if (r) r.s = true;
    let n = 0;
    for (const x of list) {              // 최근 순서대로 KEEP_COUNT개만 남기고 나머지는 지움
      if (!x.s) continue;
      if (++n > KEEP_COUNT) { x.s = false; idbDel(x.k).catch(() => {}); }
    }
    store.set('recent', list);
  } catch (e) { console.warn('보관 실패', e); }
}

function saveRecent() {
  const all = store.get('recent', []);
  const old = all.find((r) => r.k === docKey);
  const list = all.filter((r) => r.k !== docKey);
  list.unshift({ k: docKey, name: docName, n: pages.length, p: currentPos().p, t: Date.now(), s: !!(old && old.s) });
  store.set('recent', list.slice(0, 15));
}

async function openRecent(r) {
  if (r.s) {
    busy('불러오는 중...');
    try {
      const v = await idbGet(r.k);
      if (v && v.buf) { await openBuffer(v.buf, v.name || r.name, true); return; }
    } catch (e) { console.warn(e); }
    busy('');
    const list = store.get('recent', []);
    const x = list.find((q) => q.k === r.k);
    if (x) { x.s = false; store.set('recent', list); }
  }
  toast(`'${r.name}' 파일을 골라 주세요`); pickFile();
}

function renderRecent() {
  const list = store.get('recent', []);
  const box = $('#recentBox'), ul = $('#recentList');
  ul.replaceChildren();
  box.hidden = !list.length;
  for (const r of list) {
    const del = h('button', { class: 'delBtn' }, '삭제');
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const rest = store.get('recent', []).filter((q) => q.k !== r.k);
      store.set('recent', rest); store.set('pos:' + r.k, null);
      idbDel(r.k).catch(() => {}); idbDel('anno:' + r.k).catch(() => {});
      renderRecent();
    });
    const li = h('li', {}, h('span', { class: 'rname' }, r.name), h('span', { class: 'rpage' }, `${r.p}/${r.n}쪽`), del);
    li.addEventListener('click', () => openRecent(r));
    ul.append(li);
  }
}
renderRecent();

/* ---------- 위치 저장 ---------- */
let saveTimer = 0;
function savePosSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePos, 500);
}
function savePos() {
  if (!pdf || !pages.length) return;
  const c = currentPos();
  store.set('pos:' + docKey, c);
  const list = store.get('recent', []);
  const r = list.find((x) => x.k === docKey);
  if (r) { r.p = c.p; store.set('recent', list); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
window.addEventListener('pagehide', savePos);

/* ---------- 스크롤·크기 ---------- */
let scrollRaf = 0;
scroller.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0; updateIndicator(); scheduleRefresh(90, false); savePosSoon();
  });
}, { passive: true });

let lastW = 0;
new ResizeObserver(() => {
  if (!pdf) return;
  const w = scroller.clientWidth;
  if (w && lastW && w !== lastW) {
    const c = currentPos();
    fit = w; applyWidth(); goPage(c.p, c.f);
    scheduleRefresh(100, true);
  }
  lastW = w;
}).observe(scroller);

/* ---------- 터치: 확대, 두 번 탭, 한 번 탭 ---------- */
let tp = null, lastTap = { t: 0, x: 0, y: 0 }, tapTimer = 0;
const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

scroller.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    if (gz) gestureEnd();
    if (an.cur) annoAbort();
    const [a, b] = e.touches, rc = scroller.getBoundingClientRect();
    tp = { mode: 'pinch', d0: dist2(a, b) || 1, rl: rc.left, rt: rc.top };
    gestureBegin((a.clientX + b.clientX) / 2 - rc.left, (a.clientY + b.clientY) / 2 - rc.top);
    clearTimeout(tapTimer); lastTap.t = 0;
  } else if (e.touches.length === 1) {
    const t = e.touches[0];
    if (an.on && an.tool !== 'hand' && annoBegin(t.clientX, t.clientY)) { tp = { mode: 'draw' }; return; }
    tp = { mode: 'tap', x: t.clientX, y: t.clientY, t: Date.now(), moved: false };
  } else tp = { mode: 'none' };
}, { passive: true });

scroller.addEventListener('touchmove', (e) => {
  if (!tp) return;
  if (tp.mode === 'pinch' && e.touches.length === 2) {
    if (e.cancelable) e.preventDefault();
    const [a, b] = e.touches;
    gestureUpdate(dist2(a, b) / tp.d0, (a.clientX + b.clientX) / 2 - tp.rl, (a.clientY + b.clientY) / 2 - tp.rt);
  } else if (tp.mode === 'draw') {
    if (e.cancelable) e.preventDefault();
    if (e.touches.length === 1) annoMove(e.touches[0].clientX, e.touches[0].clientY);
  } else if (tp.mode === 'tap') {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - tp.x, t.clientY - tp.y) > 10) tp.moved = true;
  }
}, { passive: false });

scroller.addEventListener('touchend', (e) => {
  if (tp && tp.mode === 'draw') {
    if (e.cancelable) e.preventDefault();   // 뒤따르는 가짜 클릭이 방금 연 창을 닫지 않게
    annoEnd(); tp = e.touches.length === 0 ? null : { mode: 'none' }; return;
  }
  if (tp && tp.mode === 'tap' && !tp.moved && Date.now() - tp.t < 350 && e.touches.length === 0) handleTap(tp.x, tp.y);
  if (tp && tp.mode === 'pinch') {
    gestureEnd();
    tp = e.touches.length === 0 ? null : { mode: 'none' };
  } else if (e.touches.length === 0) tp = null;
}, { passive: false });
scroller.addEventListener('touchcancel', () => { if (an.cur) annoAbort(); gestureEnd(); tp = null; }, { passive: true });

function handleTap(x, y) {
  const now = Date.now();
  if (now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
    clearTimeout(tapTimer); lastTap.t = 0;
    const rc = scroller.getBoundingClientRect();
    animateZoom(zoom < 1.6 ? 2.5 : 1, x - rc.left, y - rc.top);
  } else {
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    if (!an.on) tapTimer = setTimeout(toggleUi, 300);
  }
}
function toggleUi() {
  uiHidden = !uiHidden;
  bar.classList.toggle('hidden', uiHidden); topbar.classList.toggle('hidden', uiHidden);
}

/* ---------- 마우스·키보드 (PC에서 확인할 때) ---------- */
scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const rc = scroller.getBoundingClientRect();
  setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rc.left, e.clientY - rc.top);
  scheduleRefresh(150, true);
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!pdf || e.target.tagName === 'INPUT') return;
  const rc = scroller.getBoundingClientRect(), cx = rc.width / 2, cy = rc.height / 2;
  if (e.key === '+' || e.key === '=') { setZoom(zoom * 1.25, cx, cy); scheduleRefresh(150, true); }
  else if (e.key === '-') { setZoom(zoom / 1.25, cx, cy); scheduleRefresh(150, true); }
  else if (e.key === '0') { setZoom(1, cx, cy); scheduleRefresh(150, true); }
});


/* ---------- 필기 ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
const K = 1000;                                  // 필기 좌표는 쪽 너비를 1로 둔 값, 그릴 때만 K배
const FONT = 'system-ui, "Noto Sans KR", "Apple SD Gothic Neo", sans-serif';
const COLORS = {
  pen: ['#1a1a1a', '#e03131', '#1971c2', '#2f9e44'],
  hl: ['#ffe066', '#ff8fab', '#8ce99a', '#74c0fc'],
  tx: ['#1a1a1a', '#e03131', '#1971c2', '#2f9e44'],
};
const WIDTHS = { pen: [0.0022, 0.004, 0.0075], hl: [0.016, 0.028], tx: [0.018, 0.026, 0.04] };
const an = {
  on: false, tool: 'pen', cur: null, undo: [],
  ci: { pen: 0, hl: 0, tx: 0 }, wi: { pen: 1, hl: 0, tx: 1 },
  data: new Map(),                               // 쪽 번호 -> 글씨·그림 목록
};
const elOf = new WeakMap();
const annoBar = $('#annoBar');
const r4 = (v) => Math.round(v * 10000) / 10000;

function itemsOf(n) {
  let a = an.data.get(n);
  if (!a) { a = []; an.data.set(n, a); }
  return a;
}
function svgOf(p) {
  if (p.svg) return p.svg;
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ann');
  s.setAttribute('viewBox', `0 0 ${K} ${K * p.ar}`);
  s.setAttribute('preserveAspectRatio', 'none');
  p.el.append(s); p.svg = s;
  return s;
}
function pathD(p) {
  const f = (v) => Math.round(v * K * 100) / 100;
  if (p.length === 1) return `M${f(p[0][0])} ${f(p[0][1])}l0.01 0`;
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    d += `Q${f(p[i][0])} ${f(p[i][1])} ${f((p[i][0] + p[i + 1][0]) / 2)} ${f((p[i][1] + p[i + 1][1]) / 2)}`;
  }
  const l = p[p.length - 1];
  return d + `L${f(l[0])} ${f(l[1])}`;
}
function itemEl(it) {
  const ns = (t) => document.createElementNS(SVGNS, t);
  if (it.t === 'tx') {
    const e = ns('text');
    e.setAttribute('fill', it.c); e.setAttribute('font-size', it.s * K); e.setAttribute('font-family', FONT);
    it.v.split('\n').forEach((ln, i) => {
      const t = ns('tspan');
      t.setAttribute('x', it.x * K);
      if (i === 0) t.setAttribute('y', (it.y + it.s * 0.85) * K); else t.setAttribute('dy', it.s * 1.25 * K);
      t.textContent = ln || ' ';
      e.append(t);
    });
    return e;
  }
  const e = ns('path');
  e.setAttribute('d', pathD(it.p)); e.setAttribute('fill', 'none');
  e.setAttribute('stroke', it.c); e.setAttribute('stroke-width', it.w * K);
  e.setAttribute('stroke-linejoin', 'round');
  if (it.t === 'hl') { e.setAttribute('stroke-linecap', 'butt'); e.setAttribute('stroke-opacity', '0.4'); e.style.mixBlendMode = 'multiply'; }
  else e.setAttribute('stroke-linecap', 'round');
  return e;
}
function renderAnnoPage(p) {
  if (!p) return;
  const items = an.data.get(p.n);
  if (!items || !items.length) { if (p.svg) p.svg.replaceChildren(); return; }
  const svg = svgOf(p);
  svg.replaceChildren();
  for (const it of items) { const e = itemEl(it); elOf.set(it, e); svg.append(e); }
}
function annoReset() {
  an.data.clear(); an.undo = []; an.cur = null;
  clearTimeout(annoTimer);
  updateAnnoUi();
}

/* 글자 상자(지우개·고치기 판정용) */
function textBox(it) {
  const lines = it.v.split('\n');
  let w = 0;
  for (const ln of lines) {
    let u = 0;
    for (const ch of ln) u += ch.charCodeAt(0) >= 0x1100 ? 1 : 0.55;
    w = Math.max(w, u);
  }
  return { x: it.x, y: it.y, w: w * it.s, h: lines.length * it.s * 1.25 };
}
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
function hitItem(it, x, y, rad) {
  if (it.t === 'tx') {
    const b = textBox(it);
    return x >= b.x - rad && x <= b.x + b.w + rad && y >= b.y - rad && y <= b.y + b.h + rad;
  }
  const r = rad + it.w / 2, p = it.p;
  if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= r;
  for (let i = 1; i < p.length; i++) if (segDist(x, y, p[i - 1], p[i]) <= r) return true;
  return false;
}

/* 그리기 */
function toPt(c, cx, cy) {
  return [r4(clamp((cx - c.r.left) / c.r.width, 0, 1)), r4(clamp((cy - c.r.top) / c.r.width, 0, c.p.ar))];
}
function annoBegin(cx, cy) {
  if (!pdf || !pages.length || gz) return false;
  const rc = scroller.getBoundingClientRect();
  const p = pages[pageAt(scroller.scrollTop + cy - rc.top)];
  const r = p.el.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom || !r.width) return false;
  const tool = an.tool;
  const c = { tool, p, r, x0: cx, y0: cy, moved: false, ops: [], raf: 0, it: null, el: null };
  an.cur = c;
  if (tool === 'pen' || tool === 'hl') {
    c.it = { t: tool, c: COLORS[tool][an.ci[tool]], w: WIDTHS[tool][an.wi[tool]], p: [toPt(c, cx, cy)] };
    c.el = itemEl(c.it); svgOf(p).append(c.el);
  } else if (tool === 'er') eraseAt(c, cx, cy);
  return true;
}
function annoMove(cx, cy) {
  const c = an.cur;
  if (!c) return;
  if (!c.moved && Math.hypot(cx - c.x0, cy - c.y0) > 8) c.moved = true;
  if (c.tool === 'pen' || c.tool === 'hl') {
    const pt = toPt(c, cx, cy), l = c.it.p[c.it.p.length - 1];
    if (Math.hypot(pt[0] - l[0], pt[1] - l[1]) < 0.0006) return;
    c.it.p.push(pt);
    if (!c.raf) c.raf = requestAnimationFrame(() => { c.raf = 0; c.el.setAttribute('d', pathD(c.it.p)); });
  } else if (c.tool === 'er') eraseAt(c, cx, cy);
}
function eraseAt(c, cx, cy) {
  const arr = an.data.get(c.p.n);
  if (!arr || !arr.length) return;
  const [x, y] = toPt(c, cx, cy), rad = 14 / c.r.width;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!hitItem(arr[i], x, y, rad)) continue;
    const it = arr[i];
    arr.splice(i, 1);
    const e = elOf.get(it); if (e) e.remove();
    c.ops.push({ k: 'del', n: c.p.n, it, i });
  }
}
function annoEnd() {
  const c = an.cur; an.cur = null;
  if (!c) return;
  if (c.raf) cancelAnimationFrame(c.raf);
  if (c.tool === 'pen' || c.tool === 'hl') {
    c.el.setAttribute('d', pathD(c.it.p));
    elOf.set(c.it, c.el);
    itemsOf(c.p.n).push(c.it);
    pushUndo([{ k: 'add', n: c.p.n, it: c.it }]);
  } else if (c.tool === 'er') {
    if (c.ops.length) pushUndo(c.ops);
  } else if (c.tool === 'tx' && !c.moved) {
    const pt = toPt(c, c.x0, c.y0), arr = an.data.get(c.p.n) || [];
    let idx = -1;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].t === 'tx' && hitItem(arr[i], pt[0], pt[1], 0.008)) { idx = i; break; }
    openTextEditor(c.p, pt, idx);
  }
}
function annoAbort() {
  const c = an.cur; an.cur = null;
  if (!c) return;
  if (c.raf) cancelAnimationFrame(c.raf);
  if (c.el) c.el.remove();
  if (c.tool === 'er' && c.ops.length) pushUndo(c.ops);
}
function pushUndo(ops) {
  an.undo.push(ops);
  if (an.undo.length > 100) an.undo.shift();
  annoChanged();
}
function annoUndo() {
  const ops = an.undo.pop();
  if (!ops) { toast('되돌릴 것이 없습니다'); return; }
  const touched = new Set();
  for (let j = ops.length - 1; j >= 0; j--) {
    const o = ops[j], arr = itemsOf(o.n);
    touched.add(o.n);
    if (o.k === 'add') { const i = arr.indexOf(o.it); if (i >= 0) arr.splice(i, 1); }
    else arr.splice(Math.min(o.i, arr.length), 0, o.it);
  }
  for (const n of touched) renderAnnoPage(pages[n - 1]);
  annoChanged();
}

/* 글자 넣기·고치기 */
function openTextEditor(p, pt, idx) {
  const arr = itemsOf(p.n), old = idx >= 0 ? arr[idx] : null;
  const ta = h('textarea', { rows: '3', placeholder: '넣을 글자' });
  ta.value = old ? old.v : '';
  const finish = () => {
    const v = ta.value.replace(/\s+$/, '');
    closeSheet(true);
    if (!v) {
      if (old) { const e = elOf.get(old); if (e) e.remove(); arr.splice(idx, 1); pushUndo([{ k: 'del', n: p.n, it: old, i: idx }]); }
      return;
    }
    if (old && old.v === v) return;
    const s = old ? old.s : WIDTHS.tx[an.wi.tx];
    const nw = old ? { ...old, v } : { t: 'tx', c: COLORS.tx[an.ci.tx], s, x: r4(clamp(pt[0], 0, 0.9)), y: r4(Math.max(0, pt[1] - s * 0.5)), v };
    const ops = [];
    if (old) { arr.splice(idx, 1); ops.push({ k: 'del', n: p.n, it: old, i: idx }); const e = elOf.get(old); if (e) e.remove(); }
    const e = itemEl(nw); elOf.set(nw, e); svgOf(p).append(e);
    if (old) arr.splice(idx, 0, nw); else arr.push(nw);
    ops.push({ k: 'add', n: p.n, it: nw });
    pushUndo(ops);
  };
  openSheet(() => [
    h('h3', {}, old ? '글자 고치기' : '글자 넣기'),
    h('div', { class: 'row' }, ta),
    h('div', { class: 'row' },
      h('button', { class: 'pri', onclick: finish }, '확인'),
      old ? h('button', { class: 'sec', onclick: () => { ta.value = ''; finish(); } }, '지우기') : '',
      h('button', { class: 'sec', onclick: () => closeSheet(true) }, '취소')),
  ]);
  setTimeout(() => ta.focus(), 60);
}

/* 보관 (이 폰의 앱 안, 문서별) */
let annoTimer = 0;
function annoChanged() { updateAnnoUi(); clearTimeout(annoTimer); annoTimer = setTimeout(saveAnno, 700); }
async function saveAnno() {
  clearTimeout(annoTimer);
  if (!pdf) return;
  const d = [];
  for (const [n, items] of an.data) if (items.length) d.push([n, items]);
  try {
    if (d.length) await idbPut('anno:' + docKey, { v: 1, d });
    else await idbDel('anno:' + docKey);
  } catch (e) { console.warn('필기 보관 실패', e); }
}
async function loadAnno() {
  an.data.clear(); an.undo = [];
  try {
    const v = await idbGet('anno:' + docKey);
    if (v && v.d) for (const [n, items] of v.d) if (n >= 1 && n <= pages.length) an.data.set(n, items);
  } catch (e) { console.warn(e); }
  for (const n of an.data.keys()) renderAnnoPage(pages[n - 1]);
  updateAnnoUi();
}
document.addEventListener('visibilitychange', () => { if (document.hidden && pdf) saveAnno(); });

/* 도구 막대 */
function annoMode(on) {
  if (on && !pdf) return;
  an.on = on;
  document.body.classList.toggle('anno', on);
  annoBar.hidden = !on;
  if (on) {
    if (uiHidden) toggleUi();
    if (an.tool === 'hand') an.tool = 'pen';
  } else { if (an.cur) annoAbort(); saveAnno(); }
  updateAnnoUi();
}
function setTool(t) { an.tool = t; updateAnnoUi(); }
function updateAnnoUi() {
  document.body.classList.toggle('annoDraw', an.on && an.tool !== 'hand');
  for (const b of annoBar.querySelectorAll('#aTools button')) b.classList.toggle('on', b.dataset.tool === an.tool);
  const sw = $('#aSw'), wb = $('#aWidth'), t = an.tool;
  const colored = t === 'pen' || t === 'hl' || t === 'tx';
  sw.replaceChildren();
  if (colored) {
    COLORS[t].forEach((c, i) => {
      const b = h('button', { class: i === an.ci[t] ? 'on' : '', 'aria-label': '색' });
      b.style.background = c;
      b.addEventListener('click', () => { an.ci[t] = i; updateAnnoUi(); });
      sw.append(b);
    });
  }
  wb.hidden = !colored;
  if (colored) wb.textContent = `${t === 'tx' ? '크기' : '굵기'} ${an.wi[t] + 1}`;
  $('#aUndo').disabled = !an.undo.length;
}
for (const b of annoBar.querySelectorAll('#aTools button')) b.addEventListener('click', () => setTool(b.dataset.tool));
$('#aWidth').addEventListener('click', () => { const t = an.tool; an.wi[t] = (an.wi[t] + 1) % WIDTHS[t].length; updateAnnoUi(); });
$('#aUndo').addEventListener('click', annoUndo);
$('#aDone').addEventListener('click', () => annoMode(false));
$('#aSave').addEventListener('click', exportPdf);
$('#btnAnno').addEventListener('click', () => annoMode(true));


/* ---------- 필기를 PDF에 합쳐 저장 ---------- */
async function exportPdf() {
  if (!pdf) return;
  let count = 0;
  for (const it of an.data.values()) count += it.length;
  if (!count) { toast('저장할 필기가 없습니다'); return; }
  busy('PDF로 저장하는 중...');
  try {
    await saveAnno();
    const { PDFDocument, rgb, LineCapStyle, BlendMode, degrees } = await import(LIB + 'pdf-lib.esm.min.js');
    const src = await pdf.getData();
    const doc = await PDFDocument.load(src, { updateMetadata: false });
    const col = (c) => rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);
    const f2 = (v) => Math.round(v * 100) / 100;
    for (const [pn, items] of an.data) {
      if (!items.length || pn > doc.getPageCount()) continue;
      busy(`PDF로 저장하는 중 ${pn}쪽`);
      const vp = (await pdf.getPage(pn)).getViewport({ scale: 1 });
      const W = vp.width;
      const P = (x, y) => vp.convertToPdfPoint(x * W, y * W);   // 화면 좌표 -> PDF 좌표 (회전·잘림 반영)
      const page = doc.getPage(pn - 1);
      for (const it of items) {
        if (it.t === 'tx') { await drawTextImage(doc, page, it, P, degrees); continue; }
        const q = it.p.map(([x, y]) => { const [a, b] = P(x, y); return [a, -b]; });   // drawSvgPath는 y를 뒤집어 쓴다
        let d = `M${f2(q[0][0])} ${f2(q[0][1])}`;
        if (q.length === 1) d += 'l0.01 0';
        for (let i = 1; i < q.length - 1; i++) {
          d += `Q${f2(q[i][0])} ${f2(q[i][1])} ${f2((q[i][0] + q[i + 1][0]) / 2)} ${f2((q[i][1] + q[i + 1][1]) / 2)}`;
        }
        if (q.length > 1) d += `L${f2(q[q.length - 1][0])} ${f2(q[q.length - 1][1])}`;
        const hl = it.t === 'hl';
        page.drawSvgPath(d, {
          x: 0, y: 0, borderColor: col(it.c), borderWidth: it.w * W,
          borderOpacity: hl ? 0.4 : 1, borderLineCap: hl ? LineCapStyle.Butt : LineCapStyle.Round,
          ...(hl ? { blendMode: BlendMode.Multiply } : {}),
        });
      }
    }
    busy('파일 만드는 중...');
    const out = await doc.save();
    const base = docName.replace(/\.pdf$/i, '') || '문서';
    await deliverPdf(out, base + '_필기.pdf');
  } catch (e) {
    console.error(e);
    const msg = String(e && e.message || e);
    toast(/encrypt/i.test(msg) ? '암호가 걸린 문서는 필기를 합쳐 저장할 수 없습니다' : '저장하지 못했습니다');
  } finally { busy(''); }
}

// 글자는 폰의 글꼴로 그림 파일을 만들어 얹는다 (PDF 안에 한글 글꼴을 넣지 않으려고)
async function drawTextImage(doc, page, it, P, degrees) {
  const px = 64, lines = it.v.split('\n');
  const cv = document.createElement('canvas'), cx = cv.getContext('2d');
  cx.font = `${px}px ${FONT}`;
  let w = 0;
  for (const ln of lines) w = Math.max(w, cx.measureText(ln).width);
  cv.width = Math.max(2, Math.ceil(w) + 4); cv.height = Math.ceil(lines.length * px * 1.25);
  cx.font = `${px}px ${FONT}`; cx.fillStyle = it.c; cx.textBaseline = 'alphabetic';
  lines.forEach((ln, i) => cx.fillText(ln, 0, px * 0.85 + i * px * 1.25));
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const img = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
  const u = it.s / px;                                        // 캔버스 1px = 쪽 너비 기준 u
  const tl = P(it.x, it.y), tr = P(it.x + cv.width * u, it.y), bl = P(it.x, it.y + cv.height * u);
  page.drawImage(img, {
    x: bl[0], y: bl[1],
    width: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), height: Math.hypot(bl[0] - tl[0], bl[1] - tl[1]),
    rotate: degrees(Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180 / Math.PI),
  });
}

async function deliverPdf(bytes, name) {
  const N = window.PdfNative;
  if (N) {
    if (typeof N.saveStart !== 'function') { toast('저장 기능이 들어간 새 앱을 설치해야 합니다'); return; }
    if (!N.saveStart(name)) { toast('저장 공간을 열지 못했습니다'); return; }
    const CH = 3 * 256 * 1024;
    for (let off = 0; off < bytes.length; off += CH) {
      const part = bytes.subarray(off, Math.min(bytes.length, off + CH));
      let bin = '';
      for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
      if (!N.saveChunk(btoa(bin))) { N.saveEnd(false); toast('저장하지 못했습니다'); return; }
      busy(`저장하는 중 ${Math.round(Math.min(bytes.length, off + CH) / bytes.length * 100)}%`);
    }
    const saved = N.saveEnd(true);
    if (!saved) { toast('저장하지 못했습니다'); return; }
    toast(`다운로드 폴더에 저장했습니다\n${saved}`, 4200);
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('저장했습니다: ' + name);
}

// 시험·점검용으로 바깥에서 상태를 볼 수 있게 노출
window.__pdfv = { get zoom() { return zoom; }, get pages() { return pages; }, get live() { return live; }, setZoom, refresh, goPage, openBuffer, an, annoMode, annoSaveNow: () => saveAnno(), exportPdf };

// 서비스 워커 (오프라인 보관)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
