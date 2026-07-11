// ui.js — shared toast + bottom-sheet used by the shell and modules.
let toastTimer;
export function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = isErr ? 'err show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2400);
}

export function openSheet(html) {
  closeSheet();
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop';
  bd.id = 'sheet-bd';
  bd.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(); });
  bd.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.body.appendChild(bd);
  document.body.style.overflow = 'hidden';
  return bd.querySelector('.sheet');
}
export function closeSheet() {
  const bd = document.getElementById('sheet-bd');
  if (bd) bd.remove();
  document.body.style.overflow = '';
}
