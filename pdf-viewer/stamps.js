// 서명·도장 보관함: 서명을 그리고, 글자 도장을 만들고, 사진을 가져와 이 앱 안에 보관한다.
// 보관함은 IndexedDB 'stamps' 에 [{ id, name, url(PNG data URL), ar(높이/너비) }] 로 둔다.

export async function loadLib(ctx) {
  try { return (await ctx.idbGet('stamps')) || []; } catch { return []; }
}
async function saveLib(ctx, list) { await ctx.idbPut('stamps', list); }

export async function addToLib(ctx, item) {
  const list = await loadLib(ctx);
  list.unshift(item);
  await saveLib(ctx, list.slice(0, 40));
  return item;
}
export async function removeFromLib(ctx, id) {
  await saveLib(ctx, (await loadLib(ctx)).filter((x) => x.id !== id));
}
const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function makeCover(ctx, title) {
  const { h, svg } = ctx;
  const x = h('button', { class: 'ib', 'aria-label': '닫기' });
  x.innerHTML = svg('close', 22);
  const el = h('div', { class: 'cover' }, h('div', { class: 'ct' }, h('span', {}, title), x));
  x.addEventListener('click', () => el.remove());
  document.body.append(el);
  return el;
}
function swatches(ctx, colors, cur, onPick) {
  const wrap = ctx.h('div', { class: 'sw' });
  const paint = () => { for (const b of wrap.children) b.classList.toggle('on', b.dataset.c === cur); };
  for (const c of colors) {
    const b = ctx.h('button', { 'aria-label': c, 'data-c': c });
    b.style.background = c;
    b.addEventListener('click', () => { cur = c; paint(); onPick(c); });
    wrap.append(b);
  }
  paint();
  return wrap;
}
// 투명 캔버스에서 그려진 부분만 잘라내 PNG로 만든다 (여백 pad px)
function trimToPng(cv, pad = 6, maxW = 700) {
  const g = cv.getContext('2d'), w = cv.width, hh = cv.height;
  const d = g.getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hh - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, k = Math.min(1, maxW / cw);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
  out.getContext('2d').drawImage(cv, x0, y0, cw, ch, 0, 0, out.width, out.height);
  return { url: out.toDataURL('image/png'), ar: out.height / out.width };
}

/* 서명 그리기 */
export function makeSignature(ctx, done) {
  const { h, toast } = ctx;
  const cover = makeCover(ctx, '서명 그리기');
  const pad = h('canvas', { class: 'pad' });
  let color = '#1a1a1a';
  const sw = swatches(ctx, ['#1a1a1a', '#1c4eea', '#e03131'], color, (c) => { color = c; });
  const clear = h('button', { class: 'sec' }, '지우기');
  const save = h('button', { class: 'pri' }, '저장');
  cover.append(pad, h('div', { class: 'cr' }, sw, h('span', { style: 'flex:1' }), clear, save));
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const fit = () => {
    const r = pad.getBoundingClientRect();
    pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
  };
  requestAnimationFrame(fit);
  const g = () => pad.getContext('2d');
  let last = null, mid = null;
  const pt = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    last = pt(e); mid = last;
    const c = g(); c.fillStyle = color; c.beginPath(); c.arc(last[0], last[1], 1.7 * dpr, 0, 7); c.fill();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    const p = pt(e), m = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2], c = g();
    c.strokeStyle = color; c.lineWidth = 3.4 * dpr; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(mid[0], mid[1]); c.quadraticCurveTo(last[0], last[1], m[0], m[1]); c.stroke();
    last = p; mid = m;
  });
  const up = () => { last = null; };
  pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
  clear.addEventListener('click', () => g().clearRect(0, 0, pad.width, pad.height));
  save.addEventListener('click', async () => {
    const r = trimToPng(pad, 8 * dpr);
    if (!r) { toast('서명을 그려 주세요', 1200); return; }
    const list = await loadLib(ctx);
    const n = list.filter((x) => x.name.startsWith('서명')).length + 1;
    const it = await addToLib(ctx, { id: newId(), name: `서명 ${n}`, url: r.url, ar: r.ar });
    cover.remove(); toast('서명을 보관했습니다', 1200);
    if (done) done(it);
  });
}

/* 글자 도장 */
function renderStamp(text, shape, color) {
  const t = text.trim() || ' ', chars = [...t];
  const cv = document.createElement('canvas'), g = cv.getContext('2d');
  const font = (fs) => `800 ${fs}px "Noto Serif KR", "Noto Sans KR", system-ui, serif`;
  g.fillStyle = color; g.strokeStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (shape === 'circle') {
    const S = 440; cv.width = S; cv.height = S;
    g.fillStyle = color; g.strokeStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';   // 크기를 바꾸면 그리기 설정이 초기화됨
    const lines = chars.length <= 3 ? [t] : [chars.slice(0, Math.ceil(chars.length / 2)).join(''), chars.slice(Math.ceil(chars.length / 2)).join('')];
    const longest = Math.max(...lines.map((l) => [...l].length));
    const fs = Math.min(lines.length === 1 ? 190 : 150, 290 / Math.max(1, longest) );
    g.lineWidth = 16; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 12, 0, 7); g.stroke();
    g.lineWidth = 5; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 38, 0, 7); g.stroke();
    g.font = font(fs);
    lines.forEach((l, i) => g.fillText(l, S / 2, S / 2 + (i - (lines.length - 1) / 2) * fs * 1.08));
  } else if (shape === 'rect') {
    const fs = 150; g.font = font(fs);
    const w = Math.ceil(g.measureText(t).width) + 110, hh = fs + 90;
    cv.width = w; cv.height = hh;
    g.fillStyle = color; g.strokeStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 14; g.strokeRect(8, 8, w - 16, hh - 16);
    g.lineWidth = 4; g.strokeRect(30, 30, w - 60, hh - 60);
    g.font = font(fs); g.fillText(t, w / 2, hh / 2 + 6);
  } else {
    const fs = 150; g.font = font(fs);
    const w = Math.ceil(g.measureText(t).width) + 40;
    cv.width = w; cv.height = fs + 40;
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = font(fs); g.fillText(t, w / 2, (fs + 40) / 2 + 4);
  }
  return cv;
}
export function makeStamp(ctx, done) {
  const { h, toast } = ctx;
  const cover = makeCover(ctx, '글자 도장 만들기');
  const input = h('input', { type: 'text', placeholder: '도장에 넣을 글자 (예: 확인)', maxlength: '12' });
  input.value = '확인';
  let shape = 'circle', color = '#d62828';
  const prev = h('div', { class: 'prev' });
  const paint = () => { prev.replaceChildren(renderStamp(input.value, shape, color)); };
  const shapes = h('div', { class: 'cr' });
  for (const [k, label] of [['circle', '원형'], ['rect', '사각'], ['none', '글자만']]) {
    const b = h('button', { class: 'sec' }, label);
    b.dataset.k = k;
    b.addEventListener('click', () => { shape = k; for (const x of shapes.children) x.style.background = x.dataset.k === shape ? '#ffffff26' : ''; paint(); });
    shapes.append(b);
  }
  shapes.children[0].style.background = '#ffffff26';
  const sw = swatches(ctx, ['#d62828', '#1c4eea', '#1a1a1a'], color, (c) => { color = c; paint(); });
  const save = h('button', { class: 'pri' }, '저장');
  input.addEventListener('input', paint);
  cover.append(h('div', { class: 'cr' }, input), shapes, prev, h('div', { class: 'cr' }, sw, h('span', { style: 'flex:1' }), save));
  paint();
  save.addEventListener('click', async () => {
    if (!input.value.trim()) { toast('글자를 넣어 주세요', 1200); return; }
    const r = trimToPng(renderStamp(input.value, shape, color), 4, 500);
    const it = await addToLib(ctx, { id: newId(), name: input.value.trim(), url: r.url, ar: r.ar });
    cover.remove(); toast('도장을 보관했습니다', 1200);
    if (done) done(it);
  });
}

/* 사진에서 서명·도장 가져오기 (흰 배경을 투명하게) */
export function importImage(ctx, done) {
  const { h, toast } = ctx;
  const fi = h('input', { type: 'file', accept: 'image/*' });
  fi.addEventListener('change', async () => {
    const f = fi.files[0];
    if (!f) return;
    let bmp;
    try { bmp = await createImageBitmap(f); } catch { toast('그림을 읽지 못했습니다'); return; }
    const k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
    const src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(bmp.width * k)); src.height = Math.max(1, Math.round(bmp.height * k));
    src.getContext('2d').drawImage(bmp, 0, 0, src.width, src.height);
    const base = src.getContext('2d').getImageData(0, 0, src.width, src.height);
    const cover = makeCover(ctx, '사진에서 가져오기');
    const prev = h('div', { class: 'prev' });
    let cut = true, strength = 50;
    const result = () => {
      const out = document.createElement('canvas'); out.width = src.width; out.height = src.height;
      const img = new ImageData(new Uint8ClampedArray(base.data), src.width, src.height), d = img.data;
      if (cut) {
        const lo = 255 - strength * 1.3 - 25, hi = lo + 45;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i + 3] = lum >= hi ? 0 : lum <= lo ? 255 : Math.round(255 * (hi - lum) / (hi - lo));
        }
      }
      out.getContext('2d').putImageData(img, 0, 0);
      return out;
    };
    const paint = () => { const c = result(); c.style.background = 'repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/16px 16px'; prev.replaceChildren(c); };
    const chk = h('input', { type: 'checkbox' }); chk.checked = true;
    chk.addEventListener('change', () => { cut = chk.checked; paint(); });
    const rg = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '50', style: 'flex:1' });
    rg.addEventListener('input', () => { strength = Number(rg.value); paint(); });
    const save = h('button', { class: 'pri' }, '저장');
    cover.append(prev,
      h('div', { class: 'cr' }, h('label', {}, chk, ' 흰 배경 지우기'), rg),
      h('div', { class: 'cr' }, h('span', { style: 'flex:1' }), save));
    paint();
    save.addEventListener('click', async () => {
      const r = cut ? trimToPng(result(), 6, 700) : (() => { const c = result(); return { url: c.toDataURL('image/png'), ar: c.height / c.width }; })();
      if (!r) { toast('남은 그림이 없습니다. 지우기 강도를 낮춰 보세요', 1800); return; }
      const it = await addToLib(ctx, { id: newId(), name: f.name.replace(/\.[^.]+$/, '').slice(0, 20) || '사진', url: r.url, ar: r.ar });
      cover.remove(); toast('보관했습니다', 1200);
      if (done) done(it);
    });
  });
  fi.click();
}
