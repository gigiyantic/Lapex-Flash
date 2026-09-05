/**
 * Lapex Flash — Parallel multi-threaded date-range query export UI.
 */
async function runParallelExport() {
  const baseQuery = getCode().trim();
  if (!baseQuery) { focusEditor(); return; }
  if (!SF.sessionId) { alert('Not connected to Salesforce.'); return; }

  const dateField = prompt('Date field to split on:', 'CreatedDate');
  if (!dateField) return;
  const startDate = prompt('Start date (YYYY-MM-DD):', '');
  if (!startDate) return;
  const endDate = prompt('End date (YYYY-MM-DD):', '');
  if (!endDate) return;
  const threads = prompt('Number of parallel worker threads (1-20):', '8');
  if (!threads) return;

  const body = document.getElementById('out-body');
  body.innerHTML = `<div class="banner b-info">
    <div style="font-size:13px;font-weight:600;margin-bottom:6px;">⚡ Running ${esc(threads)} Parallel Worker Threads…</div>
  </div>`;

  try {
    const data = await msg('RUN_PARALLEL_QUERY', {
      sessionId: SF.sessionId, instanceUrl: SF.instanceUrl,
      baseQuery, dateField, startDate, endDate, threads,
    });

    if (data.error || (data.errors && !data.success)) {
      throw new Error(data.error || (data.errors ? data.errors.join('; ') : 'Parallel query failed'));
    }

    const output = {
      mode: 'soql',
      raw: { totalSize: data.totalRecords, done: true, nextRecordsUrl: null, records: data.records },
      success: true,
      label: `✅ Parallel Export (${data.fetchedRecords.toLocaleString()} records)`,
      meta: `${data.threads} threads`,
      code: baseQuery, isTooling: false, timestamp: new Date().toISOString(),
    };
    if (activeTabId && tabs[activeTabId]) { tabs[activeTabId].output = output; renderTabs(); }
    document.getElementById('out-label').textContent = output.label;
    document.getElementById('out-meta').textContent  = output.meta;
    switchOut('table');
    updateSoqlActionButtons();

    if (data.errors) {
      body.insertAdjacentHTML('afterbegin', `<div class="banner b-err">⚠️ ${data.errors.length} thread(s) reported errors: ${esc(data.errors.join('; '))}</div>`);
    }
  } catch (err) {
    body.innerHTML = `<div class="banner b-err">❌ Parallel Export Error: ${esc(err.message)}</div>`;
  }
}
