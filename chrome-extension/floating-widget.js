/**
 * Lapex Flash — floating launcher docked to the right edge of Salesforce
 * pages. Auto-detects the session on load; clicking the bubble reveals a
 * Launch button that opens the full extension in a new tab. Shadow DOM
 * keeps our styles from colliding with Salesforce's own Lightning CSS.
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
      .dock{display:flex;align-items:center;transition:transform .2s ease}
      .dock.collapsed{transform:translateX(22px)}
      .bubble{width:44px;height:44px;border-radius:50%;background:#0f172a;color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;
        box-shadow:0 2px 10px rgba(15,23,42,.35);border:2px solid #fff;flex-shrink:0}
      .bubble .arrow{display:inline-block;transition:transform .2s ease}
      .dock.collapsed .bubble .arrow{transform:rotate(180deg)}
      .panel{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e2e8f0;
        border-radius:10px 0 0 10px;padding:8px 14px 8px 14px;box-shadow:0 4px 20px rgba(15,23,42,.15);
        opacity:0;max-width:0;overflow:hidden;transition:all .2s ease;white-space:nowrap}
      .dock:not(.collapsed) .panel{opacity:1;max-width:260px;margin-right:-8px}
      .status{display:flex;align-items:center;gap:6px;font-size:12px;color:#334155;font-weight:600}
      .dot{width:6px;height:6px;border-radius:50%;background:#94a3b8;flex-shrink:0}
      .dot.on{background:#059669;box-shadow:0 0 6px #059669}
      .launch{background:#0f172a;color:#fff;border:none;border-radius:7px;padding:7px 12px;
        font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit}
      .launch:hover:not(:disabled){background:#1e293b}
      .launch:disabled{opacity:.4;cursor:not-allowed}
    </style>
    <div class="dock collapsed" id="dock">
      <div class="panel">
        <span class="status"><span class="dot" id="dot"></span><span id="status-text">Detecting…</span></span>
        <button class="launch" id="launch-btn" disabled>🚀 Launch</button>
      </div>
      <div class="bubble" id="bubble" title="Lapex Flash"><span class="arrow">‹</span></div>
    </div>
  `;

  const dock = shadow.getElementById('dock');
  const bubble = shadow.getElementById('bubble');
  const launchBtn = shadow.getElementById('launch-btn');
  const dot = shadow.getElementById('dot');
  const statusText = shadow.getElementById('status-text');

  bubble.addEventListener('click', () => dock.classList.toggle('collapsed'));

  launchBtn.addEventListener('click', () => {
    if (launchBtn.disabled) return;
    chrome.runtime.sendMessage({ type: 'OPEN_PANEL_TAB' });
    dock.classList.add('collapsed');
  });

  try {
    chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.found) {
        dot.classList.add('on');
        statusText.textContent = resp.name || resp.orgName || 'Session ready';
        launchBtn.disabled = false;
      } else {
        statusText.textContent = 'No session';
      }
    });
  } catch (_) {}
})();
