/**
 * Lapex Flash — Shared panel-side helpers (loaded first; every other
 * panel script depends on these globals).
 */
let SF = { sessionId: null, instanceUrl: null, name: null, orgId: null };

function msg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      resolve(resp || { error: 'No response from extension background.' });
    });
  });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lc(s) {
  if (/FATAL|EXCEPTION/i.test(s)) return 'c-error';
  if (/ERROR/i.test(s)) return 'c-error';
  if (/WARN/i.test(s)) return 'c-warn';
  if (/INFO/i.test(s)) return 'c-info';
  if (/FINEST|FINER/i.test(s)) return 'c-fine';
  if (/FINE|DEBUG/i.test(s)) return 'c-debug';
  return 'c-def';
}

/** Triggers a browser download of in-memory text via a blob URL. */
function dl(text, fname, mime = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

/**
 * Themed replacements for window.alert()/prompt() — those always render as
 * a plain white OS dialog Chrome will not let extensions restyle.
 */
function openModal({ message, showInput, defaultValue, showCancel, onOk, onCancel }) {
  const overlay = document.getElementById('modal-overlay');
  const msgEl = document.getElementById('modal-msg');
  const inputEl = document.getElementById('modal-input');
  const cancelBtn = document.getElementById('modal-cancel');
  const okBtn = document.getElementById('modal-ok');

  msgEl.textContent = message;
  inputEl.style.display = showInput ? 'block' : 'none';
  inputEl.value = defaultValue || '';
  cancelBtn.style.display = showCancel ? 'inline-flex' : 'none';
  overlay.style.display = 'flex';
  if (showInput) { inputEl.focus(); inputEl.select(); }

  function cleanup() {
    overlay.style.display = 'none';
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
    inputEl.removeEventListener('keydown', handleKeydown);
    overlay.removeEventListener('mousedown', handleOverlayClick);
  }
  function handleOk() { cleanup(); onOk(showInput ? inputEl.value : true); }
  function handleCancel() { cleanup(); if (onCancel) onCancel(); }
  function handleKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); handleOk(); }
    if (e.key === 'Escape') { e.preventDefault(); handleCancel(); }
  }
  function handleOverlayClick(e) { if (e.target === overlay) handleCancel(); }

  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
  inputEl.addEventListener('keydown', handleKeydown);
  overlay.addEventListener('mousedown', handleOverlayClick);
}

function showAlert(message) {
  return new Promise((resolve) => {
    openModal({ message, showInput: false, showCancel: false, onOk: () => resolve(true), onCancel: () => resolve(true) });
  });
}

function showPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    openModal({ message, showInput: true, defaultValue, showCancel: true, onOk: (val) => resolve(val), onCancel: () => resolve(null) });
  });
}
