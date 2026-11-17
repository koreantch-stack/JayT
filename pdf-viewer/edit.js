// 편집 화면: 쪽 정리, 합치기, 나누기, 사진으로 PDF, 서명·도장 보관함
// 뷰어(app.js)와 분리된 모듈이며, 처음 "편집"을 누를 때 불러온다.

let C = null;                       // app.js가 넘겨주는 도구 모음
const $ed = () => document.getElementById('editor');
let libPromise = null;
const pdfLib = () => (libPromise ||= import(C.LIB + 'pdf-lib.esm.min.js'));

export async function openEditor(ctx, screen) {
  C = ctx;
  const el = $ed();
  el.hidden = false;
  document.body.classList.add('inEditor');
  if (screen && screens[screen]) screens[screen](); else home();
}
export function closeEditor() {
  const el = $ed();
  el.hidden = true; el.replaceChildren();
  document.body.classList.remove('inEditor');
}
export function editorOpen() { return !$ed().hidden; }
export function editorBack() {            // 안드로이드 뒤로 가기: 하위 화면이면 처음으로, 처음이면 닫기
  if ($ed().hidden) return false;
  if (current !== 'home') { home(); return true; }
  closeEditor(); return true;
}

/* ---------- 공통 ---------- */
let current = 'home';
const baseName = (n) => (n || '문서').replace(/\.pdf$/i, '');
const stamp = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };

function frame(title, back, bodyEls, barEls) {
  const { h, svg } = C;
  const b = h('button', { class: 'ib', 'aria-label': '뒤로' });
  b.innerHTML = svg('back', 22);
  b.addEventListener('click', back);
  const body = h('div', { class: 'ed-body' }, ...bodyEls);
  const el = $ed();
  el.replaceChildren(h('div', { class: 'ed-top' }, b, h('span', { class: 'ed-title' }, title)), body);
  if (barEls) el.append(h('div', { class: 'ed-bar' }, ...barEls));
  return body;
}
function tbtn(icon, label, fn) {
  const { h, svg } = C;
  const b = h('button', { class: 'eb' });
  b.innerHTML = svg(icon, 22) + `<span>${label}</span>`;
  b.addEventListener('click', fn);
  return b;
}
function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const fi = C.h('input', { type: 'file', accept: accept + ',.pdfedit' });   // .pdfedit: 앱이 고른 파일을 웹에 그대로 돌려주라는 표시
    if (multiple) fi.multiple = true;
    fi.addEventListener('change', () => resolve([...fi.files]));
    fi.addEventListener('cancel', () => resolve([]));
    fi.click();
  });
}
async function readPdfFile(f) { return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }; }
async function loadPdfLib(bytes, name) {
  const { PDFDocument } = await pdfLib();
  try { return await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) {
    C.toast(/encrypt/i.test(String(e && e.message)) ? `'${name}'은(는) 암호가 걸려 있어 편집할 수 없습니다` : `'${name}'을(를) 열 수 없습니다`, 2600);
    return null;
  }
}
// 열 PDF를 고른다: 지금 뷰어에서 보고 있는 문서 또는 파일
async function choosePdf(then) {
  const { h, openSheet, closeSheet } = C;
  const cur = await C.currentDoc();
  if (!cur) { const f = (await pickFiles('application/pdf,.pdf', false))[0]; if (f) then(await readPdfFile(f)); return; }
  openSheet(() => [
    h('h3', {}, '어떤 PDF를 편집할까요?'),
    h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { closeSheet(true); then(cur); } }, `보던 문서: ${cur.name}`)),
    h('div', { class: 'row' }, h('button', { class: 'sec', onclick: async () => { closeSheet(true); const f = (await pickFiles('application/pdf,.pdf', false))[0]; if (f) then(await readPdfFile(f)); } }, '다른 파일 고르기')),
  ]);
}

/* ---------- 처음 화면 ---------- */
const screens = {};
function home() {
  current = 'home';
  const { h, svg } = C;
  const card = (icon, label, sub, fn) => {
    const b = h('button', { class: 'card' });
    b.innerHTML = svg(icon, 30) + `<b>${label}</b><small>${sub}</small>`;
    b.addEventListener('click', fn);
    return b;
  };
  frame('편집', closeEditor, [
    h('div', { class: 'cards' },
      card('grid', '쪽 정리', '삭제·회전·순서 바꾸기', () => screens.pages()),
      card('merge', '합치기', '여러 PDF를 하나로', () => screens.merge()),
      card('split', '나누기', '범위별로 따로 저장', () => screens.split()),
      card('image', '사진으로 PDF', '사진·스캔을 묶기', () => screens.photos()),
      card('stamp', '서명·도장', '보관함과 문서에 찍기', () => screens.sign())),
    h('p', { class: 'ed-note' }, '결과는 다운로드 폴더에 새 파일로 저장되고 원본은 그대로 둡니다.'),
  ]);
}
screens.home = home;

/* ---------- 쪽 정리 ---------- */
screens.pages = () => choosePdf(startPages);
async function startPages(src) {
  current = 'pages';
  const { h, toast, busy, svg } = C;
  busy('불러오는 중...');
  const L = await pdfLib();
  const srcDoc = await loadPdfLib(src.bytes, src.name);
  if (!srcDoc) { busy(''); return home(); }
  const jsDoc = await C.pdfjs.getDocument(C.pdfOpts(src.bytes.slice())).promise.catch(() => null);
  busy('');
  if (!jsDoc) { toast('미리보기를 만들 수 없는 파일입니다'); return home(); }
  const n = srcDoc.getPageCount();
  let tiles = Array.from({ length: n }, (_, i) => ({ i, rot: 0, sel: false, el: null, done: false }));
  const grid = h('div', { class: 'tiles' });
  const info = h('div', { class: 'ed-info' });
  const body = frame(baseName(src.name), home, [info, grid], [
    tbtn('select', '전체선택', () => { const all = tiles.every((t) => t.sel); tiles.forEach((t) => { t.sel = !all; }); paint(); }),
    tbtn('rotate', '회전', () => { act((t) => { t.rot = (t.rot + 90) % 360; }); }),
    tbtn('left', '앞으로', () => move(-1)),
    tbtn('right', '뒤로', () => move(1)),
    tbtn('trash', '삭제', () => {
      const k = tiles.filter((t) => t.sel).length;
      if (!k) { toast('먼저 쪽을 눌러 고르세요', 1200); return; }
      tiles = tiles.filter((t) => !t.sel); render(); toast(`${k}쪽을 뺐습니다`, 1000);
    }),
    tbtn('save', '저장', save),
  ]);
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) thumb(e.target.__t); }, { root: body, rootMargin: '300px' });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  async function thumb(t) {
    if (t.done) return;
    t.done = true;
    try {
      const pg = await jsDoc.getPage(t.i + 1), base = pg.getViewport({ scale: 1 });
      const k = (150 * dpr) / base.width, vp = pg.getViewport({ scale: k });
      const cv = t.el.querySelector('canvas');
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      await pg.render({ canvas: cv, viewport: vp }).promise;
      t.ar = base.height / base.width;
      paintTile(t);
    } catch (e) { t.done = false; }
  }
  function paintTile(t) {
    const cv = t.el.querySelector('canvas'), q = t.rot % 180 !== 0;
    t.el.classList.toggle('sel', t.sel);
    t.el.querySelector('.no').textContent = String(tiles.indexOf(t) + 1);
    const box = t.el.querySelector('.thumb');
    const ar = t.ar || 1.41;
    box.style.aspectRatio = q ? `${ar} / 1` : `1 / ${ar}`;
    cv.style.width = q ? `${(1 / ar) * 100}%` : '100%';
    cv.style.height = 'auto';
    cv.style.transform = `translate(-50%,-50%) rotate(${t.rot}deg)`;
  }
  function makeTile(t) {
    const el = h('div', { class: 'tile' }, h('div', { class: 'thumb' }, h('canvas')), h('span', { class: 'no' }), h('i', { class: 'ck' }));
    el.querySelector('.ck').innerHTML = svg('check', 14);
    el.__t = t; t.el = el;
    attachDrag(el, t);
    io.observe(el);
    return el;
  }
  function render() {
    for (const t of tiles) if (!t.el) makeTile(t);
    grid.replaceChildren(...tiles.map((t) => t.el));
    paint();
  }
  function paint() {
    tiles.forEach(paintTile);
    const s = tiles.filter((t) => t.sel).length;
    info.textContent = `${tiles.length}쪽${s ? ` · ${s}쪽 선택됨` : ' · 쪽을 눌러 고르고, 꾹 누른 채 끌면 순서가 바뀝니다'}`;
  }
  function act(fn) {
    const sel = tiles.filter((t) => t.sel);
    if (!sel.length) { toast('먼저 쪽을 눌러 고르세요', 1200); return; }
    sel.forEach(fn); paint();
  }
  function move(d) {
    if (!tiles.some((t) => t.sel)) { toast('먼저 쪽을 눌러 고르세요', 1200); return; }
    const a = tiles.slice();
    if (d < 0) { for (let i = 1; i < a.length; i++) if (a[i].sel && !a[i - 1].sel) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
    else { for (let i = a.length - 2; i >= 0; i--) if (a[i].sel && !a[i + 1].sel) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
    tiles = a; render();
  }
  // 길게 눌러 끌어서 순서 바꾸기, 짧게 누르면 선택
  function attachDrag(el, t) {
    let timer = 0, drag = null, sx = 0, sy = 0, moved = false, pid = 0;
    const over = (x, y) => { const e = document.elementsFromPoint(x, y).find((q) => q.classList && q.classList.contains('tile') && q !== el); return e; };
    el.addEventListener('pointerdown', (e) => {
      sx = e.clientX; sy = e.clientY; moved = false; pid = e.pointerId;
      timer = setTimeout(() => { timer = 0; drag = true; el.classList.add('drag'); try { el.setPointerCapture(pid); } catch (x) { /* 무시 */ } navigator.vibrate && navigator.vibrate(15); }, 380);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { moved = true; clearTimeout(timer); timer = 0; } return; }
      e.preventDefault();
      el.style.transform = `translate(${e.clientX - sx}px, ${e.clientY - sy}px)`;
      const o = over(e.clientX, e.clientY);
      if (o && o.__t) {
        const from = tiles.indexOf(t), to = tiles.indexOf(o.__t);
        if (from !== to) {
          tiles.splice(from, 1); tiles.splice(to, 0, t);
          grid.replaceChildren(...tiles.map((q) => q.el));
          sx = e.clientX; sy = e.clientY; el.style.transform = 'translate(0px, 0px)';
          tiles.forEach(paintTile);
        }
      }
    });
    const end = (e) => {
      clearTimeout(timer);
      if (drag) { drag = null; el.classList.remove('drag'); el.style.transform = ''; paint(); }
      else if (!moved && e.type === 'pointerup') { t.sel = !t.sel; paint(); }
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  async function build(list) {
    const { PDFDocument, degrees } = L;
    const out = await PDFDocument.create();
    const copied = await out.copyPages(srcDoc, list.map((t) => t.i));
    copied.forEach((p, k) => {
      const r = ((p.getRotation().angle + list[k].rot) % 360 + 360) % 360;
      p.setRotation(degrees(r)); out.addPage(p);
    });
    return out.save();
  }
  function save() {
    if (!tiles.length) { toast('남은 쪽이 없습니다'); return; }
    const sel = tiles.filter((t) => t.sel);
    const run = async (list, tag) => {
      busy('저장하는 중...');
      try { await C.deliverPdf(await build(list), `${baseName(src.name)}_${tag}.pdf`); }
      catch (e) { console.error(e); toast('저장하지 못했습니다'); }
      finally { busy(''); }
    };
    if (!sel.length) { run(tiles, '편집'); return; }
    C.openSheet(() => [
      h('h3', {}, '저장'),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => { C.closeSheet(true); run(tiles, '편집'); } }, `전체 ${tiles.length}쪽 저장`)),
      h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => { C.closeSheet(true); run(sel, '발췌'); } }, `고른 ${sel.length}쪽만 저장`)),
    ]);
  }
  render();
}

/* ---------- 합치기 ---------- */
screens.merge = async () => {
  current = 'merge';
  const { h, toast, busy, svg } = C;
  let items = [];                 // { name, bytes, n }
  const list = h('div', { class: 'mlist' });
  const nameIn = h('input', { type: 'text', placeholder: '저장 이름' });
  const sum = h('div', { class: 'ed-info' });
  const row = (it, i) => {
    const mk = (ic, fn, dis) => { const b = h('button', { class: 'ib', 'aria-label': ic }); b.innerHTML = svg(ic, 20); b.disabled = !!dis; b.addEventListener('click', fn); return b; };
    return h('div', { class: 'mrow' },
      h('span', { class: 'mn' }, String(i + 1)),
      h('span', { class: 'mname' }, it.name, h('small', {}, ` ${it.n}쪽`)),
      mk('up', () => { items.splice(i - 1, 0, items.splice(i, 1)[0]); draw(); }, i === 0),
      mk('down', () => { items.splice(i + 1, 0, items.splice(i, 1)[0]); draw(); }, i === items.length - 1),
      mk('close', () => { items.splice(i, 1); draw(); }));
  };
  function draw() {
    list.replaceChildren(...items.map(row));
    const t = items.reduce((a, x) => a + x.n, 0);
    sum.textContent = items.length ? `${items.length}개 파일 · 모두 ${t}쪽` : '합칠 PDF를 추가해 주세요';
    if (!nameIn.value || nameIn.dataset.auto === '1') { nameIn.value = items.length ? `${baseName(items[0].name)}_합본` : ''; nameIn.dataset.auto = '1'; }
  }
  nameIn.addEventListener('input', () => { nameIn.dataset.auto = '0'; });
  async function add(files) {
    busy('읽는 중...');
    for (const f of files) {
      const it = await readPdfFile(f), d = await loadPdfLib(it.bytes, it.name);
      if (d) { it.n = d.getPageCount(); items.push(it); }
    }
    busy(''); draw();
  }
  const addCur = async () => { const c = await C.currentDoc(); if (!c) { toast('열려 있는 문서가 없습니다', 1200); return; } const d = await loadPdfLib(c.bytes, c.name); if (d) { c.n = d.getPageCount(); items.push(c); draw(); } };
  frame('합치기', home, [
    h('div', { class: 'row' },
      h('button', { class: 'sec', onclick: async () => add(await pickFiles('application/pdf,.pdf', true)) }, 'PDF 추가'),
      h('button', { class: 'sec', onclick: addCur }, '보던 문서 추가')),
    sum, list,
    h('div', { class: 'row' }, nameIn, h('span', { class: 'ed-ext' }, '.pdf')),
    h('div', { class: 'row' }, h('button', { class: 'pri', style: 'flex:1', onclick: async () => {
      if (items.length < 2) { toast('두 개 이상 추가해 주세요', 1400); return; }
      busy('합치는 중...');
      try {
        const { PDFDocument } = await pdfLib();
        const out = await PDFDocument.create();
        for (const it of items) {
          const d = await PDFDocument.load(it.bytes, { updateMetadata: false });
          (await out.copyPages(d, d.getPageIndices())).forEach((p) => out.addPage(p));
        }
        await C.deliverPdf(await out.save(), (nameIn.value.trim() || `합본_${stamp()}`).replace(/\.pdf$/i, '') + '.pdf');
      } catch (e) { console.error(e); toast('합치지 못했습니다'); }
      finally { busy(''); }
    } }, '합쳐서 저장')),
  ]);
  draw();
};

/* ---------- 나누기 ---------- */
screens.split = () => choosePdf(startSplit);
async function startSplit(src) {
  current = 'split';
  const { h, toast, busy } = C;
  busy('불러오는 중...');
  const d = await loadPdfLib(src.bytes, src.name);
  busy('');
  if (!d) return home();
  const n = d.getPageCount();
  let mode = 'range';
  const inp = h('input', { type: 'text', placeholder: '예: 1-3, 5, 8-', inputmode: 'text' });
  const numIn = h('input', { type: 'number', min: '1', max: String(n), value: '1', style: 'width:90px;flex:none' });
  const out = h('div', { class: 'ed-info' });
  const modes = h('div', { class: 'seg' });
  const groups = () => {
    const g = [];
    if (mode === 'each') for (let i = 1; i <= n; i++) g.push([i, i]);
    else if (mode === 'count') { const k = Math.max(1, Math.min(n, Number(numIn.value) || 1)); for (let i = 1; i <= n; i += k) g.push([i, Math.min(n, i + k - 1)]); }
    else {
      for (const tok of inp.value.split(/[,\s]+/).filter(Boolean)) {
        const m = tok.match(/^(\d*)-(\d*)$/) || tok.match(/^(\d+)$/);
        if (!m) return null;
        let a = m[2] === undefined ? Number(m[1]) : (m[1] === '' ? 1 : Number(m[1]));
        let b = m[2] === undefined ? a : (m[2] === '' ? n : Number(m[2]));
        if (a < 1 || b > n || a > b) return null;
        g.push([a, b]);
      }
    }
    return g;
  };
  const upd = () => {
    const g = groups();
    out.textContent = !g ? `범위를 확인해 주세요 (1~${n}쪽 안에서)` : g.length ? `${g.length}개 파일로 나뉩니다: ${g.slice(0, 6).map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')}${g.length > 6 ? ' …' : ''}` : '나눌 범위를 적어 주세요';
  };
  const setMode = (m) => { mode = m; for (const b of modes.children) b.classList.toggle('on', b.dataset.m === m); inp.parentElement.hidden = m !== 'range'; numIn.parentElement.hidden = m !== 'count'; upd(); };
  for (const [m, t] of [['range', '범위로'], ['count', 'N쪽씩'], ['each', '쪽마다']]) { const b = h('button', { 'data-m': m }, t); b.addEventListener('click', () => setMode(m)); modes.append(b); }
  inp.addEventListener('input', upd); numIn.addEventListener('input', upd);
  frame(`나누기 · ${baseName(src.name)} (${n}쪽)`, home, [
    modes,
    h('div', { class: 'row' }, inp),
    h('div', { class: 'row' }, numIn, h('span', { class: 'ed-ext' }, '쪽씩 한 파일')),
    out,
    h('div', { class: 'row' }, h('button', { class: 'pri', style: 'flex:1', onclick: async () => {
      const g = groups();
      if (!g || !g.length) { toast('범위를 확인해 주세요', 1400); return; }
      if (g.length > 60) { toast('한 번에 60개까지만 나눌 수 있습니다'); return; }
      busy('나누는 중...');
      try {
        const { PDFDocument } = await pdfLib();
        let k = 0;
        for (const [a, b] of g) {
          busy(`나누는 중 ${++k}/${g.length}`);
          const o = await PDFDocument.create();
          (await o.copyPages(d, Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i))).forEach((p) => o.addPage(p));
          await C.deliverPdf(await o.save(), `${baseName(src.name)}_${a === b ? a : `${a}-${b}`}.pdf`, true);
        }
        toast(`${g.length}개 파일을 저장했습니다`, 2200);
      } catch (e) { console.error(e); toast('나누지 못했습니다'); }
      finally { busy(''); }
    } }, '나눠서 저장')),
  ]);
  setMode('range');
}

/* ---------- 사진으로 PDF ---------- */
screens.photos = () => {
  current = 'photos';
  const { h, toast, busy, svg } = C;
  let items = [];                 // { file, url, rot }
  let size = 'a4', enh = false;
  const grid = h('div', { class: 'tiles' });
  const info = h('div', { class: 'ed-info' });
  const nameIn = h('input', { type: 'text', placeholder: '저장 이름', value: `사진_${stamp()}` });
  function draw() {
    grid.replaceChildren(...items.map((it, i) => {
      const mk = (ic, fn, dis) => { const b = h('button', { class: 'ib sm', 'aria-label': ic }); b.innerHTML = svg(ic, 16); b.disabled = !!dis; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
      const im = h('img', { src: it.url }); im.style.transform = `rotate(${it.rot}deg)`;
      return h('div', { class: 'tile ph' }, h('div', { class: 'thumb sq' }, im), h('span', { class: 'no' }, String(i + 1)),
        h('div', { class: 'tact' }, mk('left', () => { items.splice(i - 1, 0, items.splice(i, 1)[0]); draw(); }, i === 0), mk('rotate', () => { it.rot = (it.rot + 90) % 360; draw(); }),
          mk('right', () => { items.splice(i + 1, 0, items.splice(i, 1)[0]); draw(); }, i === items.length - 1), mk('close', () => { URL.revokeObjectURL(it.url); items.splice(i, 1); draw(); })));
    }));
    info.textContent = items.length ? `${items.length}장` : '사진을 추가해 주세요';
  }
  const add = (files) => { for (const f of files) items.push({ file: f, url: URL.createObjectURL(f), rot: 0 }); draw(); };
  const opt = (label, key, vals, cur, on) => {
    const seg = h('div', { class: 'seg' });
    for (const [v, t] of vals) { const b = h('button', { 'data-m': v, class: v === cur ? 'on' : '' }, t); b.addEventListener('click', () => { for (const x of seg.children) x.classList.toggle('on', x === b); on(v); }); seg.append(b); }
    return h('div', { class: 'optrow' }, h('span', {}, label), seg);
  };
  async function enhance(cv) {
    const g = cv.getContext('2d'), im = g.getImageData(0, 0, cv.width, cv.height), d = im.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = d[i + 1] = d[i + 2] = l; hist[l]++; }
    const tot = cv.width * cv.height; let a = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { a += hist[v]; if (a > tot * 0.02) { lo = v; break; } }
    a = 0; for (let v = 255; v >= 0; v--) { a += hist[v]; if (a > tot * 0.25) { hi = v; break; } }
    const span = Math.max(40, hi - lo);
    for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i] - lo) / span) * 255)); d[i] = d[i + 1] = d[i + 2] = v; }
    g.putImageData(im, 0, 0);
  }
  frame('사진으로 PDF', home, [
    h('div', { class: 'row' },
      h('button', { class: 'sec', onclick: async () => add(await pickFiles('image/*', true)) }, '사진 고르기'),
      h('button', { class: 'sec', onclick: async () => { const fi = h('input', { type: 'file', accept: 'image/*,.pdfedit', capture: 'environment' }); fi.addEventListener('change', () => add([...fi.files])); fi.click(); } }, '카메라로 찍기')),
    info, grid,
    opt('쪽 크기', 'size', [['a4', 'A4에 맞춤'], ['orig', '사진 비율대로']], size, (v) => { size = v; }),
    opt('보정', 'enh', [['0', '그대로'], ['1', '문서처럼 (흑백·선명)']], '0', (v) => { enh = v === '1'; }),
    h('div', { class: 'row' }, nameIn, h('span', { class: 'ed-ext' }, '.pdf')),
    h('div', { class: 'row' }, h('button', { class: 'pri', style: 'flex:1', onclick: async () => {
      if (!items.length) { toast('사진을 추가해 주세요', 1400); return; }
      busy('PDF 만드는 중...');
      try {
        const { PDFDocument } = await pdfLib();
        const out = await PDFDocument.create();
        let k = 0;
        for (const it of items) {
          busy(`PDF 만드는 중 ${++k}/${items.length}`);
          const bmp = await createImageBitmap(it.file, { imageOrientation: 'from-image' });
          const q = it.rot % 180 !== 0, sc = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
          const w = Math.max(1, Math.round(bmp.width * sc)), hh = Math.max(1, Math.round(bmp.height * sc));
          const cv = document.createElement('canvas'); cv.width = q ? hh : w; cv.height = q ? w : hh;
          const g = cv.getContext('2d'); g.translate(cv.width / 2, cv.height / 2); g.rotate(it.rot * Math.PI / 180); g.drawImage(bmp, -w / 2, -hh / 2, w, hh);
          if (enh) await enhance(cv);
          const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.86));
          const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
          let pw, ph, x, y, iw, ih;
          if (size === 'a4') {
            const land = cv.width > cv.height; pw = land ? 841.89 : 595.28; ph = land ? 595.28 : 841.89;
            const m = 18, s = Math.min((pw - 2 * m) / cv.width, (ph - 2 * m) / cv.height);
            iw = cv.width * s; ih = cv.height * s; x = (pw - iw) / 2; y = (ph - ih) / 2;
          } else { pw = 595.28; ph = pw * cv.height / cv.width; iw = pw; ih = ph; x = 0; y = 0; }
          out.addPage([pw, ph]).drawImage(img, { x, y, width: iw, height: ih });
        }
        await C.deliverPdf(await out.save(), (nameIn.value.trim() || `사진_${stamp()}`).replace(/\.pdf$/i, '') + '.pdf');
      } catch (e) { console.error(e); toast('PDF를 만들지 못했습니다'); }
      finally { busy(''); }
    } }, 'PDF로 저장')),
  ]);
  draw();
};

/* ---------- 서명·도장 ---------- */
screens.sign = async () => {
  current = 'sign';
  const { h, toast, svg } = C;
  const mod = await import('./stamps.js');
  const lc = C.libCtx();
  const grid = h('div', { class: 'sgrid2' });
  async function draw() {
    const list = await mod.loadLib(lc);
    grid.replaceChildren(...(list.length ? list.map((it) => {
      const del = h('button', { class: 'ib sm', 'aria-label': '지우기' }); del.innerHTML = svg('trash', 16);
      del.addEventListener('click', async () => { await mod.removeFromLib(lc, it.id); draw(); });
      return h('div', { class: 'sitem' }, h('div', { class: 'sbox' }, h('img', { src: it.url })), h('span', {}, it.name), del);
    }) : [h('p', { class: 'ed-note' }, '보관된 서명·도장이 없습니다. 아래에서 만들어 주세요.')]));
  }
  frame('서명·도장', home, [
    h('div', { class: 'row' },
      h('button', { class: 'sec', onclick: () => mod.makeSignature(lc, draw) }, '서명 그리기'),
      h('button', { class: 'sec', onclick: () => mod.makeStamp(lc, draw) }, '글자 도장'),
      h('button', { class: 'sec', onclick: () => mod.importImage(lc, draw) }, '사진 가져오기')),
    grid,
    h('div', { class: 'row' }, h('button', { class: 'pri', style: 'flex:1', onclick: () => choosePdf(async (src) => { closeEditor(); await C.openInViewer(src.bytes, src.name, { stamp: true }); }) }, '문서에 찍으러 가기')),
    h('p', { class: 'ed-note' }, '찍은 뒤에는 필기 화면의 저장 버튼으로 PDF에 합쳐 저장합니다. 도장은 눌러서 옮기고, 오른쪽 아래 파란 점을 끌어 크기를 바꿉니다.'),
  ]);
  draw();
};
