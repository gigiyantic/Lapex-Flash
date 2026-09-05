/**
 * Lapex Flash — Run history (chrome.storage.local).
 * Stores metadata + code + a short preview only, NOT full debug logs or
 * record sets — chrome.storage.local has a 10MB quota. Full-fidelity
 * output for a specific run stays available via the manual "⬇ .txt"
 * button right after that run completes.
 */
const HISTORY_KEY = 'lf_history';
const HISTORY_MAX_ENTRIES = 100;
const HISTORY_MAX_BYTES = 8_000_000;

async function pushHistoryEntry(partial) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    ...partial,
  };

  const stored = await chrome.storage.local.get(HISTORY_KEY);
  let list = stored[HISTORY_KEY] || [];
  list.unshift(entry);
  if (list.length > HISTORY_MAX_ENTRIES) list = list.slice(0, HISTORY_MAX_ENTRIES);

  await chrome.storage.local.set({ [HISTORY_KEY]: list });

  let bytes = await chrome.storage.local.getBytesInUse(HISTORY_KEY);
  while (bytes > HISTORY_MAX_BYTES && list.length > 1) {
    list.pop();
    await chrome.storage.local.set({ [HISTORY_KEY]: list });
    bytes = await chrome.storage.local.getBytesInUse(HISTORY_KEY);
  }
}

async function getHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return stored[HISTORY_KEY] || [];
}

function openHistoryDrawer() {
  document.getElementById('drawer-history').classList.add('open');
  renderHistoryDrawer();
}
function closeHistoryDrawer() {
  document.getElementById('drawer-history').classList.remove('open');
}

async function renderHistoryDrawer() {
  const body = document.getElementById('history-body');
  const list = await getHistory();

  if (list.length === 0) {
    body.innerHTML = '<div class="drawer-empty">No runs yet.</div>';
    return;
  }

  body.innerHTML = list.map(e => `
    <div class="drawer-row" data-id="${esc(e.id)}">
      <div class="drawer-row-main">
        <div class="drawer-row-title">${esc(e.tabName || e.kind)}</div>
        <div class="drawer-row-sub">${new Date(e.timestamp).toLocaleString()} · ${e.kind === 'soql' ? 'SOQL' : e.kind === 'fieldperm' ? 'Field Perms' : 'Apex'}${e.elapsedMs ? ' · ' + (e.elapsedMs / 1000).toFixed(2) + 's' : ''}</div>
      </div>
      <span class="tag ${e.success ? 'tag-ok' : 'tag-err'}">${e.success ? 'OK' : 'FAIL'}</span>
      <button class="btn btn-danger btn-xs history-delete" data-id="${esc(e.id)}">✕</button>
    </div>
  `).join('');

  body.querySelectorAll('.drawer-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('history-delete')) return;
      reopenHistoryEntry(row.dataset.id, list);
    });
  });
  body.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryEntry(btn.dataset.id);
    });
  });
}

function reopenHistoryEntry(id, list) {
  const entry = list.find(e => e.id === id);
  if (!entry) return;

  const tabId = createTab(entry.tabName || 'Reopened');
  tabs[tabId].mode = entry.kind === 'soql' ? 'soql' : entry.kind === 'fieldperm' ? 'fieldperm' : 'apex';
  tabs[tabId].code = entry.kind === 'fieldperm' ? '' : entry.code;
  renderTabs();
  switchTab(tabId);
  setMode(tabs[tabId].mode);

  if (entry.kind === 'fieldperm' && entry.meta) {
    document.getElementById('fp-sobject').value = entry.meta.sobject || '';
    document.getElementById('fp-field').value = entry.meta.field || '';
  }

  closeHistoryDrawer();
}

async function deleteHistoryEntry(id) {
  let list = await getHistory();
  list = list.filter(e => e.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
  renderHistoryDrawer();
}

async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  renderHistoryDrawer();
}
