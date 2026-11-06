/**
 * Lapex Flash — floating launcher docked to the right edge of Salesforce
 * pages. Auto-detects the session on load (shown as a small status dot);
 * one click opens the full extension in a new tab. Shadow DOM keeps our
 * styles from colliding with Salesforce's own Lightning CSS.
 */
(function () {
  if (window.top !== window.self) return; // skip Lightning's internal iframes

  const host = document.createElement('div');
  host.id = 'lapex-flash-floating-host';
  host.style.cssText = 'all:initial;position:fixed;top:50%;right:0;z-index:2147483647;transform:translateY(-50%);';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host{all:initial}
      *{box-sizing:border-box;font-family:'Segoe UI',Arial,sans-serif}
      .bubble{position:relative;width:44px;height:44px;border-radius:50%;background:#0f172a;color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;
        box-shadow:0 2px 10px rgba(15,23,42,.35);border:2px solid #fff;transform:translateX(22px);
        transition:transform .2s ease}
      .bubble:hover{transform:translateX(14px)}
      .dot{position:absolute;top:-1px;left:-1px;width:10px;height:10px;border-radius:50%;
        background:#94a3b8;border:2px solid #fff}
      .dot.on{background:#059669;box-shadow:0 0 6px #059669}
      .dot.stale{background:#dc2626;box-shadow:none}
    </style>
    <div class="bubble" id="bubble" title="Lapex Flash — click to open">
      <span class="dot" id="dot"></span>
      <span class="arrow">‹</span>
    </div>
  `;

  const bubble = shadow.getElementById('bubble');
  const dot = shadow.getElementById('dot');

  /* Reloading or updating the extension orphans the content scripts
     already running in open tabs: their chrome.runtime is dead and every
     call throws "Extension context invalidated". An orphan can never
     reconnect, so flag it and ask for a page refresh instead of throwing
     on each click. */
  function isExtensionAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function markStale() {
    dot.classList.remove('on');
    dot.classList.add('stale');
    bubble.title = 'Lapex Flash was reloaded — refresh this page to use it again';
  }

  function send(message, onResponse) {
    if (!isExtensionAlive()) { markStale(); return; }
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) { markStale(); return; }
        if (onResponse) onResponse(resp);
      });
    } catch (_) {
      markStale();
    }
  }

  bubble.addEventListener('click', () => send({ type: 'OPEN_PANEL_TAB' }));

  send({ type: 'GET_SESSION' }, (resp) => {
    if (resp && resp.found) {
      dot.classList.add('on');
      bubble.title = `Lapex Flash — ${resp.name || resp.orgName || 'session ready'}`;
    }
  });
})();
