/**
 * Lapex Flash — Bulk API 2.0 export UI (job creation + polling + download).
 */
const BULK_POLL_INTERVAL_MS = 2500;
const BULK_POLL_MAX_ATTEMPTS = 100;

async function runBulkExport() {
  const query = getCode().trim();
  if (!query) { focusEditor(); return; }
  if (!SF.sessionId) { alert('Not connected to Salesforce.'); return; }

  const body = document.getElementById('out-body');
  body.innerHTML = `
    <div class="banner b-info" id="bulk-progress-banner">
      <div style="font-size:13px;font-weight:600;margin-bottom:6px;">🚀 Creating Salesforce Bulk API 2.0 Query Job…</div>
      <div style="font-size:11px;color:var(--text2);" id="bulk-status-text">Submitting job for: <code>${esc(query.slice(0, 60))}…</code></div>
    </div>`;

  const start = await msg('START_BULK_QUERY', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, query });
  if (start.error) {
    body.innerHTML = `<div class="banner b-err">❌ Failed to start Bulk Export: ${esc(start.error)}</div>`;
    return;
  }

  pollBulkJob(start.jobId, 0);
}

async function pollBulkJob(jobId, attempt) {
  if (attempt >= BULK_POLL_MAX_ATTEMPTS) {
    const body = document.getElementById('out-body');
    body.innerHTML = `<div class="banner b-err">❌ Bulk job timed out after ${BULK_POLL_MAX_ATTEMPTS} polls.</div>`;
    return;
  }

  const status = await msg('GET_BULK_QUERY_STATUS', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, jobId });
  if (status.error) {
    document.getElementById('out-body').innerHTML = `<div class="banner b-err">❌ ${esc(status.error)}</div>`;
    return;
  }

  const state = status.state;
  const txtEl = document.getElementById('bulk-status-text');

  if (state === 'JobComplete') {
    const processed = status.numberRecordsProcessed ?? 0;
    const body = document.getElementById('out-body');
    body.innerHTML = `<div class="banner b-ok">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px;color:var(--green);">✅ Bulk API 2.0 Export Finished Successfully!</div>
      <div style="font-size:12px;">Processed <b>${processed.toLocaleString()}</b> total records in parallel on Salesforce.</div>
    </div>`;

    const dlResult = await msg('DOWNLOAD_BULK_QUERY', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, jobId });
    if (dlResult.error) {
      body.innerHTML += `<div class="banner b-err">❌ Download failed: ${esc(dlResult.error)}</div>`;
    }
    return;
  }

  if (state === 'Failed' || state === 'Aborted') {
    document.getElementById('out-body').innerHTML =
      `<div class="banner b-err">❌ Bulk API Job ${esc(state)}: ${esc(status.errorMessage || 'Unknown error')}</div>`;
    return;
  }

  if (txtEl) txtEl.innerHTML = `Job state: <code>${esc(state)}</code> · poll ${attempt + 1}/${BULK_POLL_MAX_ATTEMPTS}`;
  setTimeout(() => pollBulkJob(jobId, attempt + 1), BULK_POLL_INTERVAL_MS);
}
