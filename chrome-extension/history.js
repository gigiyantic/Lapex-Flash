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

const KIND_TAG = { soql: ['SOQL', 'tag-soql'], fieldperm: ['PERM', 'tag-fieldperm'], apex: ['APEX', 'tag-apex'] };

function historyTimeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function renderHistoryDrawer() {
  const body = document.getElementById('history-body');
  const searchEl = document.getElementById('history-search');
  const q = (searchEl.value || '').trim().toLowerCase();
  const fullList = await getHistory();
  const list = q
    ? fullList.filter(e => (e.tabName || '').toLowerCase().includes(q) || (e.code || '').toLowerCase().includes(q))
    : fullList;

  if (list.length === 0) {
    body.innerHTML = `<div class="drawer-empty">${q ? 'No matching runs.' : 'No history yet.'}</div>`;
    return;
  }

  body.innerHTML = list.map(e => {
    const [label, cls] = KIND_TAG[e.kind] || KIND_TAG.apex;
    const preview = (e.code || '').split('\n')[0].slice(0, 60);
    return `
    <div class="drawer-row" data-id="${esc(e.id)}">
      <div class="drawer-row-main">
        <div class="si-top">
          <span class="si-tag ${cls}">${label}</span>
          <span class="si-ts">${historyTimeLabel(e.timestamp)}</span>
        </div>
        <div class="drawer-row-title">${esc(e.tabName || label)}: ${esc(preview)}</div>
      </div>
      <span class="tag ${e.success ? 'tag-ok' : 'tag-err'}">${e.success ? 'OK' : 'FAIL'}</span>
      <button class="btn btn-danger btn-xs history-delete" data-id="${esc(e.id)}">✕</button>
    </div>
  `;
  }).join('');

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
