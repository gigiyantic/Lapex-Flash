/**
 * Lapex Flash — Toolbar popup, Salesforce-Inspector-style menu list.
 * Auto-detects the session on open, then each row launches panel.html
 * in a full tab already switched to that mode (or drawer) via ?mode=/&open=
 * query params — the popup itself never runs the workspace UI.
 */
function showBlock(id) {
  ['state-detecting', 'menu-list', 'state-notfound'].forEach(s => {
    document.getElementById(s).style.display = s === id ? 'flex' : 'none';
  });
}

function launch(params) {
  const qs = new URLSearchParams(params).toString();
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html' + (qs ? '?' + qs : '')) });
  window.close();
}

async function detect() {
  showBlock('state-detecting');
  document.getElementById('nc-err').style.display = 'none';
  document.getElementById('org-chip').style.display = 'none';

  let session;
  try {
    session = await chrome.runtime.sendMessage({ type: 'GET_SESSION' });
  } catch (err) {
    session = { found: false, error: err.message };
  }

  if (session && session.found) {
    document.getElementById('org-name').textContent = session.name || session.orgName || 'Connected';
    document.getElementById('org-chip').style.display = 'flex';
    showBlock('menu-list');
  } else {
    const errEl = document.getElementById('nc-err');
    if (session && session.error) {
      errEl.textContent = session.error;
      errEl.style.display = 'block';
    }
    showBlock('state-notfound');
  }
}

document.querySelectorAll('.menu-item[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => launch({ mode: btn.dataset.mode }));
});
document.querySelectorAll('.menu-item[data-open]').forEach(btn => {
  btn.addEventListener('click', () => launch({ open: btn.dataset.open }));
});
document.getElementById('btn-retry').addEventListener('click', detect);

detect();
