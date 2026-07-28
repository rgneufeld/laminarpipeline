// Shared UI helpers — modal system, DOM utilities, SVG icon constants

// ── SVG Icons ─────────────────────────────────────────────────────────────────

export const ICONS = {
  noteOutline: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5a1.5 1.5 0 0 1 2.121 2.121L5.5 13 2 14l1-3.5L11 2.5z"/></svg>`,
  noteFilled:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M11 2.5a1.5 1.5 0 0 1 2.121 2.121L5.5 13 2 14l1-3.5L11 2.5z"/></svg>`,
  na:          `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><line x1="4.5" y1="11.5" x2="11.5" y2="4.5"/></svg>`,
  chevron:     `<svg class="phase-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l4 4 4-4"/></svg>`,
  arrowRight:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`,
  arrowLeft:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12L6 8l4-4"/></svg>`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.max(34, el.scrollHeight) + 'px';
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Modal ─────────────────────────────────────────────────────────────────────

let _cb   = null;
let _mode = 'input';

export function openModal({ title, msg = '', mode = 'input', placeholder = '', confirmLabel = 'Confirm', confirmClass = 'btn-primary', callback }) {
  _cb   = callback;
  _mode = mode;
  _q('modal-title').textContent  = title;
  _q('modal-msg').textContent    = msg;
  _q('modal-msg').style.display  = msg ? 'block' : 'none';
  const inp = _q('modal-input');
  inp.style.display = mode === 'input' ? 'block' : 'none';
  inp.value = '';
  inp.placeholder = placeholder;
  _q('modal-error').style.display = 'none';
  const btn = _q('modal-confirm');
  btn.textContent = confirmLabel;
  btn.className   = 'btn ' + confirmClass;
  _q('modal-overlay').classList.add('open');
  if (mode === 'input') setTimeout(() => inp.focus(), 50); else btn.focus();
}

export function closeModal() {
  _q('modal-overlay').classList.remove('open');
  _cb = null;
}

export function modalSubmit() {
  if (!_cb) return;
  const cb = _cb;
  if (_mode === 'input') {
    const val = _q('modal-input').value.trim();
    if (!val) { showModalError('Please enter a value.'); return; }
    closeModal(); cb(val);
  } else {
    closeModal(); cb(true);
  }
}

export function showModalError(msg) {
  const el = _q('modal-error');
  el.textContent  = msg;
  el.style.display = 'block';
}

export function modalKey(e) {
  if (e.key === 'Enter')  modalSubmit();
  if (e.key === 'Escape') closeModal();
}

export function modalBgClick(e) {
  if (e.target === _q('modal-overlay')) closeModal();
}

function _q(id) { return document.getElementById(id); }
