/**
 * Lapex Flash — Chrome Extension Content Script
 * Bridges the web application on http://localhost:3000/apex-executor.html with the extension
 */

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'LAPEX_GET_SESSION') {
    try {
      chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (resp) => {
        window.postMessage({ type: 'LAPEX_SESSION_RESPONSE', ...resp }, '*');
      });
    } catch (_) {}
  }
});

// Auto-detect and send session to web page on load
try {
  chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (resp) => {
    if (resp && resp.found) {
      window.postMessage({ type: 'LAPEX_SESSION_RESPONSE', ...resp }, '*');
    }
  });
} catch (_) {}
