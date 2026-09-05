/**
 * Lapex Flash — Anonymous Apex execution
 * EXECUTE ANONYMOUS — calls Salesforce Tooling API directly.
 * No CORS issue: host_permissions in manifest grants access.
 */
async function executeApex({ sessionId, instanceUrl, code, category, level }) {
  const base    = normalizeBase(instanceUrl);
  const headers = buildAuthHeaders(sessionId);
  const API     = `${base}/services/data/v66.0`;

  const me = await getUserInfo(base, sessionId);
  if (me.error) throw new Error('Session expired — open Salesforce tab and try again.');
  const userId = me.user_id || (me.id || '').split('/').pop();

  await ensureTraceFlag(API, headers, userId, level || 'DEBUG');

  const execResult = await sfFetchJson(
    `${API}/tooling/executeAnonymous/?anonymousBody=${encodeURIComponent(code)}`,
    { headers }
  );

  parseSfError(execResult);

  await sleep(1800);

  let logBody = '';
  const logQ = await sfFetchJson(
    `${API}/tooling/query?q=SELECT+Id+FROM+ApexLog+WHERE+Request='Anonymous'+ORDER+BY+StartTime+DESC+LIMIT+1`,
    { headers }
  );

  if (logQ.records?.length > 0) {
    logBody = await fetch(
      `${API}/tooling/sobjects/ApexLog/${logQ.records[0].Id}/Body`,
      { headers }
    ).then(r => r.text());
  }

  return {
    success:             execResult.success    ?? false,
    compiled:            execResult.compiled   ?? false,
    line:                execResult.line       ?? null,
    column:              execResult.column     ?? null,
    compileProblem:      execResult.compileProblem     ?? null,
    exceptionMessage:    execResult.exceptionMessage   ?? null,
    exceptionStackTrace: execResult.exceptionStackTrace ?? null,
    logBody,
  };
}

async function ensureTraceFlag(API, headers, userId, level) {
  const sfLevel = level.toUpperCase();
  const exp15   = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const existing = await sfFetchJson(
    `${API}/tooling/query?q=SELECT+Id,DebugLevelId+FROM+TraceFlag+WHERE+TracedEntityId='${userId}'+AND+LogType='USER_DEBUG'`,
    { headers }
  );

  if (existing.records?.length > 0) {
    const tf = existing.records[0];
    await fetch(`${API}/tooling/sobjects/DebugLevel/${tf.DebugLevelId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ ApexCode: sfLevel, System: sfLevel, Callout: 'INFO', Database: 'INFO', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', ApexProfiling: 'NONE' }),
    });
    await fetch(`${API}/tooling/sobjects/TraceFlag/${tf.Id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ ExpirationDate: exp15 }),
    });
    return;
  }

  const dl = await fetch(`${API}/tooling/sobjects/DebugLevel/`, {
    method: 'POST', headers,
    body: JSON.stringify({ DeveloperName: 'LapexFlash_' + Date.now(), MasterLabel: 'Lapex Flash Ext', ApexCode: sfLevel, System: sfLevel, Callout: 'INFO', Database: 'INFO', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', ApexProfiling: 'NONE' }),
  }).then(r => r.json());

  await fetch(`${API}/tooling/sobjects/TraceFlag/`, {
    method: 'POST', headers,
    body: JSON.stringify({ TracedEntityId: userId, DebugLevelId: dl.id, LogType: 'USER_DEBUG', ExpirationDate: exp15 }),
  });
}
