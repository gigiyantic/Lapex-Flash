/**
 * Lapex Flash — Bulk API 2.0 query export (for very large record sets)
 */
async function startBulkQuery({ sessionId, instanceUrl, query }) {
  const base    = normalizeBase(instanceUrl);
  const headers = buildAuthHeaders(sessionId);
  const url     = `${base}/services/data/v66.0/jobs/query`;

  const data = await sfFetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'query', query }),
  });
  if (data.errorCode || data.error) {
    throw new Error(data.message || data.error_description || 'Bulk API error');
  }

  return { jobId: data.id, state: data.state, object: data.object, createdDate: data.createdDate };
}

async function getBulkQueryStatus({ sessionId, instanceUrl, jobId }) {
  const base    = normalizeBase(instanceUrl);
  const headers = buildAuthHeaders(sessionId);
  const url     = `${base}/services/data/v66.0/jobs/query/${jobId}`;
  return sfFetchJson(url, { headers: { 'Authorization': headers.Authorization } });
}

/* Tracks blob URLs created for in-flight downloads so they can be revoked once Chrome finishes writing the file. */
const pendingBulkDownloads = {};

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === 'complete') {
    const url = pendingBulkDownloads[delta.id];
    if (url) {
      URL.revokeObjectURL(url);
      delete pendingBulkDownloads[delta.id];
    }
  }
});

async function downloadBulkQuery({ sessionId, instanceUrl, jobId }) {
  const base    = normalizeBase(instanceUrl);
  const headers = buildAuthHeaders(sessionId);
  const url     = `${base}/services/data/v66.0/jobs/query/${jobId}/results`;

  const resp = await fetch(url, { headers: { 'Authorization': headers.Authorization } });
  if (!resp.ok) throw new Error(`Bulk results download failed: HTTP ${resp.status}`);

  const blob    = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);

  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename: `bulk_export_${jobId}.csv`,
    saveAs: false,
  });

  pendingBulkDownloads[downloadId] = blobUrl;
  return { ok: true, downloadId };
}
