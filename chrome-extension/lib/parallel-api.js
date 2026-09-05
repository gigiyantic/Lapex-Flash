/**
 * Lapex Flash — Parallel multi-threaded date-range query export.
 * Splits [startDate, endDate] into N buckets and runs them concurrently.
 *
 * The WHERE-clause injection below is naive string manipulation (regex,
 * not a SOQL parser) — that's fine here only because it always operates
 * on the user's own query against their own org, never on untrusted input.
 */
async function runParallelQuery({ sessionId, instanceUrl, baseQuery, dateField, startDate, endDate, threads }) {
  const base    = normalizeBase(instanceUrl);
  const headers = buildAuthHeaders(sessionId);
  const field   = dateField || 'CreatedDate';

  const numThreads = Math.min(Math.max(parseInt(threads) || 8, 1), 20);
  const startMs = new Date(startDate).getTime();
  const endMs   = new Date(endDate).getTime();

  if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) {
    throw new Error('Invalid date range: startDate must be before endDate');
  }

  const stepMs = (endMs - startMs) / numThreads;

  const workerPromises = Array.from({ length: numThreads }, (_, i) => {
    const tStart = new Date(startMs + (i * stepMs)).toISOString();
    const tEnd   = new Date(startMs + ((i + 1) * stepMs)).toISOString();

    const clause = `${field} >= ${tStart} AND ${field} < ${tEnd}`;
    let subQuery = baseQuery;
    if (/\bWHERE\b/i.test(baseQuery)) {
      subQuery = baseQuery.replace(/\bWHERE\b/i, `WHERE (${clause}) AND `);
    } else if (/\bFROM\s+([a-zA-Z0-9_]+)/i.test(baseQuery)) {
      subQuery = baseQuery.replace(/(\bFROM\s+[a-zA-Z0-9_]+)/i, `$1 WHERE ${clause}`);
    }

    const url = `${base}/services/data/v66.0/query?q=${encodeURIComponent(subQuery)}`;
    return sfFetchJson(url, { headers })
      .then(res => ({
        thread: i + 1,
        subQuery,
        totalSize: res.totalSize || 0,
        records: res.records || [],
        error: res.errorCode ? `${res.errorCode}: ${res.message}` : null,
      }))
      .catch(err => ({ thread: i + 1, subQuery, error: err.message, records: [] }));
  });

  const workerResults = await Promise.all(workerPromises);

  let totalRecords = 0;
  const combinedRecords = [];
  const errors = [];

  workerResults.forEach(r => {
    if (r.error) {
      errors.push(`Thread ${r.thread}: ${r.error}`);
    } else {
      totalRecords += r.totalSize;
      combinedRecords.push(...r.records);
    }
  });

  return {
    success: errors.length === 0,
    threads: numThreads,
    totalRecords,
    fetchedRecords: combinedRecords.length,
    records: combinedRecords,
    errors: errors.length > 0 ? errors : null,
  };
}
