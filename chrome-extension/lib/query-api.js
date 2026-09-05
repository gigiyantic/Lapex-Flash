/**
 * Lapex Flash — SOQL Query Runner (REST & Tooling query endpoints)
 */
async function runQuery({ sessionId, instanceUrl, query, isTooling }) {
  const base     = normalizeBase(instanceUrl);
  const headers  = buildAuthHeaders(sessionId);
  const endpoint = isTooling ? 'tooling/query' : 'query';
  const url      = `${base}/services/data/v66.0/${endpoint}?q=${encodeURIComponent(query)}`;

  const result = await sfFetchJson(url, { headers });
  parseSfError(result);

  return {
    totalSize:      result.totalSize ?? 0,
    done:           result.done ?? true,
    nextRecordsUrl: result.nextRecordsUrl || null,
    records:        result.records || [],
  };
}

async function runQueryNext({ sessionId, instanceUrl, nextRecordsUrl }) {
  const base       = normalizeBase(instanceUrl);
  const headers    = buildAuthHeaders(sessionId);
  const cleanPath  = nextRecordsUrl.startsWith('/') ? nextRecordsUrl : '/' + nextRecordsUrl;
  const url        = `${base}${cleanPath}`;

  const result = await sfFetchJson(url, { headers });
  parseSfError(result);

  return {
    totalSize:      result.totalSize ?? 0,
    done:           result.done ?? true,
    nextRecordsUrl: result.nextRecordsUrl || null,
    records:        result.records || [],
  };
}
