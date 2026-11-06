/**
 * Lapex Flash — SOQL Query Runner: mode toggle, execution, results table, exports.
 */

function getCurrentMode() {
  return currentMode;
}

function getActiveOutput() {
  const t = getActiveTab();
  return t && t.output ? t.output : null;
}

const MODE_BUTTONS = {
  apex: 'mode-apex', soql: 'mode-soql', perms: 'mode-perms',
  gsearch: 'mode-gsearch', fieldperm: 'mode-fieldperm',
};

/** Modes that are announced but not built yet — they render the shared
    "coming soon" card instead of a workspace. */
const PARKED_MODES = {
  gsearch: {
    icon: '🌐', title: 'Global Search',
    sub: 'Search anything in your org — objects, fields, classes, flows and more. Takes a few hours to sync the first time, then it is instant.',
  },
  fieldperm: {
    icon: '🔐', title: 'Field Permissions',
    sub: 'Check which profiles and permission sets can read or edit a field. Not available yet — Smart Permissions covers user-level access in the meantime.',
  },
};

/** Switches the whole workspace — the editor modes (Apex/SOQL) each own
    their own tab strip, while Smart Permissions and the parked features
    replace the editor/output panes with their own screen. */
function setMode(mode) {
  saveActiveTabState();
  currentMode = mode;

  Object.entries(MODE_BUTTONS).forEach(([m, id]) => {
    document.getElementById(id).classList.toggle('active', m === mode);
  });

  const parked = PARKED_MODES[mode];
  const isEditorMode = !parked && mode !== 'perms';
  document.getElementById('screen-perms').style.display        = mode === 'perms' ? 'flex' : 'none';
  document.getElementById('screen-coming-soon').style.display  = parked ? 'flex' : 'none';
  document.getElementById('tab-bar').style.display             = isEditorMode ? 'flex' : 'none';
  document.querySelector('.editor-section').style.display      = isEditorMode ? 'block' : 'none';
  document.querySelector('.out-section').style.display         = isEditorMode ? 'flex' : 'none';

  if (parked) {
    document.getElementById('cs-ico').textContent   = parked.icon;
    document.getElementById('cs-title').textContent = parked.title;
    document.getElementById('cs-sub').textContent   = parked.sub;
    return;
  }
  if (mode === 'perms') { document.getElementById('perm-input').focus(); return; }

  document.getElementById('cfg-apex').style.display       = mode === 'apex' ? 'flex' : 'none';
  document.getElementById('cfg-apex-level').style.display = mode === 'apex' ? 'flex' : 'none';
  document.getElementById('cfg-soql').style.display        = mode === 'soql' ? 'flex' : 'none';
  document.getElementById('btn-bulk-export').style.display     = mode === 'soql' ? 'inline-flex' : 'none';
  document.getElementById('btn-parallel-export').style.display = mode === 'soql' ? 'inline-flex' : 'none';
  document.getElementById('btn-exec').textContent = mode === 'apex' ? '▶ Execute' : '▶ Run Query';
  setEditorMode(mode);

  const ws = getWS();
  if (!Object.keys(ws.tabs).length) ws.activeTabId = createTab();
  loadActiveTab();
}

/** Dispatches Execute / Ctrl-Enter to the right runner for the current mode. */
function execCurrentMode() {
  if (currentMode === 'soql') executeQuery();
  else if (currentMode === 'apex') executeApex();
}

function updateSoqlActionButtons() {
  const mode = getCurrentMode();
  const out  = getActiveOutput();
  const hasRecords = !!(out && out.mode === 'soql' && out.raw && out.raw.records && out.raw.records.length);
  const hasNext    = !!(out && out.mode === 'soql' && out.raw && out.raw.nextRecordsUrl);

  document.getElementById('btn-copy-curl').style.display    = mode === 'soql' ? 'inline-flex' : 'none';
  document.getElementById('btn-copy-md').style.display      = hasRecords ? 'inline-flex' : 'none';
  document.getElementById('btn-download-csv').style.display = hasRecords ? 'inline-flex' : 'none';
  document.getElementById('btn-load-more').style.display    = hasNext ? 'inline-flex' : 'none';
}

async function executeQuery() {
  const query = getCode().trim();
  if (!query) { focusEditor(); return; }
  if (!SF.sessionId) { showNC('Session lost. Re-detecting…'); refreshSession(); return; }

  const btn = document.getElementById('btn-exec'); btn.disabled = true;
  setStatus('sb-run', 'Running…', true);
  document.getElementById('out-body').innerHTML = '<div class="empty-state"><div class="empty-ico">⏳</div><span>Running SOQL query…</span></div>';
  document.getElementById('btn-dl').style.display = 'none';

  const t0 = Date.now(), ts = new Date();
  const isTooling = document.getElementById('chk-tooling').checked;

  try {
    const data = await msg('QUERY', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, query, isTooling });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2) + 's';
    if (data.error) throw new Error(data.error);

    const output = {
      mode: 'soql', raw: data, success: true,
      label: `✅ ${data.totalSize.toLocaleString()} record${data.totalSize === 1 ? '' : 's'}`,
      meta: '⏱ ' + elapsed, code: query, isTooling, timestamp: ts.toISOString(), elapsed,
    };
    const tab = getActiveTab();
    if (tab) { tab.output = output; tab.dirty = false; renderTabs(); }
    document.getElementById('out-label').textContent = output.label;
    document.getElementById('out-meta').textContent  = output.meta;
    switchOut('log');
    setStatus('sb-ok', '✓ ' + elapsed);
    updateSoqlActionButtons();

    pushHistoryEntry({
      kind: 'soql', tabName: tab?.name, code: query, success: true,
      elapsedMs: Date.now() - t0,
      meta: { totalSize: data.totalSize, recordCount: data.records.length, isTooling },
      preview: data.records[0] ? JSON.stringify(data.records[0]).slice(0, 500) : '',
    });
  } catch (err) {
    document.getElementById('out-body').innerHTML = `<div class="banner b-err">❌ ${esc(err.message)}</div>`;
    setStatus('sb-err', '✗ Error');
    pushHistoryEntry({
      kind: 'soql', tabName: getActiveTab()?.name, code: query, success: false,
      elapsedMs: Date.now() - t0, meta: { isTooling }, preview: err.message.slice(0, 500),
    });
    if (err.message.includes('INVALID_SESSION') || err.message.includes('expired')) { SF.sessionId = null; refreshSession(); }
  } finally {
    btn.disabled = false;
  }
}

async function executeQueryNext() {
  const t = getActiveTab();
  if (!t || !t.output || !t.output.raw || !t.output.raw.nextRecordsUrl) return;

  const btn = document.getElementById('btn-load-more');
  btn.disabled = true; btn.textContent = '⏳ Loading…';

  try {
    const data = await msg('QUERY_NEXT', {
      sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, nextRecordsUrl: t.output.raw.nextRecordsUrl,
    });
    if (data.error) { await showAlert('Failed to fetch next batch: ' + data.error); return; }

    t.output.raw.records = (t.output.raw.records || []).concat(data.records || []);
    t.output.raw.nextRecordsUrl = data.nextRecordsUrl || null;
    t.output.raw.done = data.done ?? true;

    renderResultsTable(t.output.raw);
    updateSoqlActionButtons();
  } finally {
    btn.disabled = false; btn.textContent = '⏩ Load More';
  }
}

function renderResultsTable(data) {
  const body = document.getElementById('out-body'); body.innerHTML = '';
  if (!data || !data.records) return;

  if (data.records.length === 0) {
    body.innerHTML = '<div class="banner b-info">ℹ️ Query returned 0 records.</div>';
    return;
  }

  const keys = Object.keys(data.records[0]).filter(k => k !== 'attributes');

  let html = `<div class="result-summary"><span>Showing <b>${data.records.length.toLocaleString()}</b> of <b>${data.totalSize.toLocaleString()}</b> total records</span></div>`;

  html += `<div class="result-table-wrap"><table class="data-table"><thead><tr><th>#</th>`;
  keys.forEach(k => html += `<th>${esc(k)}</th>`);
  html += `</tr></thead><tbody>`;

  data.records.forEach((r, idx) => {
    html += `<tr><td class="row-idx">${idx + 1}</td>`;
    keys.forEach(k => {
      const val = (typeof r[k] === 'object' && r[k] !== null) ? JSON.stringify(r[k]) : r[k];
      html += `<td>${esc(val ?? '')}</td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody></table></div>`;
  body.innerHTML = html;
}

async function copyAsCurl() {
  const out = getActiveOutput();
  const query = (out && out.mode === 'soql') ? out.code : getCode();
  const isTooling = (out && out.mode === 'soql') ? out.isTooling : false;
  const endpoint = isTooling ? 'tooling/query' : 'query';
  const url = `${SF.instanceUrl}/services/data/v66.0/${endpoint}?q=${encodeURIComponent(query)}`;
  const curl = `curl "${url}" -H "Authorization: Bearer ${SF.sessionId}"`;
  await navigator.clipboard.writeText(curl);
}

async function copyAsMarkdown() {
  const out = getActiveOutput();
  if (!out || out.mode !== 'soql' || !out.raw.records.length) return;
  const recs = out.raw.records;
  const keys = Object.keys(recs[0]).filter(k => k !== 'attributes');
  let md = '| ' + keys.join(' | ') + ' |\n';
  md += '| ' + keys.map(() => '---').join(' | ') + ' |\n';
  recs.forEach(r => { md += '| ' + keys.map(k => String(r[k] ?? '')).join(' | ') + ' |\n'; });
  await navigator.clipboard.writeText(md);
}

function downloadResultsCsv() {
  const out = getActiveOutput();
  if (!out || out.mode !== 'soql' || !out.raw.records.length) return;
  const recs = out.raw.records;
  const keys = Object.keys(recs[0]).filter(k => k !== 'attributes');
  let csv = keys.join(',') + '\n';
  recs.forEach(r => { csv += keys.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(',') + '\n'; });
  dl(csv, `query_export_${Date.now()}.csv`, 'text/csv');
}
