import * as pdfjsLib from './lib/pdf.min.mjs';
import { svg, fillIcons } from './icons.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const LIB = new URL('./lib/', import.meta.url).href;
const VERSION = '1.2.2';

const $ = (s) => document.querySelector(s);
const scroller = $('#scroller'), pagesEl = $('#pages'), topbar = $('#topbar');
const pageBtn = $('#btnPage'), zoomPill = $('#zoomPill');
const emptyEl = $('#empty'), busyEl = $('#busy'), toastEl = $('#toast');
const sheet = $('#sheet'), sheetBody = $('#sheetBody'), fileInput = $('#file');

const dpr = Math.min(window.devicePixelRatio || 1, 3);
const MAX_PIXELS = 6e6;          // 캔버스 한 장의 최대 화소 수 (폰 메모리 보호)
const MIN_Z = 0.25, MAX_Z = 8;   // 1 = 화면 폭에 맞춤 (그보다 작으면 줄여서 여러 쪽이 보임)
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
let pdf = null, pdfTask = null, pages = [], fit = 0, zoom = 1, docKey = '', docName = '', docBuf = null;
const live = new Set();            // 캔버스를 가진 페이지
let curJob = null, pumping = false;
let uiHidden = false;
let vm = store.get('vm', 'scroll');   // 보기 방식: scroll(이어서) | single(한 쪽) | double(두 쪽)
if (!['scroll', 'single', 'double'].includes(vm)) vm = 'scroll';
let blk = 1, shown = [], sumAr = 0;    // 낱장 보기에서 지금 보이는 첫 쪽 번호, 보이는 쪽들, 모든 쪽의 높이/너비 합
const hl = { rects: new Map(), stamp: 0 };   // 검색 강조

document.body.classList.toggle('dark', !!store.get('dark', false));
document.body.classList.add('noDoc', 'vm-' + vm);
fillIcons();

/* ---------- 문서 열기 ---------- */
async function openBuffer(buf, name, fromStore) {
  closeSheet();
  busy('불러오는 중...');
  // pdf.js가 데이터를 가져가 버리므로, 보관할 사본은 먼저 떠 둔다
  const keep = (!fromStore && buf.byteLength <= KEEP_MAX) ? buf.slice(0) : null;
  const copyForEdit = keep || buf.slice(0);
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
  pdf = doc; pdfTask = task; docName = name || '문서.pdf'; docBuf = copyForEdit;
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
  document.title = docName;
  sumAr = pages.reduce((a, q) => a + q.ar + 0.012, 0);
  shown = [];
  fit = scroller.clientWidth / cols(); zoom = 1; applyWidth();

  const pos = store.get('pos:' + docKey, null);
  if (paged()) showBlock(pos ? pos.p : 1);
  else { if (pos) goPage(pos.p, pos.f); else scroller.scrollTop = 0; scroller.scrollLeft = 0; }
  await loadAnno();
  busy('');
  updateIndicator(); refresh(); saveRecent();
  if (keep) keepCopy(docKey, docName, keep);
  return true;
}

function closeDoc() {
  if (curJob) { try { curJob.task.cancel(); } catch { /* 무시 */ } curJob = null; }
  for (const p of pages) freeCanvas(p);
  pagesEl.replaceChildren(); pages = []; live.clear(); shown = [];
  if (pdf) {
    const t = pdfTask; pdfTask = null;
    try { const r = t && t.destroy ? t.destroy() : (pdf.destroy ? pdf.destroy() : null); if (r && r.catch) r.catch(() => {}); } catch { /* 무시 */ }
    pdf = null;
  }
  docBuf = null;
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
const cols = () => (vm === 'double' ? 2 : 1);
const paged = () => vm !== 'scroll';
function applyWidth() { pagesEl.style.setProperty('--pw', (fit * zoom) + 'px'); }

function blockPages() {      // 낱장·두 쪽 보기에서 화면에 있는 쪽들
  return (vm === 'double' ? [pages[blk - 1], pages[blk]] : [pages[blk - 1]]).filter(Boolean);
}
function pageAt(y) {
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1, e = pages[mid].el;
    if (e.offsetTop + e.offsetHeight < y) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function pageFromPoint(cx, cy) {
  const rc = scroller.getBoundingClientRect();
  const list = paged() ? blockPages() : [pages[pageAt(scroller.scrollTop + cy - rc.top)]];
  for (const p of list) {
    const r = p.el.getBoundingClientRect();
    if (r.width && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return p;
  }
  return null;
}

function goPage(n, f = 0) {
  if (!pages.length) return;
  n = clamp(Math.round(n), 1, pages.length);
  if (paged()) { showBlock(n); return; }
  const p = pages[n - 1];
  scroller.scrollTop = p.el.offsetTop + clamp(f, 0, 1) * p.el.offsetHeight;
}

function currentPos() {
  if (paged()) return { p: blk, f: 0 };
  const st = scroller.scrollTop;
  const i = pageAt(st + 1), e = pages[i].el;
  return { p: i + 1, f: clamp((st - e.offsetTop) / e.offsetHeight, 0, 0.999) };
}

function updateIndicator() {
  if (!pages.length) return;
  if (paged()) {
    const last = vm === 'double' && blk < pages.length ? `-${blk + 1}` : '';
    pageBtn.textContent = `${blk}${last} / ${pages.length}`;
    return;
  }
  const i = pageAt(scroller.scrollTop + scroller.clientHeight * 0.35);
  pageBtn.textContent = `${i + 1} / ${pages.length}`;
}

/* 보기 방식 */
function padsV() { const cs = getComputedStyle(pagesEl); return [parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0]; }
function blockAr() {       // 쪽 한 줄(보이는 덩어리)의 높이 / 쪽 너비
  if (!pages.length) return 1;
  if (!paged()) return sumAr;
  return Math.max(...blockPages().map((p) => p.ar));
}
// 배율 z일 때 덩어리의 위치와 전체 크기를 계산 (실제 화면 배치와 같은 식)
function layoutAt(z) {
  const vw = scroller.clientWidth, vh = scroller.clientHeight;
  const pw = fit * z, bw = cols() * pw, bh = pw * blockAr();
  const [pt, pb] = padsV();
  const Wc = Math.max(bw, vw), Hc = Math.max(pt + bh + pb, vh);
  return { Wc, Hc, bx: (Wc - bw) / 2, by: pt + (paged() ? Math.max(0, (Hc - pt - pb - bh) / 2) : 0) };
}
// 한 쪽(들)이 화면에 다 들어오는 배율 (최대 1 = 폭 맞춤)
function zWhole(ar) {
  const [pt, pb] = padsV();
  const availH = scroller.clientHeight - (paged() ? pt + pb : 56);
  return clamp(availH / (fit * ar), MIN_Z, 1);
}
const baseZoom = () => (paged() ? zWhole(blockAr()) : 1);

function showBlock(n) {
  n = clamp(Math.round(n), 1, pages.length);
  blk = vm === 'double' ? n - ((n - 1) % 2) : n;
  const vis = blockPages();
  for (const q of shown) if (!vis.includes(q)) { q.el.classList.remove('cur'); freeCanvas(q); }
  for (const q of vis) q.el.classList.add('cur');
  shown = vis;
  zoom = baseZoom(); applyWidth();
  scroller.scrollLeft = 0; scroller.scrollTop = 0;
  updateIndicator(); scheduleRefresh(30, true); savePosSoon();
}
function pageStep(d) {
  if (!pages.length) return;
  if (paged()) {
    const next = clamp(blk + d * cols(), 1, pages.length);
    if (next === blk || (vm === 'double' && d > 0 && blk + 1 >= pages.length)) { toast(d > 0 ? '마지막 쪽입니다' : '첫 쪽입니다', 900); return; }
    showBlock(next);
  } else {
    const vh = scroller.clientHeight;
    scroller.scrollTop += d * vh * 0.9;
  }
}

function relayout() {      // 화면 크기나 보기 방식이 바뀐 뒤 배치를 다시 잡는다
  const c = pages.length ? currentPos() : { p: 1, f: 0 };
  fit = scroller.clientWidth / cols();
  if (paged()) showBlock(c.p);
  else { applyWidth(); goPage(c.p, c.f); scheduleRefresh(100, true); }
}

const VIEW_ICON = { scroll: 'view-scroll', single: 'view-single', double: 'view-double' };
const VIEW_NAME = { scroll: '이어서 보기', single: '한 쪽씩 보기', double: '두 쪽씩 보기' };
function paintViewBtn() {
  const b = $('#btnView');
  b.innerHTML = svg(VIEW_ICON[vm]);
  b.setAttribute('aria-label', VIEW_NAME[vm]);
}
function setViewMode(m) {
  if (m === vm) return;
  const c = pages.length ? currentPos() : { p: 1, f: 0 };
  document.body.classList.remove('vm-' + vm);
  vm = m; store.set('vm', m);
  document.body.classList.add('vm-' + vm);
  paintViewBtn();
  for (const q of pages) q.el.classList.remove('cur');
  shown = [];
  if (!pdf) return;
  fit = scroller.clientWidth / cols();
  if (paged()) showBlock(c.p);
  else { zoom = 1; applyWidth(); goPage(c.p, c.f); scheduleRefresh(60, true); savePosSoon(); }
  toast(VIEW_NAME[vm], 1100);
}
function toggleFit() {      // 폭 맞춤 <-> 쪽 전체 보기
  if (!pdf) return;
  const target = paged() ? 1 : zWhole(pages[currentPos().p - 1].ar);
  const whole = paged() ? baseZoom() : target;
  if (!paged() && whole >= 0.999) { toast('이미 한 쪽이 다 보입니다', 1100); return; }
  const rc = scroller.getBoundingClientRect();
  if (Math.abs(zoom - whole) < 0.02) { animateZoom(1, rc.width / 2, rc.height / 2); return; }
  if (paged()) { zoom = whole; applyWidth(); scroller.scrollLeft = 0; scroller.scrollTop = 0; showPill(); scheduleRefresh(30, true); return; }
  const c = currentPos();
  zoom = whole; applyWidth(); goPage(c.p, 0);
  scroller.scrollTop = Math.max(0, scroller.scrollTop - 48); scroller.scrollLeft = 0;
  showPill(); updateIndicator(); scheduleRefresh(30, true); savePosSoon();
}

/* ---------- 확대 ---------- */
let pillTimer = 0;
function showPill(z = zoom) {
  zoomPill.textContent = Math.round(z * 100) + '%'; zoomPill.hidden = false;
  clearTimeout(pillTimer); pillTimer = setTimeout(() => { zoomPill.hidden = true; }, 900);
}

// 배율 z0 -> z1. 화면 위 점 (mx, my) 아래의 내용을 붙잡은 채로 바뀔 때의
// 스크롤 위치(L, T)와 덩어리 위치(a, b)를 계산한다. 실제 레이아웃과 같은 식이라
// 확대 중 미리보기와 손을 뗀 뒤의 화면이 어긋나지 않는다.
function anchorCalc(z0, z1, sl0, st0, mx, my) {
  const a = layoutAt(z0), b = layoutAt(z1), r = z1 / z0;
  const vw = scroller.clientWidth, vh = scroller.clientHeight;
  const nx = b.bx + (sl0 + mx - a.bx) * r, ny = b.by + (st0 + my - a.by) * r;
  return { a, b, r, L: clamp(nx - mx, 0, Math.max(0, b.Wc - vw)), T: clamp(ny - my, 0, Math.max(0, b.Hc - vh)) };
}

// 키보드·마우스 휠용: 배율을 바로 바꾼다 (손가락 확대는 아래 제스처 방식)
function setZoom(z, cx, cy) {
  z = clamp(z, MIN_Z, MAX_Z);
  if (Math.abs(z - zoom) < 1e-4) return;
  const c = anchorCalc(zoom, z, scroller.scrollLeft, scroller.scrollTop, cx, cy);
  zoom = z; applyWidth();
  scroller.scrollLeft = c.L; scroller.scrollTop = c.T;
  showPill();
}

// 손가락 확대: 움직이는 동안은 화면을 GPU로 늘이기만 하고(레이아웃·다시 그리기 없음),
// 손을 떼는 순간 한 번만 배율을 확정한 뒤 그 배율로 선명하게 다시 그린다.
let gz = null, gzRaf = 0, gzTimer = 0;
function gestureBegin(mx, my) {
  if (curJob) { try { curJob.task.cancel(); } catch { /* 무시 */ } }
  const sl0 = scroller.scrollLeft, st0 = scroller.scrollTop, a = layoutAt(zoom);
  gz = { z0: zoom, sl0, st0, a, mx0: mx, my0: my, mx, my, s: 1 };
  pagesEl.style.transition = 'none';
  pagesEl.style.transformOrigin = `${a.bx}px ${a.by}px`;
  pagesEl.style.willChange = 'transform';
}
// 손가락 밑의 내용이 손가락을 따라가도록 이동량을 계산한다
function gzTransform() {
  const c = anchorCalc(gz.z0, gz.z0 * gz.s, gz.sl0, gz.st0, gz.mx, gz.my);
  return `translate(${c.b.bx - c.L - gz.a.bx + gz.sl0}px, ${c.b.by - c.T - gz.a.by + gz.st0}px) scale(${gz.s})`;
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
  const z1 = clamp(g.z0 * g.s, MIN_Z, MAX_Z);
  const c = anchorCalc(g.z0, z1, g.sl0, g.st0, g.mx, g.my);
  pagesEl.style.transition = 'none';
  pagesEl.style.transform = ''; pagesEl.style.willChange = ''; pagesEl.style.transformOrigin = '';
  zoom = z1; applyWidth();
  scroller.scrollLeft = c.L; scroller.scrollTop = c.T;
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
  if (paged()) return blockPages();
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
    if (paged()) { if (!p.el.classList.contains('cur')) freeCanvas(p); continue; }
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
    h('h3', {}, `PDF 도깨비 ${VERSION}`),
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

/* ---------- 편집 화면 (처음 누를 때 불러옴) ---------- */
let editorMod = null;
const pdfOpts = (bytes) => ({ data: bytes, cMapUrl: LIB + 'cmaps/', cMapPacked: true, standardFontDataUrl: LIB + 'standard_fonts/', wasmUrl: LIB + 'wasm/', iccUrl: LIB + 'iccs/', isEvalSupported: false });
function editCtx() {
  return {
    h, svg, toast, busy, openSheet, closeSheet, LIB, deliverPdf, libCtx, pdfjs: pdfjsLib, pdfOpts,
    currentDoc: async () => (pdf && docBuf ? { name: docName, bytes: new Uint8Array(docBuf.slice(0)) } : null),
    openInViewer: async (bytes, name, o) => {
      const ok = await openBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name);
      if (ok && o && o.stamp) { annoMode(true); setTool('st'); openStampPop(); }
    },
  };
}
async function openEditorScreen(screen) {
  try { editorMod = editorMod || await import('./edit.js'); await editorMod.openEditor(editCtx(), screen); }
  catch (e) { console.error(e); toast('편집 화면을 열지 못했습니다'); }
}
$('#btnEdit').addEventListener('click', () => openEditorScreen());
$('#btnSearch').addEventListener('click', openSearch);
$('#btnPage').addEventListener('click', openGoto);
paintViewBtn();
$('#btnView').addEventListener('click', () => setViewMode(vm === 'scroll' ? 'single' : vm === 'single' ? 'double' : 'scroll'));
$('#btnFit').addEventListener('click', toggleFit);
$('#btnMore').addEventListener('click', () => openSheet(() => [
  h('h3', {}, '더보기'),
  h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => { closeSheet(); pickFile(); } }, 'PDF 열기')),
  h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => { closeSheet(); openEditorScreen(); } }, '편집 (쪽 정리·합치기·나누기…)')),
  h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => { closeSheet(); openInfo(); } }, '문서 정보')),
]));
$('#btnHome').addEventListener('click', goHome);
function goHome() {
  if (an.on) annoMode(false);
  savePos(); closeDoc();
  scroller.hidden = true; emptyEl.hidden = false;
  document.body.classList.add('noDoc'); document.title = 'PDF 도깨비';
  renderRecent();
}
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
  if (editorMod && editorMod.editorOpen()) { if (!sheet.hidden) { closeSheet(); return true; } return editorMod.editorBack(); }
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
  if (w && lastW && w !== lastW) relayout();
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
    tp = { mode: 'tap', x: t.clientX, y: t.clientY, t: Date.now(), moved: false, ex: t.clientX, ey: t.clientY };
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
    tp.ex = t.clientX; tp.ey = t.clientY;
  }
}, { passive: false });

scroller.addEventListener('touchend', (e) => {
  if (tp && tp.mode === 'draw') {
    if (e.cancelable) e.preventDefault();   // 뒤따르는 가짜 클릭이 방금 연 창을 닫지 않게
    annoEnd(); tp = e.touches.length === 0 ? null : { mode: 'none' }; return;
  }
  if (tp && tp.mode === 'tap' && tp.moved && paged() && e.touches.length === 0 && !gz) {
    // 한 쪽씩·두 쪽씩 보기: 옆으로 쓸어 넘기기 (좌우로 밀 수 있게 확대된 상태에서는 이동이 우선)
    const dx = tp.ex - tp.x, dy = tp.ey - tp.y;
    if (Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.7 && Date.now() - tp.t < 700 &&
        layoutAt(zoom).Wc <= scroller.clientWidth + 1) pageStep(dx < 0 ? 1 : -1);
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
  if (paged() && !an.on) {          // 가장자리를 누르면 쪽 넘김
    const w = scroller.clientWidth;
    if (x < w * 0.2) { clearTimeout(tapTimer); lastTap.t = 0; pageStep(-1); return; }
    if (x > w * 0.8) { clearTimeout(tapTimer); lastTap.t = 0; pageStep(1); return; }
  }
  if (now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
    clearTimeout(tapTimer); lastTap.t = 0;
    const rc = scroller.getBoundingClientRect();
    const base = baseZoom();
    animateZoom(zoom < base * 1.6 ? base * 2.5 : base, x - rc.left, y - rc.top);
  } else {
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    if (!an.on) tapTimer = setTimeout(toggleUi, 300);
  }
}
function toggleUi() {
  uiHidden = !uiHidden;
  topbar.classList.toggle('hidden', uiHidden);
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
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { pageStep(1); return; }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { pageStep(-1); return; }
  if (e.key === '+' || e.key === '=') { setZoom(zoom * 1.25, cx, cy); scheduleRefresh(150, true); }
  else if (e.key === '-') { setZoom(zoom / 1.25, cx, cy); scheduleRefresh(150, true); }
  else if (e.key === '0') { setZoom(baseZoom(), cx, cy); scheduleRefresh(150, true); }
});


/* ---------- 필기 ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
const K = 1000;                                  // 필기 좌표는 쪽 너비를 1로 둔 값, 그릴 때만 K배
const FONT = 'system-ui, "Noto Sans KR", "Apple SD Gothic Neo", sans-serif';
const BASE_COLORS = ['#1a1a1a', '#e03131', '#f59f00', '#fcc419', '#20c997', '#4dabf7', '#1c4eea', '#9c36e8', '#868e96'];
const RANGE = { pen: [0.001, 0.012, 0.0005], hl: [0.01, 0.05, 0.001], tx: [0.014, 0.07, 0.002] };
const TOOL_NAME = { pen: '펜', hl: '형광펜', tx: '글자' };
const an = {
  on: false, tool: 'pen', cur: null, undo: [], redo: [], pop: null,
  col: { pen: '#1a1a1a', hl: '#fcc419', tx: '#1a1a1a' }, w: { pen: 0.004, hl: 0.022, tx: 0.026 }, recent: [],
  data: new Map(),                               // 쪽 번호 -> 글씨·그림·도장 목록
  imgs: new Map(),                               // 도장 그림 id -> data URL
  pick: null,                                    // 찍으려고 고른 도장
  sel: null,                                     // 선택된 도장 { n, it }
};
{
  const v = store.get('annoPrefs', null);
  if (v) { Object.assign(an.col, v.col || {}); Object.assign(an.w, v.w || {}); an.recent = v.recent || []; }
}
const savePrefs = () => store.set('annoPrefs', { col: an.col, w: an.w, recent: an.recent });
const elOf = new WeakMap();
const annoBar = $('#annoBar'), annoPop = $('#annoPop');
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
  if (it.t === 'img') {
    const e = ns('image');
    e.setAttribute('href', an.imgs.get(it.k) || '');
    e.setAttribute('preserveAspectRatio', 'none');
    setImgGeom(e, it);
    return e;
  }
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
function setImgGeom(e, it) {
  e.setAttribute('x', it.x * K); e.setAttribute('y', it.y * K);
  e.setAttribute('width', it.w * K); e.setAttribute('height', it.h * K);
}
function renderAnnoPage(p) {
  if (!p) return;
  const items = an.data.get(p.n);
  if (!items || !items.length) { if (p.svg) p.svg.replaceChildren(); drawSel(); return; }
  const svg = svgOf(p);
  svg.replaceChildren();
  for (const it of items) { const e = itemEl(it); elOf.set(it, e); svg.append(e); }
  drawSel();
}
function annoReset() {
  an.data.clear(); an.imgs.clear(); an.undo = []; an.redo = []; an.cur = null; an.sel = null; an.pick = null;
  clearTimeout(annoTimer);
  updateAnnoUi();
}

/* 글자·도장 상자(지우개·고치기 판정용) */
function bboxOf(it) {
  if (it.t === 'img') return { x: it.x, y: it.y, w: it.w, h: it.h };
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
  if (it.t === 'tx' || it.t === 'img') {
    const b = bboxOf(it);
    return x >= b.x - rad && x <= b.x + b.w + rad && y >= b.y - rad && y <= b.y + b.h + rad;
  }
  const r = rad + it.w / 2, p = it.p;
  if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= r;
  for (let i = 1; i < p.length; i++) if (segDist(x, y, p[i - 1], p[i]) <= r) return true;
  return false;
}

/* 도장 선택 표시 */
let selEl = null;
function drawSel() {
  if (selEl) { selEl.remove(); selEl = null; }
  if (!an.sel || !an.on) return;
  const p = pages[an.sel.n - 1];
  if (!p || !(an.data.get(an.sel.n) || []).includes(an.sel.it)) { an.sel = null; return; }
  const it = an.sel.it, ns = (t) => document.createElementNS(SVGNS, t);
  const g = ns('g');
  const r = ns('rect');
  r.setAttribute('x', it.x * K); r.setAttribute('y', it.y * K); r.setAttribute('width', it.w * K); r.setAttribute('height', it.h * K);
  r.setAttribute('fill', 'none'); r.setAttribute('stroke', '#4dabf7'); r.setAttribute('stroke-width', '1.6');
  r.setAttribute('stroke-dasharray', '6 4'); r.setAttribute('vector-effect', 'non-scaling-stroke');
  const c = ns('circle');
  c.setAttribute('cx', (it.x + it.w) * K); c.setAttribute('cy', (it.y + it.h) * K); c.setAttribute('r', 0.014 * K);
  c.setAttribute('fill', '#4dabf7'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1.6'); c.setAttribute('vector-effect', 'non-scaling-stroke');
  g.append(r, c);
  svgOf(p).append(g); selEl = g;
}
function select(n, it) {
  const same = an.sel && an.sel.it === it;
  an.sel = it ? { n, it } : null;
  if (!same) drawSel();
}

/* 그리기 */
function toPt(c, cx, cy) {
  return [r4(clamp((cx - c.r.left) / c.r.width, 0, 1)), r4(clamp((cy - c.r.top) / c.r.width, 0, c.p.ar))];
}
const geomOf = (it) => ({ x: it.x, y: it.y, w: it.w, h: it.h });
function annoBegin(cx, cy) {
  if (!pdf || !pages.length || gz) return false;
  const p = pageFromPoint(cx, cy);
  if (!p) return false;
  const r = p.el.getBoundingClientRect();
  const tool = an.tool;
  if (an.pop === 'style') closePop();
  const c = { tool, p, r, x0: cx, y0: cy, moved: false, ops: [], raf: 0, it: null, el: null, mode: '' };
  an.cur = c;
  if (tool === 'pen' || tool === 'hl') {
    c.it = { t: tool, c: an.col[tool], w: an.w[tool], p: [toPt(c, cx, cy)] };
    c.el = itemEl(c.it); svgOf(p).append(c.el);
  } else if (tool === 'er') eraseAt(c, cx, cy);
  else if (tool === 'st') {
    const pt = toPt(c, cx, cy), arr = an.data.get(p.n) || [];
    c.mode = 'place';
    if (an.sel && an.sel.n === p.n) {
      const it = an.sel.it;
      if (Math.hypot(pt[0] - (it.x + it.w), pt[1] - (it.y + it.h)) <= 28 / r.width) {
        c.mode = 'resize'; c.it = it; c.from = geomOf(it); c.el = elOf.get(it);
        return true;
      }
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      if (it.t === 'img' && hitItem(it, pt[0], pt[1], 0.004)) {
        select(p.n, it); openStampPop();
        c.mode = 'move'; c.it = it; c.from = geomOf(it); c.off = [pt[0] - it.x, pt[1] - it.y]; c.el = elOf.get(it);
        return true;
      }
    }
  }
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
  else if (c.tool === 'st' && c.moved && (c.mode === 'move' || c.mode === 'resize')) {
    const pt = toPt(c, cx, cy), it = c.it, ar = c.from.h / c.from.w;
    if (c.mode === 'move') {
      it.x = r4(clamp(pt[0] - c.off[0], 0, Math.max(0, 1 - it.w)));
      it.y = r4(clamp(pt[1] - c.off[1], 0, Math.max(0, c.p.ar - it.h)));
    } else {
      const w = clamp(pt[0] - it.x, 0.04, 1 - it.x);
      it.w = r4(w); it.h = r4(Math.min(w * ar, c.p.ar - it.y));
      it.w = r4(it.h / ar);
    }
    if (c.el) setImgGeom(c.el, it);
    drawSel();
  }
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
    if (an.sel && an.sel.it === it) { an.sel = null; drawSel(); }
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
  } else if (c.tool === 'st') {
    if (c.mode === 'place' && !c.moved) placeStamp(c.p, toPt(c, c.x0, c.y0));
    else if ((c.mode === 'move' || c.mode === 'resize') && c.moved) {
      pushUndo([{ k: 'mod', n: c.p.n, it: c.it, from: c.from, to: geomOf(c.it) }]);
    }
  }
}
function annoAbort() {
  const c = an.cur; an.cur = null;
  if (!c) return;
  if (c.raf) cancelAnimationFrame(c.raf);
  if (c.tool === 'pen' || c.tool === 'hl') { if (c.el) c.el.remove(); }
  else if (c.tool === 'er' && c.ops.length) pushUndo(c.ops);
  else if (c.tool === 'st' && c.from) { Object.assign(c.it, c.from); if (c.el) setImgGeom(c.el, c.it); drawSel(); }
}
function pushUndo(ops) {
  an.undo.push(ops); an.redo = [];
  if (an.undo.length > 100) an.undo.shift();
  annoChanged();
}
function applyOps(ops, back) {
  const touched = new Set();
  const seq = back ? [...ops].reverse() : ops;
  for (const o of seq) {
    const arr = itemsOf(o.n);
    touched.add(o.n);
    const remove = (back && o.k === 'add') || (!back && o.k === 'del');
    if (o.k === 'mod') Object.assign(o.it, back ? o.from : o.to);
    else if (remove) { const i = arr.indexOf(o.it); if (i >= 0) arr.splice(i, 1); }
    else if (back) arr.splice(Math.min(o.i, arr.length), 0, o.it);
    else arr.push(o.it);
  }
  for (const n of touched) renderAnnoPage(pages[n - 1]);
}
function annoUndo() {
  const ops = an.undo.pop();
  if (!ops) { toast('되돌릴 것이 없습니다', 900); return; }
  applyOps(ops, true); an.redo.push(ops);
  annoChanged();
}
function annoRedo() {
  const ops = an.redo.pop();
  if (!ops) { toast('다시 실행할 것이 없습니다', 900); return; }
  applyOps(ops, false); an.undo.push(ops);
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
    const s = old ? old.s : an.w.tx;
    const nw = old ? { ...old, v } : { t: 'tx', c: an.col.tx, s, x: r4(clamp(pt[0], 0, 0.9)), y: r4(Math.max(0, pt[1] - s * 0.5)), v };
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

/* 도장 찍기 */
function placeStamp(p, pt) {
  const pk = an.pick;
  if (!pk) { toast('먼저 아래 창에서 서명이나 도장을 고르세요', 1500); openStampPop(); return; }
  an.imgs.set(pk.id, pk.url);
  const w = 0.22, h2 = r4(w * pk.ar);
  const it = { t: 'img', k: pk.id, w, h: h2, x: r4(clamp(pt[0] - w / 2, 0, 1 - w)), y: r4(clamp(pt[1] - h2 / 2, 0, Math.max(0, p.ar - h2))) };
  const e = itemEl(it); elOf.set(it, e); svgOf(p).append(e);
  itemsOf(p.n).push(it);
  pushUndo([{ k: 'add', n: p.n, it }]);
  select(p.n, it); openStampPop();
}
function deleteSel() {
  if (!an.sel) return;
  const { n, it } = an.sel, arr = itemsOf(n), i = arr.indexOf(it);
  if (i < 0) return;
  arr.splice(i, 1);
  const e = elOf.get(it); if (e) e.remove();
  an.sel = null; drawSel();
  pushUndo([{ k: 'del', n, it, i }]);
  openStampPop();
}

/* 보관 (이 폰의 앱 안, 문서별) */
let annoTimer = 0;
function annoChanged() { updateAnnoUi(); clearTimeout(annoTimer); annoTimer = setTimeout(saveAnno, 700); }
async function saveAnno() {
  clearTimeout(annoTimer);
  if (!pdf) return;
  const d = [], used = new Set();
  for (const [n, items] of an.data) if (items.length) { d.push([n, items]); for (const it of items) if (it.t === 'img') used.add(it.k); }
  const imgs = {};
  for (const k of used) imgs[k] = an.imgs.get(k);
  try {
    if (d.length) await idbPut('anno:' + docKey, { v: 2, d, imgs });
    else await idbDel('anno:' + docKey);
  } catch (e) { console.warn('필기 보관 실패', e); }
}
async function loadAnno() {
  an.data.clear(); an.imgs.clear(); an.undo = []; an.redo = []; an.sel = null;
  try {
    const v = await idbGet('anno:' + docKey);
    if (v && v.d) {
      for (const [n, items] of v.d) if (n >= 1 && n <= pages.length) an.data.set(n, items);
      for (const [k, u] of Object.entries(v.imgs || {})) an.imgs.set(k, u);
    }
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
  $('#btnAnno').classList.toggle('on', on);
  if (on) {
    if (uiHidden) toggleUi();
    if (an.tool === 'hand') an.tool = 'pen';
  } else { if (an.cur) annoAbort(); closePop(); an.sel = null; drawSel(); saveAnno(); }
  updateAnnoUi();
}
function setTool(t) {
  an.tool = t;
  if (t !== 'st') { an.sel = null; drawSel(); }
  updateAnnoUi();
}
function updateAnnoUi() {
  document.body.classList.toggle('annoDraw', an.on && an.tool !== 'hand');
  for (const b of annoBar.querySelectorAll('[data-tool]')) {
    const t = b.dataset.tool;
    b.classList.toggle('on', t === an.tool);
    const dot = b.querySelector('.dot');
    if (dot) dot.style.background = an.col[t];
  }
  $('#aUndo').disabled = !an.undo.length;
  $('#aRedo').disabled = !an.redo.length;
}
function closePop() { an.pop = null; annoPop.hidden = true; annoPop.replaceChildren(); }

// 펜·형광펜·글자의 색과 굵기 창
function openStylePop() {
  const t = an.tool;
  if (!TOOL_NAME[t]) return;
  an.pop = 'style';
  const [mn, mx, st] = RANGE[t];
  const pv = h('div', { class: 'pv' });
  const paintPv = () => {
    pv.replaceChildren();
    if (t === 'tx') {
      const sp = h('span', {}, '가나다 Abc 123');
      sp.style.cssText = `font-size:${Math.round(an.w.tx * 400)}px;color:${an.col.tx};font-family:${FONT}`;
      pv.append(sp);
    } else {
      const i = h('i');
      i.style.cssText = `height:${Math.max(2, an.w[t] * 400)}px;background:${an.col[t]};${t === 'hl' ? 'opacity:.4' : ''}`;
      pv.append(i);
    }
  };
  const sw = h('div', { class: 'sw' });
  for (const c of [...BASE_COLORS, ...an.recent]) {
    const b = h('button', { class: c === an.col[t] ? 'on' : '', 'aria-label': '색 ' + c });
    b.style.background = c;
    b.addEventListener('click', () => { an.col[t] = c; savePrefs(); updateAnnoUi(); openStylePop(); });
    sw.append(b);
  }
  const ci = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(an.col[t]) ? an.col[t] : '#000000' });
  ci.addEventListener('input', () => { an.col[t] = ci.value; updateAnnoUi(); paintPv(); });
  ci.addEventListener('change', () => {
    an.col[t] = ci.value;
    if (!BASE_COLORS.includes(ci.value)) an.recent = [ci.value, ...an.recent.filter((x) => x !== ci.value)].slice(0, 5);
    savePrefs(); updateAnnoUi(); openStylePop();
  });
  sw.append(h('label', { class: 'cw', 'aria-label': '직접 고르기' }, ci));
  const rg = h('input', { type: 'range', min: String(mn), max: String(mx), step: String(st), value: String(an.w[t]) });
  rg.addEventListener('input', () => { an.w[t] = Number(rg.value); paintPv(); });
  rg.addEventListener('change', savePrefs);
  const x = h('button', { class: 'ib', 'aria-label': '닫기' });
  x.innerHTML = svg('close', 20); x.addEventListener('click', closePop);
  annoPop.replaceChildren(
    h('div', { class: 'ph' }, h('span', {}, `${TOOL_NAME[t]} 색상`), x),
    sw,
    h('div', { class: 'wl' }, h('span', {}, t === 'tx' ? '크기' : '굵기'), rg),
    pv);
  annoPop.hidden = false;
  paintPv();
}

// 서명·도장 창: 보관함에서 고르고, 새로 만들고, 선택한 도장을 지운다
async function openStampPop() {
  an.pop = 'stamp';
  const mod = await import('./stamps.js');
  if (an.pop !== 'stamp') return;
  const list = await mod.loadLib(libCtx());
  if (an.pop !== 'stamp') return;
  const x = h('button', { class: 'ib', 'aria-label': '닫기' });
  x.innerHTML = svg('close', 20); x.addEventListener('click', closePop);
  const row = h('div', { class: 'sgrid' });
  for (const it of list) {
    const b = h('button', { class: 'sthumb' + (an.pick && an.pick.id === it.id ? ' on' : ''), 'aria-label': it.name });
    const im = h('img', { src: it.url, alt: it.name });
    b.append(im);
    b.addEventListener('click', () => { an.pick = it; openStampPop(); toast('찍을 곳을 누르세요', 1200); });
    row.append(b);
  }
  if (!list.length) row.append(h('div', { class: 'sempty' }, '보관된 서명·도장이 없습니다. 아래에서 만들어 주세요.'));
  const mk = (label, fn) => h('button', { class: 'sbtn', onclick: () => fn() }, label);
  const done = (it) => { an.pick = it; openStampPop(); };
  annoPop.replaceChildren(
    h('div', { class: 'ph' }, h('span', {}, '서명·도장'), x),
    row,
    h('div', { class: 'srow' },
      mk('서명 그리기', () => mod.makeSignature(libCtx(), done)),
      mk('글자 도장', () => mod.makeStamp(libCtx(), done)),
      mk('사진 가져오기', () => mod.importImage(libCtx(), done))),
    an.sel ? h('div', { class: 'srow' },
      mk('선택한 도장 지우기', deleteSel),
      mk('선택 해제', () => { select(0, null); openStampPop(); })) : '');
  annoPop.hidden = false;
}
function libCtx() { return { h, toast, busy, idbGet, idbPut, clamp, FONT, svg, BASE_COLORS, openSheet, closeSheet }; }

for (const b of annoBar.querySelectorAll('[data-tool]')) {
  b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (t === an.tool && TOOL_NAME[t]) { if (an.pop === 'style') closePop(); else openStylePop(); return; }
    if (t === an.tool && t === 'st') { if (an.pop === 'stamp') closePop(); else openStampPop(); return; }
    closePop(); setTool(t);
    if (t === 'st') openStampPop();
  });
}
$('#aUndo').addEventListener('click', annoUndo);
$('#aRedo').addEventListener('click', annoRedo);
$('#aDone').addEventListener('click', () => annoMode(false));
$('#aSave').addEventListener('click', exportPdf);
$('#btnAnno').addEventListener('click', () => annoMode(!an.on));

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
    const embedded = new Map();
    for (const [pn, items] of an.data) {
      if (!items.length || pn > doc.getPageCount()) continue;
      busy(`PDF로 저장하는 중 ${pn}쪽`);
      const vp = (await pdf.getPage(pn)).getViewport({ scale: 1 });
      const W = vp.width;
      const P = (x, y) => vp.convertToPdfPoint(x * W, y * W);   // 화면 좌표 -> PDF 좌표 (회전·잘림 반영)
      const page = doc.getPage(pn - 1);
      for (const it of items) {
        if (it.t === 'img') {
          let em = embedded.get(it.k);
          if (!em) { em = await doc.embedPng(dataUrlBytes(an.imgs.get(it.k))); embedded.set(it.k, em); }
          drawImageRect(page, em, it.x, it.y, it.w, it.h, P, degrees);
          continue;
        }
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
  drawImageRect(page, img, it.x, it.y, cv.width * u, cv.height * u, P, degrees);
}

function dataUrlBytes(u) {
  const bin = atob(u.slice(u.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// 쪽 너비를 1로 둔 사각형(x, y, w, h)에 그림을 얹는다. 회전된 쪽도 맞게 놓인다.
function drawImageRect(page, img, x, y, w, h, P, degrees) {
  const tl = P(x, y), tr = P(x + w, y), bl = P(x, y + h);
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
window.__pdfv = { get zoom() { return zoom; }, get pages() { return pages; }, get live() { return live; }, setZoom, refresh, goPage, openBuffer, an, annoMode, annoSaveNow: () => saveAnno(), exportPdf, setViewMode, pageStep, toggleFit, layoutAt, get vm() { return vm; }, get blk() { return blk; }, get fit() { return fit; } };

// 서비스 워커 (오프라인 보관)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
