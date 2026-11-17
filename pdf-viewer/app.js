import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const LIB = new URL('./lib/', import.meta.url).href;
const VERSION = '1.0.0';

const $ = (s) => document.querySelector(s);
const scroller = $('#scroller'), pagesEl = $('#pages'), bar = $('#bar'), topbar = $('#topbar');
const pageBtn = $('#btnPage'), titleEl = $('#title'), zoomPill = $('#zoomPill');
const emptyEl = $('#empty'), busyEl = $('#busy'), toastEl = $('#toast');
const sheet = $('#sheet'), sheetBody = $('#sheetBody'), fileInput = $('#file');

const dpr = Math.min(window.devicePixelRatio || 1, 3);
const MAX_PIXELS = 8e6;          // 캔버스 한 장의 최대 화소 수 (폰 메모리 보호)
const MIN_Z = 0.5, MAX_Z = 8;
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
async function openBuffer(buf, name) {
  closeSheet();
  busy('불러오는 중...');
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
    pages.push({ n: i + 1, el, cvs: null, info: null, failW: -1, hlDiv: null, hlStamp: -1 });
  }
  pagesEl.append(frag);

  emptyEl.hidden = true; scroller.hidden = false;
  document.body.classList.remove('noDoc');
  titleEl.textContent = docName;
  fit = scroller.clientWidth; zoom = 1; applyWidth();

  const pos = store.get('pos:' + docKey, null);
  if (pos) goPage(pos.p, pos.f); else scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
  busy('');
  updateIndicator(); refresh(); saveRecent();
  return true;
}

function closeDoc() {
  if (curJob) { try { curJob.task.cancel(); } catch { /* 무시 */ } curJob = null; }
  for (const p of pages) freeCanvas(p);
  pagesEl.replaceChildren(); pages = []; live.clear();
  if (pdf) { pdf.destroy().catch(() => {}); pdf = null; }
  hl.rects.clear(); hl.stamp++; searchRun++; textCache.clear();
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
function showPill() {
  zoomPill.textContent = Math.round(zoom * 100) + '%'; zoomPill.hidden = false;
  clearTimeout(pillTimer); pillTimer = setTimeout(() => { zoomPill.hidden = true; }, 900);
}

// cx, cy: 화면 위 기준점(스크롤 영역 안 좌표). 그 점 아래의 내용이 제자리에 있도록 확대한다.
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

function animateZoom(target, cx, cy) {
  const from = zoom, t0 = performance.now(), dur = 160;
  const step = (t) => {
    const k = clamp((t - t0) / dur, 0, 1), e = 1 - Math.pow(1 - k, 3);
    setZoom(from + (target - from) * e, cx, cy);
    if (k < 1) requestAnimationFrame(step); else scheduleRefresh(0, true);
  };
  requestAnimationFrame(step);
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
  const mx = (vx1 - vx0) * 0.35, my = (vy1 - vy0) * 0.35;
  const x = Math.max(0, Math.floor(vx0 - mx)), y = Math.max(0, Math.floor(vy0 - my));
  const x1 = Math.min(W, Math.ceil(vx1 + mx)), y1 = Math.min(H, Math.ceil(vy1 + my));
  return { x, y, w: x1 - x, h: y1 - y, W, H, full: false };
}

function freeCanvas(p) {
  if (p.cvs) { p.cvs.remove(); p.cvs.width = 0; p.cvs = null; }
  p.info = null; live.delete(p);
}

function refresh() {
  if (!pdf) return;
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
      let job = null;
      for (const p of wanted()) { const r = plan(p); if (r) { job = { p, r }; break; } }
      if (!job) break;
      await renderJob(job);
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

// 안드로이드 앱이 PDF를 넘겨줄 때 (파일 관리자에서 PDF를 누른 경우)
window.openNativePdf = async function () {
  busy('파일 받는 중...');
  try {
    const res = await fetch('./__native/current.pdf?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('native ' + res.status);
    let name = '문서.pdf';
    try { name = decodeURIComponent(res.headers.get('X-File-Name') || '') || name; } catch { /* 무시 */ }
    await openBuffer(await res.arrayBuffer(), name);
  } catch (e) { busy(''); toast('파일을 받지 못했습니다'); console.error(e); }
};
if (new URLSearchParams(location.search).has('native')) window.openNativePdf();

// 데스크톱 크롬에 설치했을 때 "연결 프로그램"으로 열기
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (p) => {
    if (p.files && p.files.length) openFile(await p.files[0].getFile());
  });
}

/* ---------- 최근 문서 ---------- */
function saveRecent() {
  const list = store.get('recent', []).filter((r) => r.k !== docKey);
  list.unshift({ k: docKey, name: docName, n: pages.length, p: currentPos().p, t: Date.now() });
  store.set('recent', list.slice(0, 15));
}
function renderRecent() {
  const list = store.get('recent', []);
  const box = $('#recentBox'), ul = $('#recentList');
  ul.replaceChildren();
  box.hidden = !list.length;
  for (const r of list) {
    const li = h('li', {}, h('span', {}, r.name), h('span', {}, `${r.p}/${r.n}쪽`));
    li.addEventListener('click', () => { toast(`'${r.name}' 파일을 골라 주세요`); pickFile(); });
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
    const [a, b] = e.touches;
    tp = { mode: 'pinch', d0: dist2(a, b) || 1, z0: zoom, mx: (a.clientX + b.clientX) / 2, my: (a.clientY + b.clientY) / 2 };
    clearTimeout(tapTimer); lastTap.t = 0;
  } else if (e.touches.length === 1) {
    const t = e.touches[0];
    tp = { mode: 'tap', x: t.clientX, y: t.clientY, t: Date.now(), moved: false };
  } else tp = { mode: 'none' };
}, { passive: true });

scroller.addEventListener('touchmove', (e) => {
  if (!tp) return;
  if (tp.mode === 'pinch' && e.touches.length === 2) {
    if (e.cancelable) e.preventDefault();
    const [a, b] = e.touches;
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    const rc = scroller.getBoundingClientRect();
    setZoom(tp.z0 * dist2(a, b) / tp.d0, tp.mx - rc.left, tp.my - rc.top);
    scroller.scrollLeft += tp.mx - mx; scroller.scrollTop += tp.my - my;
    tp.mx = mx; tp.my = my;
  } else if (tp.mode === 'tap') {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - tp.x, t.clientY - tp.y) > 10) tp.moved = true;
  }
}, { passive: false });

scroller.addEventListener('touchend', (e) => {
  if (tp && tp.mode === 'tap' && !tp.moved && Date.now() - tp.t < 350 && e.touches.length === 0) handleTap(tp.x, tp.y);
  if (tp && tp.mode === 'pinch') {
    if (e.touches.length === 0) { scheduleRefresh(120, true); tp = null; }
    else { tp = { mode: 'none' }; scheduleRefresh(120, true); }
  } else if (e.touches.length === 0) tp = null;
}, { passive: true });
scroller.addEventListener('touchcancel', () => { tp = null; }, { passive: true });

function handleTap(x, y) {
  const now = Date.now();
  if (now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
    clearTimeout(tapTimer); lastTap.t = 0;
    const rc = scroller.getBoundingClientRect();
    animateZoom(zoom < 1.6 ? 2.5 : 1, x - rc.left, y - rc.top);
  } else {
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(toggleUi, 300);
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

// 시험·점검용으로 바깥에서 상태를 볼 수 있게 노출
window.__pdfv = { get zoom() { return zoom; }, get pages() { return pages; }, get live() { return live; }, setZoom, refresh, goPage, openBuffer };

// 서비스 워커 (오프라인 보관)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
