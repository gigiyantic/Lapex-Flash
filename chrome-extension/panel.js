/* ── Session ── */
let detectedOrgs = [];

async function refreshSession() {
  document.getElementById('nc-err').style.display = 'none';
  document.querySelector('.btn-retry').textContent = '⏳ Detecting…';

  const result = await msg('GET_SESSION');

  document.querySelector('.btn-retry').textContent = '🔄 Detect Salesforce Session';

  if (result.error || !result.found) {
    showNC(result.error || 'Could not find a Salesforce session.');
    return;
  }

  detectedOrgs = (result.orgs && result.orgs.length > 0) ? result.orgs : [result];
  applyOrg(detectedOrgs[0]);
  renderOrgSwitcher(detectedOrgs);
  document.getElementById('user-chip').style.display = 'flex';
  showMain();
}

/** Adopts one detected org's session as the active SF connection. */
function applyOrg(org) {
  SF = { sessionId: org.sessionId, instanceUrl: org.instanceUrl, name: org.name || org.email, orgId: org.orgId || null };
  const nameEl = document.getElementById('user-name');
  nameEl.textContent = org.orgName ? `${org.orgName} (${org.name || 'User'})` : (org.name || org.instanceUrl);
}

function renderOrgSwitcher(orgs) {
  const sel = document.getElementById('org-switcher');
  const nameEl = document.getElementById('user-name');
  if (orgs.length > 1) {
    sel.innerHTML = orgs.map((o, idx) => `<option value="${idx}">${o.isActive ? '🟢 ' : ''}${esc(o.orgName)} (${esc(o.name || 'User')})</option>`).join('');
    sel.style.display = 'inline-block';
    nameEl.style.display = 'none';
  } else {
    sel.style.display = 'none';
    nameEl.style.display = 'inline';
  }
}

function switchOrg(idx) {
  const org = detectedOrgs[parseInt(idx, 10)];
  if (!org) return;
  applyOrg(org);
  setStatus('sb-ok', 'Switched to ' + org.orgName);
}

function showNC(err) {
  document.getElementById('screen-nc').style.display = 'flex';
  document.getElementById('screen-main').style.display = 'none';
  if (err) { const el = document.getElementById('nc-err'); el.textContent = err; el.style.display = 'block'; }
}
function showMain() {
  document.getElementById('screen-nc').style.display  = 'none';
  document.getElementById('screen-main').style.display = 'flex';
  focusEditor();
}

/* ── Tabs ── */
let tabIdCounter = 1, activeTabId = null;
const tabs = {};

function createTab(name) {
  const id = tabIdCounter++;
  tabs[id] = { id, name: name || 'Script ' + id, mode: 'apex', code: '', output: null, dirty: false, cat: 'Apex_Code', lvl: 'DEBUG' };
  return id;
}

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  bar.querySelectorAll('.tab-item').forEach(el => el.remove());
  const add = document.querySelector('.tab-add');
  Object.values(tabs).forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab-item' + (t.id === activeTabId ? ' active' : '') + (t.dirty ? ' dirty' : '');
    el.innerHTML = `<span class="tab-dot"></span><span>${esc(t.name)}</span><button class="tab-x">✕</button>`;
    el.addEventListener('click', e => { if (!e.target.classList.contains('tab-x')) switchTab(t.id); });
    el.querySelector('.tab-x').addEventListener('click', e => { e.stopPropagation(); closeTab(t.id); });
    el.querySelector('span:nth-child(2)').addEventListener('dblclick', async () => {
      const n = await showPrompt('Rename tab:', t.name);
      if (n?.trim()) { t.name = n.trim(); renderTabs(); }
    });
    bar.insertBefore(el, add);
  });
}

function switchTab(id) {
  if (activeTabId && tabs[activeTabId]) {
    tabs[activeTabId].code = getCode();
    tabs[activeTabId].cat  = document.getElementById('LogCategory').value;
    tabs[activeTabId].lvl  = document.getElementById('LogLevel').value;
  }
  activeTabId = id;
  const t = tabs[id];
  setCode(t.code);
  document.getElementById('LogCategory').value = t.cat;
  document.getElementById('LogLevel').value = t.lvl;
  setMode(t.mode);
  clearStatus();

  if (t.output) {
    document.getElementById('out-label').textContent = t.output.label || 'Output';
    document.getElementById('out-meta').textContent  = t.output.meta || '';
    document.getElementById('btn-dl').style.display   = 'inline-flex';
    switchOut(t.output.mode === 'soql' ? 'table' : 'log');
  } else {
    resetOutputDisplay();
    switchOut('log');
  }
  updateSoqlActionButtons();

  renderTabs();
  focusEditor();
}

function addTab() { const id = createTab(); renderTabs(); switchTab(id); }
function closeTab(id) {
  const k = Object.keys(tabs);
  if (k.length === 1) return;
  delete tabs[id];
  renderTabs();
  if (activeTabId === id) { const r = Object.keys(tabs); switchTab(parseInt(r[r.length - 1])); }
}

/* ── Editor toolbar ── */
function loadSample() {
  setCode(`List<Account> accs = [SELECT Id, Name FROM Account LIMIT 5];\nSystem.debug('Found: ' + accs.size());\nfor (Account a : accs) System.debug('  → ' + a.Name);`);
  if (activeTabId && tabs[activeTabId]) { tabs[activeTabId].name = 'Sample'; tabs[activeTabId].dirty = true; renderTabs(); }
  focusEditor();
}
function clearEditor() { setCode(''); focusEditor(); }
function resetTab() {
  clearEditor(); resetOutputDisplay(); clearStatus();
  if (activeTabId && tabs[activeTabId]) { tabs[activeTabId].output = null; tabs[activeTabId].dirty = false; renderTabs(); }
  updateSoqlActionButtons();
}
async function copyCode() { await navigator.clipboard.writeText(getCode()); }

/* ── Status ── */
function setStatus(cls, msg, showSpin = false) {
  const b = document.getElementById('status-badge');
  b.className = 'status-badge show ' + cls;
  document.getElementById('spin').style.display = showSpin ? 'block' : 'none';
  document.getElementById('status-text').textContent = msg;
}
function clearStatus() { document.getElementById('status-badge').className = 'status-badge'; }

/* ── Output ── */
let currentOut = 'log';
function switchOut(tab) {
  currentOut = tab;
  document.getElementById('ot-log').classList.toggle('active', tab === 'log');
  document.getElementById('ot-table').classList.toggle('active', tab === 'table');
  document.getElementById('ot-json').classList.toggle('active', tab === 'json');
  const t = activeTabId && tabs[activeTabId];
  if (t && t.output) renderOutTab(tab, t.output);
}
function renderOutTab(tab, output) {
  if (tab === 'json') renderJSON(output.raw);
  else if (tab === 'table' || output.mode === 'soql') renderResultsTable(output.raw);
  else renderLog(output.raw);
}
function resetOutputDisplay() {
  document.getElementById('out-label').textContent = 'Output';
  document.getElementById('out-meta').textContent = '';
  document.getElementById('btn-dl').style.display = 'none';
  document.getElementById('out-body').innerHTML = '<div class="empty-state"><div class="empty-ico">📭</div><span>No output yet</span></div>';
}
function clearOut() {
  resetOutputDisplay();
  if (activeTabId && tabs[activeTabId]) tabs[activeTabId].output = null;
  updateSoqlActionButtons();
}

/* ── Execute (Apex) ── */
async function executeApex() {
  const code = getCode().trim();
  if (!code) { focusEditor(); return; }
  if (!SF.sessionId) { showNC('Session lost. Re-detecting…'); refreshSession(); return; }

  const btn = document.getElementById('btn-exec'); btn.disabled = true;
  setStatus('sb-run', 'Executing…', true);
  document.getElementById('out-body').innerHTML = '<div class="empty-state"><div class="empty-ico">⏳</div><span>Calling Salesforce Tooling API…</span></div>';
  document.getElementById('btn-dl').style.display = 'none';

  const t0 = Date.now(), ts = new Date();
  const category = document.getElementById('LogCategory').value, level = document.getElementById('LogLevel').value;

  try {
    const data = await msg('EXECUTE', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, code, category, level });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2) + 's';
    if (data.error) throw new Error(data.error);

    const output = { mode: 'apex', raw: data, success: data.success, label: data.success ? '✅ Debug Log' : '❌ Failed', meta: '⏱ ' + elapsed, code, category, level, timestamp: ts.toISOString(), elapsed };
    if (activeTabId && tabs[activeTabId]) { tabs[activeTabId].output = output; tabs[activeTabId].dirty = false; renderTabs(); }
    document.getElementById('out-label').textContent = output.label; document.getElementById('out-meta').textContent = output.meta; document.getElementById('btn-dl').style.display = 'inline-flex';
    switchOut('log');
    setStatus(data.success ? 'sb-ok' : 'sb-err', data.success ? '✓ ' + elapsed : '✗ Failed');

    pushHistoryEntry({
      kind: 'apex', tabName: tabs[activeTabId]?.name, code, success: data.success,
      elapsedMs: Date.now() - t0, meta: { category, level },
      preview: (data.exceptionMessage || data.compileProblem || '').slice(0, 500),
    });

    if (data.error && (data.error.includes('INVALID_SESSION') || data.error.includes('expired'))) { SF.sessionId = null; refreshSession(); }
  } catch (err) {
    document.getElementById('out-body').innerHTML = `<div class="banner b-err">❌ ${esc(err.message)}</div>`;
    setStatus('sb-err', '✗ Error');
    pushHistoryEntry({ kind: 'apex', tabName: tabs[activeTabId]?.name, code, success: false, elapsedMs: Date.now() - t0, meta: { category, level }, preview: err.message.slice(0, 500) });
  } finally { btn.disabled = false; }
}

/* ── Render (Apex log / JSON) ── */
function renderLog(data) {
  const body = document.getElementById('out-body'); body.innerHTML = ''; if (!data) return;
  if (data.compiled === false || data.compiled === null) {
    const ln = (data.line && data.line > 0) ? data.line : null, col = (data.column && data.column > 0) ? data.column : null;
    const loc = ln ? ` — Line ${ln}, Col ${col}` : '';
    body.innerHTML += `<div class="banner b-err">⚠️ Compile Error${loc}<br><br><code style="font-size:10.5px;white-space:pre-wrap;color:var(--red)">${esc(data.compileProblem || data.exceptionMessage || 'Unknown error')}</code></div>`;
    return;
  }
  if (!data.success) { body.innerHTML += `<div class="banner b-err">❌ Runtime Exception<br><br><code style="font-size:10.5px;color:var(--red)">${esc(data.exceptionMessage || '')}</code>${data.exceptionStackTrace ? `<br><pre style="font-size:9.5px;color:var(--text2);white-space:pre-wrap;margin-top:4px">${esc(data.exceptionStackTrace)}</pre>` : ''}</div>`; }
  else { body.innerHTML += `<div class="banner b-ok">✅ Apex executed successfully</div>`; }
  const logBody = data.logBody || '';
  if (logBody) { logBody.split('\n').filter(l => l.trim()).forEach(line => { const p = line.split('|'); if (p.length >= 3) { const cls = lc(p[1] + ' ' + p[2]); body.innerHTML += `<div class="log-line"><span class="ll-ts">${esc(p[0].trim())}</span><span class="ll-cat">${esc((p[1] + '|' + p[2]).trim())}</span><span class="ll-msg ${cls}">${esc(p.slice(3).join('|').trim())}</span></div>`; } else { body.innerHTML += `<div class="log-line"><span class="ll-msg ${lc(line)}">${esc(line)}</span></div>`; } }); }
  else if (data.success) { body.innerHTML += `<div class="banner b-info">ℹ️ No log returned. Try increasing Log Level.</div>`; }
}
function renderJSON(data) { document.getElementById('out-body').innerHTML = `<pre class="raw-pre">${esc(JSON.stringify(data, null, 2))}</pre>`; }

/* ── Manual full-fidelity download (.txt) ── */
function buildTxt(output) {
  const sep = '═'.repeat(60); const d = output.raw || {};
  let txt = `${sep}\nLAPEX FLASH — ${output.mode === 'soql' ? 'SOQL LOG' : 'LOG'}\n${sep}\nTimestamp : ${output.timestamp}\nUser      : ${SF.name || ''}\nInstance  : ${SF.instanceUrl || ''}\nStatus    : ${output.success ? 'SUCCESS' : 'FAILED'}\nElapsed   : ${output.elapsed || ''}\n${sep}\n\n── ${output.mode === 'soql' ? 'SOQL QUERY' : 'APEX CODE'} ──\n${output.code}\n\n`;
  if (output.mode === 'soql') {
    txt += `── RESULT ──\n${d.records ? d.records.length : 0} of ${d.totalSize || 0} records\n\n── RECORDS ──\n${JSON.stringify(d.records || [], null, 2)}`;
  } else {
    txt += `── RESULT ──\n`;
    if (d.compiled === false) { const ln = d.line > 0 ? d.line : '?'; txt += `COMPILE ERROR at Line ${ln}\n${d.compileProblem || ''}\n`; }
    else if (!d.success) { txt += `EXCEPTION: ${d.exceptionMessage || ''}\n${d.exceptionStackTrace || ''}\n`; }
    else txt += `SUCCESS\n`;
    if (d.logBody) txt += `\n── DEBUG LOG ──\n${d.logBody}\n`;
  }
  txt += `\n${sep}\n`; return txt;
}
function downloadLog() {
  const t = activeTabId && tabs[activeTabId]; if (!t || !t.output) return;
  dl(buildTxt(t.output), `lapex-log_${t.name.replace(/\s+/g, '_')}.txt`);
}
async function copyOut() { await navigator.clipboard.writeText(document.getElementById('out-body').innerText); }

/* ── Event bindings (MV3 forbids inline onclick=) ── */
document.getElementById('org-switcher').addEventListener('change', (e) => switchOrg(e.target.value));
document.getElementById('btn-refresh').addEventListener('click', refreshSession);
document.getElementById('btn-retry').addEventListener('click', refreshSession);
document.getElementById('tab-add').addEventListener('click', addTab);
document.getElementById('btn-load-sample').addEventListener('click', loadSample);
document.getElementById('btn-copy-code').addEventListener('click', copyCode);
document.getElementById('btn-clear-editor').addEventListener('click', clearEditor);
document.getElementById('btn-exec').addEventListener('click', execCurrentMode);
document.getElementById('btn-reset-tab').addEventListener('click', resetTab);
document.getElementById('ot-log').addEventListener('click', () => switchOut('log'));
document.getElementById('ot-table').addEventListener('click', () => switchOut('table'));
document.getElementById('ot-json').addEventListener('click', () => switchOut('json'));
document.getElementById('btn-dl').addEventListener('click', downloadLog);
document.getElementById('btn-copy-out').addEventListener('click', copyOut);
document.getElementById('btn-clear-out').addEventListener('click', clearOut);

document.getElementById('mode-apex').addEventListener('click', () => setMode('apex'));
document.getElementById('mode-soql').addEventListener('click', () => setMode('soql'));
document.getElementById('mode-fieldperm').addEventListener('click', () => setMode('fieldperm'));
document.getElementById('btn-load-more').addEventListener('click', executeQueryNext);
document.getElementById('btn-copy-curl').addEventListener('click', copyAsCurl);
document.getElementById('btn-copy-md').addEventListener('click', copyAsMarkdown);
document.getElementById('btn-download-csv').addEventListener('click', downloadResultsCsv);
document.getElementById('btn-bulk-export').addEventListener('click', runBulkExport);
document.getElementById('btn-parallel-export').addEventListener('click', runParallelExport);

document.getElementById('btn-history').addEventListener('click', openHistoryDrawer);
document.getElementById('btn-history-close').addEventListener('click', closeHistoryDrawer);
document.getElementById('btn-history-clear').addEventListener('click', clearHistory);

document.getElementById('btn-search').addEventListener('click', openSearchDrawer);
document.getElementById('btn-search-close').addEventListener('click', closeSearchDrawer);
document.getElementById('btn-sync-metadata').addEventListener('click', syncMetadataForCurrentOrg);
document.getElementById('search-input').addEventListener('input', onSearchInput);

/* ── Init ── */
(function () {
  initEditor(document.getElementById('code-ta'));
  const id = createTab('Script 1'); activeTabId = id; renderTabs(); setMode('apex');
  refreshSession();
})();
