/**
 * Lapex Flash — Metadata sync + client-side code search over IndexedDB.
 */
function openSearchDrawer() {
  document.getElementById('drawer-search').classList.add('open');
  refreshSyncInfo();
}
function closeSearchDrawer() {
  document.getElementById('drawer-search').classList.remove('open');
}

async function refreshSyncInfo() {
  const el = document.getElementById('search-sync-info');
  if (!SF.orgId) { el.textContent = 'No org connected yet.'; return; }
  const info = await getSyncInfo(SF.orgId);
  if (!info) {
    el.textContent = 'Not synced yet — click Sync to index this org\'s Apex classes & triggers.';
  } else {
    const when = new Date(info.lastSyncedAt).toLocaleString();
    el.textContent = `Synced ${info.classCount} classes, ${info.triggerCount} triggers · ${when}`;
  }
}

async function syncMetadataForCurrentOrg() {
  if (!SF.sessionId || !SF.orgId) { alert('Connect to a Salesforce org first.'); return; }

  const btn = document.getElementById('btn-sync-metadata');
  btn.disabled = true; btn.textContent = '⏳ Syncing…';

  try {
    const data = await msg('SYNC_METADATA', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl });
    if (data.error) { alert('Metadata sync failed: ' + data.error); return; }

    const records = [
      ...data.classes.map(c => ({ type: 'ApexClass', name: c.name, body: c.body })),
      ...data.triggers.map(t => ({ type: 'ApexTrigger', name: t.name, body: t.body })),
    ];
    await putSources(SF.orgId, records);
    await refreshSyncInfo();
  } catch (err) {
    alert('Metadata sync failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '🔄 Sync';
  }
}

async function searchMetadata(orgId, queryLower) {
  const sources = await getSourcesByOrg(orgId);
  const results = [];

  outer:
  for (const rec of sources) {
    const lines = rec.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        results.push({ name: rec.name, type: rec.type, line: i + 1, text: lines[i].trim() });
        if (results.length >= 100) break outer;
      }
    }
  }
  return results;
}

let _searchDebounce = null;
function onSearchInput(e) {
  clearTimeout(_searchDebounce);
  const q = e.target.value.trim();
  _searchDebounce = setTimeout(() => runSearch(q), 250);
}

async function runSearch(q) {
  const resultsEl = document.getElementById('search-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  if (!SF.orgId) { resultsEl.innerHTML = '<div class="drawer-empty">Connect to a Salesforce org first.</div>'; return; }

  const hits = await searchMetadata(SF.orgId, q.toLowerCase());
  if (hits.length === 0) {
    resultsEl.innerHTML = '<div class="drawer-empty">No matches.</div>';
    return;
  }

  resultsEl.innerHTML = hits.map(h => `
    <div class="drawer-row" style="cursor:default">
      <div class="drawer-row-main">
        <div class="drawer-row-title">${esc(h.name)} <span class="search-hit-loc">:${h.line}</span></div>
        <div class="drawer-row-sub">${esc(h.text.slice(0, 120))}</div>
      </div>
      <span class="tag" style="background:var(--blue-dim);color:var(--blue)">${h.type === 'ApexClass' ? 'Class' : 'Trigger'}</span>
    </div>
  `).join('');
}
