// 앱 전체에서 쓰는 아이콘 (24x24, 선 그림). 색은 글자색을 따라간다.
const P = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
  'view-scroll': '<rect x="6" y="2.5" width="12" height="8" rx="1.2"/><rect x="6" y="13.5" width="12" height="8" rx="1.2"/>',
  'view-single': '<rect x="6" y="3" width="12" height="18" rx="1.6"/>',
  'view-double': '<rect x="2.5" y="4.5" width="9" height="15" rx="1.2"/><rect x="12.5" y="4.5" width="9" height="15" rx="1.2"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  pencil: '<path d="M4 20l1.2-4.2L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z"/><path d="M14.5 6.5l3 3"/>',
  more: '<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',
  hand: '<path d="M8 13V6.5a1.5 1.5 0 013 0V11V4.5a1.5 1.5 0 013 0V11V6.5a1.5 1.5 0 013 0V15c0 3.6-2.4 6-6 6-2.7 0-4.2-1.2-5.6-3.4L4.4 14a1.5 1.5 0 012.5-1.6z"/>',
  pen: '<path d="M12 21l-5.5-7 2.8-9h5.4l2.8 9z"/><circle cx="12" cy="11" r="1.5"/><path d="M12 12.5V21"/>',
  marker: '<path d="M14.5 3.5l6 6-7.5 7.5-6-6z"/><path d="M7 11l-3 5.5 4.5 1 2.2-2.2"/><path d="M4 21h9"/>',
  text: '<path d="M5 7V4.5h14V7M12 4.5v15M9 19.5h6"/>',
  eraser: '<path d="M9 20h10.5"/><path d="M5.2 13.6l7.3-8.1a1.8 1.8 0 012.6-.1l3.4 3.4a1.8 1.8 0 010 2.6L13.2 19.4H8.8z"/><path d="M9.6 9.7l5 5"/>',
  stamp: '<circle cx="12" cy="6.5" r="3"/><path d="M12 9.5v4"/><path d="M5 13.5h14v3.5H5z"/><path d="M4 21h16"/>',
  undo: '<path d="M8 5L3 10l5 5"/><path d="M3 10h10.5a5.5 5.5 0 010 11H10"/>',
  redo: '<path d="M16 5l5 5-5 5"/><path d="M21 10H10.5a5.5 5.5 0 000 11H14"/>',
  save: '<path d="M12 3v12M7 10.5l5 5 5-5"/><path d="M4 20h16"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  rotate: '<path d="M20 12a8 8 0 11-2.6-5.9"/><path d="M20 4v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  merge: '<path d="M6 4v5c0 3 2 4.5 6 4.5s6-1.5 6-4.5V4"/><path d="M12 13.5V21M9 18l3 3 3-3"/>',
  split: '<path d="M12 3v7M12 10c0 3.5-6 3-6 7.5V21M12 10c0 3.5 6 3 6 7.5V21"/>',
  open: '<path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12.5l3 3 5-6"/>',
  camera: '<path d="M4 8a2 2 0 012-2h2l1.5-2h5L16 6h2a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
};

export function svg(name, size = 22) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// data-ic="이름" 이 붙은 버튼에 아이콘을 채운다
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-ic]')) {
    el.insertAdjacentHTML('afterbegin', svg(el.dataset.ic, Number(el.dataset.sz) || 22));
    el.removeAttribute('data-ic');
  }
}
