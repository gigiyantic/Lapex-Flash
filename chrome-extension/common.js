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
