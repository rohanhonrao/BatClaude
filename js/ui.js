// ui.js — shared toast + bottom sheet, plus the history plumbing that makes
// Android's back gesture move *within* the app instead of exiting it.
//
// Every navigation step (open module, change route, open sheet) pushes one
// history entry. A back press pops exactly one and the shell decides what that
// means. Living here (rather than in shell.js) keeps app.js free of a circular
// import back to the shell.

let toastTimer;
export function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = isErr ? 'err show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2400);
}

// --- history -----------------------------------------------------------------
export function pushNav(tag = 'nav') {
  try { history.pushState({ sanctum: tag, t: Date.now() }, ''); } catch {}
}

let sheetPushed = false;

// --- bottom sheet -------------------------------------------------------------
export function openSheet(html) {
  const existing = document.getElementById('sheet-bd');
  if (existing) {
    // Replacing one sheet with another: reuse the history entry we already have.
    existing.remove();
  } else {
    pushNav('sheet');
    sheetPushed = true;
  }
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop';
  bd.id = 'sheet-bd';
  bd.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(); });
  bd.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet()));
  document.body.appendChild(bd);
  document.body.style.overflow = 'hidden';
  return bd.querySelector('.sheet');
}

// fromPop=true means a back press already consumed the history entry.
export function closeSheet(fromPop = false) {
  const bd = document.getElementById('sheet-bd');
  if (!bd) { sheetPushed = false; return; }
  if (!fromPop && sheetPushed) {
    // Let the back press do the closing so history stays in sync.
    sheetPushed = false;
    try { history.back(); return; } catch {}
  }
  sheetPushed = false;
  bd.remove();
  document.body.style.overflow = '';
}

export function isSheetOpen() { return !!document.getElementById('sheet-bd'); }
