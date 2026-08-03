/**
 * Apex Executor — Local Node.js Server
 * ─────────────────────────────────────
 * Authentication methods (same as Workbench):
 *   1. SOAP Login  — username + password + security token
 *   2. OAuth 2.0   — "Login with Salesforce" button, auto-login if SF already open
 *
 * Flow:
 *   Browser → localhost:3000/oauth/start
 *           → login.salesforce.com/services/oauth2/authorize  (auto if SF open)
 *           → localhost:3000/oauth/callback?code=xxx
 *           → exchanges code for sessionId server-side
 *           → redirects to apex-executor.html  ✅
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3000;

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

/* ── Load OAuth config ── */
let oauthCfg = {};
try {
  oauthCfg = require('./oauth-config.json');
  if (oauthCfg.client_id && !oauthCfg.client_id.includes('PASTE')) {
    console.log('  ✅ OAuth Connected App config loaded.');
  } else {
    console.log('  ⚠️  oauth-config.json found but credentials not filled in yet.');
  }
} catch(_) {
  console.log('  ℹ️  No oauth-config.json found — OAuth login disabled.');
}

const REDIRECT_URI = 'http://localhost:3000/oauth/callback';

/* ════════════════════════════════════════════════════════════════
   OAuth Routes — "Login with Salesforce" flow
════════════════════════════════════════════════════════════════ */

/* GET /oauth/config — tells the HTML whether OAuth is ready */
app.get('/oauth/config', (_req, res) => {
  const ready = !!(oauthCfg.client_id && oauthCfg.client_secret
               && !oauthCfg.client_id.includes('PASTE'));
  res.json({ ready });
});

/* GET /oauth/start?env=login|test
   Step 1 — redirect browser to Salesforce authorization page.
   If user is already logged into Salesforce in the same browser → auto-approved. */
app.get('/oauth/start', (req, res) => {
  if (!oauthCfg.client_id || oauthCfg.client_id.includes('PASTE')) {
    return res.status(400).send(`
      <h2 style="font-family:sans-serif;color:#f87171">OAuth not configured</h2>
      <p style="font-family:sans-serif;color:#94a3b8">
        Open <code>oauth-config.json</code> in the RedLine folder and paste your<br>
        Salesforce Connected App <strong>Consumer Key</strong> and <strong>Consumer Secret</strong>.
      </p>`);
  }

  const env       = req.query.env || 'login';
  const loginHost = env === 'test'
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     oauthCfg.client_id,
    redirect_uri:  REDIRECT_URI,
    scope:         'api web refresh_token offline_access',
    state:         env,   // pass env through so callback knows which SF instance
    prompt:        'login select_account',  // remove to make it truly auto-login
  });

  const authUrl = `${loginHost}/services/oauth2/authorize?${params}`;
  console.log(`[oauth] Redirecting to ${loginHost} for OAuth…`);
  res.redirect(authUrl);
});

/* GET /oauth/callback?code=xxx&state=login|test
   Step 2 — Salesforce redirects here after user approves.
   We exchange the code for an access_token (= sessionId) server-side. */
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.log(`[oauth] Error: ${error} — ${error_description}`);
    return res.redirect(`/apex-executor.html?oauth_error=${encodeURIComponent(error_description || error)}`);
  }

  const env       = state || 'login';
  const loginHost = env === 'test'
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';

  try {
    /* Exchange authorization code for access token */
    const tokenResp = await fetch(`${loginHost}/services/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     oauthCfg.client_id,
        client_secret: oauthCfg.client_secret,
        redirect_uri:  REDIRECT_URI,
      }).toString(),
    });

    const token = await tokenResp.json();

    if (token.error) {
      console.log(`[oauth] Token error: ${token.error} — ${token.error_description}`);
      return res.redirect(`/apex-executor.html?oauth_error=${encodeURIComponent(token.error_description || token.error)}`);
    }

    /* Get user display info */
    const userResp = await fetch(`${token.instance_url}/services/oauth2/userinfo`, {
      headers: { 'Authorization': `Bearer ${token.access_token}` },
    });
    const userInfo = await userResp.json();

    console.log(`[oauth] ✅ Logged in as ${userInfo.name || userInfo.email} — ${token.instance_url}`);

    /* Pass session to the HTML page via URL fragment (#) so it's never sent to server */
    const sessionPayload = encodeURIComponent(JSON.stringify({
      sessionId:   token.access_token,
      instanceUrl: token.instance_url,
      userName:    userInfo.email || userInfo.preferred_username || '',
      displayName: userInfo.name  || userInfo.email || '',
      orgName:     userInfo.organization_id || '',
    }));

    res.redirect(`/apex-executor.html#oauth=${sessionPayload}`);

  } catch (err) {
    console.error('[oauth] Callback error:', err.message);
    res.redirect(`/apex-executor.html?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /login  — SOAP username/password (same as Workbench)
════════════════════════════════════════════════════════════════ */
app.post('/login', async (req, res) => {
  let { username, password, securityToken = '', environment = 'login', apiVersion = '66.0' } = req.body;

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }

  const loginHost = environment === 'test'
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';
  const soapUrl = `${loginHost}/services/Soap/u/${apiVersion}`;

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${xmlEsc(username)}</n1:username>
      <n1:password>${xmlEsc(password + securityToken)}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`;

  try {
    console.log(`[login] SOAP login for ${username} on ${loginHost}`);
    const resp = await fetch(soapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '""' },
      body: soapBody,
    });

    const xml = await resp.text();

    if (xml.includes('<faultcode>') || xml.includes(':Fault>')) {
      const fault = extractXml(xml, 'faultstring') || extractXml(xml, 'faultcode') || 'Login failed';
      return res.json({ ok: false, error: fault });
    }

    const sessionId   = extractXml(xml, 'sessionId');
    const serverUrl   = extractXml(xml, 'serverUrl');
    const userId      = extractXml(xml, 'userId');
    const userName    = extractXml(xml, 'userName');
    const orgName     = extractXml(xml, 'organizationName');
    const displayName = extractXml(xml, 'displayName') || userName;

    if (!sessionId) return res.json({ ok: false, error: 'Could not parse session from Salesforce.' });

    const instanceUrl = serverUrl
      ? serverUrl.replace(/\/services\/Soap\/.*$/, '')
      : loginHost;

    console.log(`[login] ✅ ${userName} — ${instanceUrl}`);
    res.json({ ok: true, sessionId, instanceUrl, userId, userName, orgName, displayName });

  } catch (err) {
    console.error('[login]', err.message);
    res.status(500).json({ ok: false, error: 'Network error: ' + err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /verify  — Session ID verification check
════════════════════════════════════════════════════════════════ */
app.post('/verify', async (req, res) => {
  const { sessionId, instanceUrl } = req.body;
  if (!sessionId || !instanceUrl) {
    return res.json({ ok: false, error: 'Session ID and Instance URL are required.' });
  }
  const base = instanceUrl.replace(/\/$/, '');
  try {
    // Try userinfo first
    const me = await sfGet(`${base}/services/oauth2/userinfo`, {
      'Authorization': `Bearer ${sessionId}`,
    });
    if (me && !me.error && (me.name || me.email)) {
      return res.json({ ok: true, name: me.name || me.email, email: me.email, orgId: me.organization_id || '' });
    }

    // Fallback to limits check for standard SID session cookies
    const limits = await sfGet(`${base}/services/data/v66.0/limits`, {
      'Authorization': `Bearer ${sessionId}`,
    });
    if (limits && !limits.error && limits.DailyApiRequests) {
      return res.json({ ok: true, name: 'Salesforce User', email: '', orgId: 'Connected Org' });
    }

    res.json({ ok: false, error: me?.error_description || me?.error || limits?.error || 'Invalid session ID or URL.' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /execute
════════════════════════════════════════════════════════════════ */
app.post('/execute', async (req, res) => {
  const { code, category = 'Apex_code', level = 'Debug', sessionId, instanceUrl } = req.body;

  if (!code || !sessionId || !instanceUrl) {
    return res.status(400).json({ error: 'Missing: code, sessionId, or instanceUrl' });
  }

  const base = instanceUrl.replace(/\/$/, '');
  const soapUrl = `${base}/services/Soap/s/66.0`;

  // SOAP request envelope - identical to Workbench's SforceApexClient
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <env:Header>
    <SessionHeader xmlns="http://soap.sforce.com/2006/08/apex">
      <sessionId>${xmlEsc(sessionId)}</sessionId>
    </SessionHeader>
    <DebuggingHeader xmlns="http://soap.sforce.com/2006/08/apex">
      <categories>
        <category>${xmlEsc(category)}</category>
        <level>${xmlEsc(level)}</level>
      </categories>
    </DebuggingHeader>
  </env:Header>
  <env:Body>
    <executeAnonymous xmlns="http://soap.sforce.com/2006/08/apex">
      <String>${xmlEsc(code)}</String>
    </executeAnonymous>
  </env:Body>
</env:Envelope>`;

  try {
    console.log(`[execute] Calling Apex SOAP executeAnonymous on ${base}`);
    const resp = await fetch(soapUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '""',
      },
      body: soapBody,
    });

    const xml = await resp.text();

    // Check for SOAP Fault (e.g. invalid session)
    if (xml.includes('<faultcode>') || xml.includes(':Fault>')) {
      const fault = extractXml(xml, 'faultstring') || extractXml(xml, 'faultcode') || 'Execution failed';
      if (fault.includes('INVALID_SESSION_ID')) {
        return res.status(401).json({ error: 'Session expired — please log in again.' });
      }
      throw new Error(fault);
    }

    // Extract execution result values from SOAP response
    const compiledStr = extractXml(xml, 'compiled');
    const successStr  = extractXml(xml, 'success');
    const compiled    = compiledStr === 'true';
    const success     = successStr === 'true';
    const lineVal     = parseInt(extractXml(xml, 'line') || '-1', 10);
    const colVal      = parseInt(extractXml(xml, 'column') || '-1', 10);
    const line        = lineVal > 0 ? lineVal : null;
    const column      = colVal > 0 ? colVal : null;
    const compileProblem      = extractXml(xml, 'compileProblem');
    const exceptionMessage    = extractXml(xml, 'exceptionMessage');
    const exceptionStackTrace = extractXml(xml, 'exceptionStackTrace');
    const debugLog            = extractXml(xml, 'debugLog') || '';

    // Save log file to server-side logs/ directory
    try {
      const nowStr = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
      const statusPrefix = success ? 'SUCCESS' : 'FAILED';
      const fileName = `apex_log_${statusPrefix}_${nowStr}.txt`;
      const filePath = path.join(LOGS_DIR, fileName);

      const logText = `════════════════════════════════════════════════════════════════
APEX EXECUTOR LOG — ${nowStr}
Status  : ${statusPrefix}
Compiled: ${compiled}
Line    : ${line || 'N/A'}
════════════════════════════════════════════════════════════════

── APEX CODE ──
${code}

── EXECUTION RESULT ──
${success ? 'SUCCESS' : 'FAILED'}
${compileProblem && compileProblem !== 'xsi:nil="true"' ? 'Compile Problem: ' + compileProblem + '\n' : ''}${exceptionMessage && exceptionMessage !== 'xsi:nil="true"' ? 'Exception: ' + exceptionMessage + '\n' : ''}
── DEBUG LOG ──
${debugLog}`;

      fs.writeFileSync(filePath, logText, 'utf8');
      console.log(`[execute] Saved log to server folder: ${fileName}`);
    } catch (fsErr) {
      console.warn('[execute log save warning]', fsErr.message);
    }

    res.json({
      success,
      compiled,
      line,
      column,
      compileProblem:      compileProblem !== 'xsi:nil="true"' ? compileProblem : null,
      exceptionMessage:    exceptionMessage !== 'xsi:nil="true"' ? exceptionMessage : null,
      exceptionStackTrace: exceptionStackTrace !== 'xsi:nil="true"' ? exceptionStackTrace : null,
      logBody: debugLog,
    });

  } catch (err) {
    console.error('[execute error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/saved-logs', (_req, res) => {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.txt'))
      .map(f => {
        try {
          const stat = fs.statSync(path.join(LOGS_DIR, f));
          return { filename: f, mtime: stat.mtime, size: stat.size };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    res.json({ logs: files, folderPath: LOGS_DIR });
  } catch (e) {
    console.error('[saved-logs error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/saved-logs/:filename', (req, res) => {
  try {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(LOGS_DIR, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).send('Log file not found');
    const content = fs.readFileSync(filePath, 'utf8');
    res.type('text/plain').send(content);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /query — SOQL Query Runner
════════════════════════════════════════════════════════════════ */
app.post('/query', async (req, res) => {
  const { query, isTooling = false, sessionId, instanceUrl } = req.body;

  if (!query || !sessionId || !instanceUrl) {
    return res.status(400).json({ error: 'Missing: query, sessionId, or instanceUrl' });
  }

  const base = instanceUrl.replace(/\/$/, '');
  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const endpoint = isTooling ? 'tooling/query' : 'query';
  const url = `${base}/services/data/v66.0/${endpoint}?q=${encodeURIComponent(query)}`;

  try {
    console.log(`[query] Executing SOQL on ${base}: ${query.slice(0, 60)}...`);
    const result = await sfGet(url, headers);

    if (Array.isArray(result)) {
      const e = result[0] || {};
      throw new Error(`${e.errorCode || 'SF_ERROR'}: ${e.message}`);
    }
    if (result.errorCode) {
      throw new Error(`${result.errorCode}: ${result.message}`);
    }

    // Save SOQL log file to server-side logs/ directory
    try {
      const nowStr = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
      const fileName = `soql_log_SUCCESS_${nowStr}.txt`;
      const filePath = path.join(LOGS_DIR, fileName);

      const logText = `════════════════════════════════════════════════════════════════
SOQL QUERY LOG — ${nowStr}
Records : ${result.records ? result.records.length : 0} of ${result.totalSize || 0}
Tooling : ${isTooling}
════════════════════════════════════════════════════════════════

── SOQL QUERY ──
${query}

── RECORDS ──
${JSON.stringify(result.records || [], null, 2)}`;

      fs.writeFileSync(filePath, logText, 'utf8');
      console.log(`[query] Saved log to server folder: ${fileName}`);
    } catch (fsErr) {
      console.warn('[query log save warning]', fsErr.message);
    }

    res.json({
      totalSize: result.totalSize ?? 0,
      done: result.done ?? true,
      records: result.records || [],
    });
  } catch (err) {
    console.error('[query error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /describe — Fetch sObject fields for autocomplete
════════════════════════════════════════════════════════════════ */
const describeCache = {};

app.post('/describe', async (req, res) => {
  const { sobject, sessionId, instanceUrl } = req.body;
  if (!sobject || !sessionId || !instanceUrl) {
    return res.status(400).json({ error: 'Missing sobject, sessionId, or instanceUrl' });
  }

  const sObjName = sobject.trim();
  const cacheKey = `${instanceUrl}_${sObjName.toLowerCase()}`;
  if (describeCache[cacheKey]) {
    return res.json(describeCache[cacheKey]);
  }

  const base = instanceUrl.replace(/\/$/, '');
  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const url = `${base}/services/data/v66.0/sobjects/${sObjName}/describe`;

  try {
    const data = await sfGet(url, headers);
    if (!data.fields) throw new Error(data.message || 'Failed to describe sObject');

    const result = {
      name: data.name,
      label: data.label,
      fields: data.fields.map(f => ({
        name: f.name,
        label: f.label,
        type: f.type,
        relationshipName: f.relationshipName,
      }))
    };
    describeCache[cacheKey] = result;
    res.json(result);
  } catch (err) {
    console.error('[describe error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /sobjects — List all sObjects in org for autocomplete
════════════════════════════════════════════════════════════════ */
const sobjectsCache = {};

app.post('/sobjects', async (req, res) => {
  const { sessionId, instanceUrl } = req.body;
  if (!sessionId || !instanceUrl) {
    return res.status(400).json({ error: 'Missing sessionId or instanceUrl' });
  }

  const cacheKey = instanceUrl;
  if (sobjectsCache[cacheKey]) {
    return res.json(sobjectsCache[cacheKey]);
  }

  const base = instanceUrl.replace(/\/$/, '');
  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const url = `${base}/services/data/v66.0/sobjects/`;

  try {
    const data = await sfGet(url, headers);
    if (!data.sobjects) throw new Error('Failed to list sObjects');

    const result = data.sobjects.map(o => ({
      name: o.name,
      label: o.label,
      custom: o.custom,
      queryable: o.queryable
    })).filter(o => o.queryable);

    sobjectsCache[cacheKey] = result;
    res.json(result);
  } catch (err) {
    console.error('[sobjects error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /logout
════════════════════════════════════════════════════════════════ */
app.post('/logout', async (req, res) => {
  try {
    const { sessionId, instanceUrl } = req.body;
    await fetch(`${(instanceUrl||'').replace(/\/$/,'')}/services/oauth2/revoke?token=${sessionId}`);
  } catch (_) {}
  res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════
   Helpers
════════════════════════════════════════════════════════════════ */
async function sfGet(url, headers) {
  const r = await fetch(url, { headers });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) return r.json();
  return { _text: await r.text() };
}

function extractXml(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

async function ensureTraceFlag(API, headers, userId, category, level) {
  const sfLevel = level.toUpperCase();
  const exp15   = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const existing = await sfGet(
    `${API}/tooling/query?q=SELECT+Id,DebugLevelId+FROM+TraceFlag+WHERE+TracedEntityId='${userId}'+AND+LogType='USER_DEBUG'`,
    headers
  );

  if (existing.records && existing.records.length > 0) {
    const tf = existing.records[0];
    await fetch(`${API}/tooling/sobjects/DebugLevel/${tf.DebugLevelId}`, {
      method: 'PATCH', headers: { ...headers },
      body: JSON.stringify({ ApexCode: sfLevel, System: sfLevel, Callout: 'INFO', Database: 'INFO', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', ApexProfiling: 'NONE' }),
    });
    await fetch(`${API}/tooling/sobjects/TraceFlag/${tf.Id}`, {
      method: 'PATCH', headers: { ...headers },
      body: JSON.stringify({ ExpirationDate: exp15 }),
    });
    return;
  }

  const dlResp = await fetch(`${API}/tooling/sobjects/DebugLevel/`, {
    method: 'POST', headers: { ...headers },
    body: JSON.stringify({ DeveloperName: 'ApexExec_' + Date.now(), MasterLabel: 'Apex Executor', ApexCode: sfLevel, System: sfLevel, Callout: 'INFO', Database: 'INFO', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', ApexProfiling: 'NONE' }),
  });
  const dl = await dlResp.json();

  await fetch(`${API}/tooling/sobjects/TraceFlag/`, {
    method: 'POST', headers: { ...headers },
    body: JSON.stringify({ TracedEntityId: userId, DebugLevelId: dl.id, LogType: 'USER_DEBUG', ExpirationDate: exp15 }),
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ════════════════════════════════════════════════════════════════
   Start
════════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║    Apex Executor Server — http://localhost:' + PORT + '        ║');
  console.log('  ║    Auth: SOAP Login  +  OAuth 2.0 (Login with SF)   ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  ▶  Open: http://localhost:' + PORT + '/apex-executor.html');
  console.log('');
});
