/**
 * Lapex Flash — Local Node.js Server
 * ─────────────────────────────────────
 * High Performance & Hardened Architecture
 *   - Security: SSRF validation, Path Traversal defense, XML escaping, Security Headers
 *   - Speed: Persistent HTTP/HTTPS connection pooling, LRU/TTL Describe Caching
 *   - Maintenance: Automatic log rotation & non-blocking async search
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const fse     = require('fs-extra');
const glob    = require('glob');

const app  = express();
const PORT = process.env.PORT || 3000;

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/* ── Connection Pooling Agents for Maximum Speed ── */
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });

async function sfFetch(url, options = {}) {
  const isHttps = url.startsWith('https:');
  const agent = isHttps ? httpsAgent : httpAgent;
  return fetch(url, { ...options, agent });
}

/* ── Security Headers & Body Parser ── */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

/* ── SSRF & Path Traversal Validation Helpers ── */
function validateInstanceUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    let clean = url.trim();
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = 'https://' + clean;
    }
    const parsed = new URL(clean);
    if (parsed.protocol !== 'https:') return null;
    let host = parsed.hostname.toLowerCase();
    
    // Auto-fix domain: convert lightning.force.com and vf.force.com to my.salesforce.com for API calls
    if (host.endsWith('.lightning.force.com')) {
      host = host.replace('.lightning.force.com', '.my.salesforce.com');
    } else if (host.endsWith('.vf.force.com')) {
      host = host.replace('.vf.force.com', '.my.salesforce.com');
    }
    
    const isSfDomain = host.endsWith('.salesforce.com') ||
                       host.endsWith('.force.com') ||
                       host.endsWith('.cloudforce.com') ||
                       host.endsWith('.salesforce-setup.com') ||
                       host.endsWith('.site.com');
    if (!isSfDomain) return null;
    return `https://${host}`;
  } catch (_) {
    return null;
  }
}

function validateOrgId(orgId) {
  if (!orgId || typeof orgId !== 'string') return null;
  const clean = orgId.trim();
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(clean)) {
    return clean;
  }
  return null;
}

function xmlEsc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ── Memory Cache with TTL & LRU Eviction ── */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 Hour
const MAX_CACHE_ENTRIES = 500;

const describeCache = {};
const sobjectsCache = {};

function setCacheItem(cacheObj, key, data) {
  const keys = Object.keys(cacheObj);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    keys.slice(0, 50).forEach(k => delete cacheObj[k]);
  }
  cacheObj[key] = { timestamp: Date.now(), data };
}

function getCacheItem(cacheObj, key) {
  const item = cacheObj[key];
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL_MS) {
    delete cacheObj[key];
    return null;
  }
  return item.data;
}

/* ── Log Rotation Cleanup ── */
function cleanOldLogs(maxAgeDays = 7, maxFiles = 200) {
  try {
    if (!fs.existsSync(LOGS_DIR)) return;
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.txt'))
      .map(f => {
        const fp = path.join(LOGS_DIR, f);
        try {
          const stat = fs.statSync(fp);
          return { name: f, path: fp, mtime: stat.mtimeMs };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    files.forEach((file, index) => {
      const isTooOld = (now - file.mtime) > maxAgeMs;
      const isOverCap = index >= maxFiles;
      if (isTooOld || isOverCap) {
        try { fs.unlinkSync(file.path); } catch (_) {}
      }
    });
  } catch (_) {}
}

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

app.get('/oauth/config', (_req, res) => {
  const ready = !!(oauthCfg.client_id && oauthCfg.client_secret
               && !oauthCfg.client_id.includes('PASTE'));
  res.json({ ready });
});

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
    state:         env,
    prompt:        'login select_account',
  });

  const authUrl = `${loginHost}/services/oauth2/authorize?${params}`;
  console.log(`[oauth] Redirecting to ${loginHost} for OAuth…`);
  res.redirect(authUrl);
});

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
    const tokenResp = await sfFetch(`${loginHost}/services/oauth2/token`, {
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

    const userResp = await sfFetch(`${token.instance_url}/services/oauth2/userinfo`, {
      headers: { 'Authorization': `Bearer ${token.access_token}` },
    });
    const userInfo = await userResp.json();

    console.log(`[oauth] ✅ Logged in as ${userInfo.name || userInfo.email} — ${token.instance_url}`);

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
   POST /login  — SOAP username/password
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
    const resp = await sfFetch(soapUrl, {
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
  const base = validateInstanceUrl(instanceUrl);
  if (!sessionId || !base) {
    return res.status(400).json({ ok: false, error: 'Valid Session ID and Salesforce Instance URL are required.' });
  }

  const cleanSid = sessionId.trim().replace(/^["']|["']$/g, '');

  try {
    // 1. Try OAuth userinfo
    const me = await sfGet(`${base}/services/oauth2/userinfo`, {
      'Authorization': `Bearer ${cleanSid}`,
    });
    if (me && !me.error && (me.name || me.email)) {
      return res.json({ ok: true, name: me.name || me.email, email: me.email, orgId: me.organization_id || '' });
    }

    // 2. Try REST API limits
    const limits = await sfGet(`${base}/services/data/v66.0/limits`, {
      'Authorization': `Bearer ${cleanSid}`,
    });
    if (limits && !limits.error && limits.DailyApiRequests) {
      return res.json({ ok: true, name: 'Salesforce User', email: '', orgId: 'Connected Org' });
    }

    // 3. Try SOAP getUserInfo (works with SOAP sid cookies)
    const soapUrl = `${base}/services/Soap/u/66.0`;
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:n1="urn:partner.soap.sforce.com">
  <env:Header>
    <n1:SessionHeader><n1:sessionId>${xmlEsc(cleanSid)}</n1:sessionId></n1:SessionHeader>
  </env:Header>
  <env:Body><n1:getUserInfo/></env:Body>
</env:Envelope>`;

    const soapResp = await sfFetch(soapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': 'getUserInfo' },
      body: soapBody,
    });

    const xml = await soapResp.text();
    if (xml && xml.includes('getUserInfoResponse')) {
      const nameMatch = xml.match(/<userFullName>([^<]+)<\/userFullName>/) || xml.match(/<userName>([^<]+)<\/userName>/);
      const orgMatch  = xml.match(/<organizationName>([^<]+)<\/organizationName>/) || xml.match(/<organizationId>([^<]+)<\/organizationId>/);
      const uName = nameMatch ? nameMatch[1] : 'Salesforce User';
      const oName = orgMatch ? orgMatch[1] : '';
      return res.json({ ok: true, name: uName, email: '', orgId: oName });
    }

    let errMsg = me?.error_description || me?.error || limits?.error;
    if (!errMsg) {
      const faultMatch = xml.match(/<faultstring>([^<]+)<\/faultstring>/);
      if (faultMatch) errMsg = faultMatch[1];
    }

    res.json({ ok: false, error: errMsg || 'Invalid session ID or URL.' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /execute — Apex Anonymous Execution
════════════════════════════════════════════════════════════════ */
app.post('/execute', async (req, res) => {
  const { code, category = 'Apex_code', level = 'Debug', sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);

  if (!code || !sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid: code, sessionId, or instanceUrl' });
  }

  cleanOldLogs();

  const soapUrl = `${base}/services/Soap/s/66.0`;

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
    const resp = await sfFetch(soapUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '""',
      },
      body: soapBody,
    });

    const xml = await resp.text();

    if (xml.includes('<faultcode>') || xml.includes(':Fault>')) {
      const fault = extractXml(xml, 'faultstring') || extractXml(xml, 'faultcode') || 'Execution failed';
      if (fault.includes('INVALID_SESSION_ID')) {
        return res.status(401).json({ error: 'Session expired — please log in again.' });
      }
      throw new Error(fault);
    }

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

    try {
      const nowStr = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
      const statusPrefix = success ? 'SUCCESS' : 'FAILED';
      const fileName = `apex_log_${statusPrefix}_${nowStr}.txt`;
      const filePath = path.join(LOGS_DIR, fileName);

      const logText = `════════════════════════════════════════════════════════════════
LAPEX FLASH LOG — ${nowStr}
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
    cleanOldLogs();
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
    if (!safeName.endsWith('.txt')) return res.status(400).send('Invalid file type');
    const filePath = path.join(LOGS_DIR, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).send('Log file not found');
    const content = fs.readFileSync(filePath, 'utf8');
    res.type('text/plain').send(content);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.delete('/saved-logs/:filename', (req, res) => {
  try {
    const safeName = path.basename(req.params.filename);
    if (!safeName.endsWith('.txt')) return res.status(400).json({ error: 'Invalid file type' });
    const filePath = path.join(LOGS_DIR, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Log file not found' });
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Deleted ${safeName}` });
  } catch (e) {
    console.error('[delete log error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/saved-logs', (_req, res) => {
  try {
    if (fs.existsSync(LOGS_DIR)) {
      const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.txt'));
      files.forEach(f => fs.unlinkSync(path.join(LOGS_DIR, f)));
    }
    res.json({ success: true, message: 'All log files deleted' });
  } catch (e) {
    console.error('[delete all logs error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /query — SOQL Query Runner
════════════════════════════════════════════════════════════════ */
app.post('/query', async (req, res) => {
  const { query, isTooling = false, sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);

  if (!query || !sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid: query, sessionId, or instanceUrl' });
  }

  cleanOldLogs();

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
      nextRecordsUrl: result.nextRecordsUrl || null,
      records: result.records || [],
    });
  } catch (err) {
    console.error('[query error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/query/next', async (req, res) => {
  const { nextRecordsUrl, sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);

  if (!nextRecordsUrl || !sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid: nextRecordsUrl, sessionId, or instanceUrl' });
  }

  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const cleanPath = nextRecordsUrl.startsWith('/') ? nextRecordsUrl : '/' + nextRecordsUrl;
  const url = `${base}${cleanPath}`;

  try {
    const result = await sfGet(url, headers);
    if (Array.isArray(result)) {
      const e = result[0] || {};
      throw new Error(`${e.errorCode || 'SF_ERROR'}: ${e.message}`);
    }
    if (result.errorCode) throw new Error(`${result.errorCode}: ${result.message}`);

    res.json({
      totalSize: result.totalSize ?? 0,
      done: result.done ?? true,
      nextRecordsUrl: result.nextRecordsUrl || null,
      records: result.records || [],
    });
  } catch (err) {
    console.error('[query next error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   BULK API 2.0 QUERY ENDPOINTS (For 50M+ Records Parallel Export)
════════════════════════════════════════════════════════════════ */
app.post('/bulk-query', async (req, res) => {
  const { query, sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);

  if (!query || !sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid: query, sessionId, or instanceUrl' });
  }

  const headers = {
    'Authorization': `Bearer ${sessionId}`,
    'Content-Type': 'application/json'
  };
  const url = `${base}/services/data/v66.0/jobs/query`;

  try {
    console.log(`[bulk-query] Starting Bulk API 2.0 job: ${query.slice(0, 60)}...`);
    const resp = await sfFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation: 'query', query })
    });
    const data = await resp.json();
    if (data.errorCode || data.error) {
      throw new Error(data.message || data.error_description || 'Bulk API error');
    }
    res.json({
      jobId: data.id,
      state: data.state,
      object: data.object,
      createdDate: data.createdDate
    });
  } catch (err) {
    console.error('[bulk-query error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/bulk-query/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { sessionId, instanceUrl } = req.query;
  const base = validateInstanceUrl(instanceUrl);

  if (!jobId || !sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid: jobId, sessionId, or instanceUrl' });
  }

  const headers = { 'Authorization': `Bearer ${sessionId}` };
  const url = `${base}/services/data/v66.0/jobs/query/${jobId}`;

  try {
    const data = await sfGet(url, headers);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/bulk-query/:jobId/download', async (req, res) => {
  const { jobId } = req.params;
  const { sessionId, instanceUrl } = req.query;
  const base = validateInstanceUrl(instanceUrl);

  if (!jobId || !sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  const headers = { 'Authorization': `Bearer ${sessionId}` };
  const url = `${base}/services/data/v66.0/jobs/query/${jobId}/results`;

  try {
    const sfRes = await sfFetch(url, { headers });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bulk_export_${jobId}.csv"`);
    sfRes.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /parallel-query — Strategy 2: Multi-Threaded Parallel Exporter
════════════════════════════════════════════════════════════════ */
app.post('/parallel-query', async (req, res) => {
  const { baseQuery, dateField = 'CreatedDate', startDate, endDate, threads = 8, sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);

  if (!baseQuery || !sessionId || !base || !startDate || !endDate) {
    return res.status(400).json({ error: 'Missing required parameters: baseQuery, startDate, endDate, sessionId, instanceUrl' });
  }

  const numThreads = Math.min(Math.max(parseInt(threads) || 8, 1), 20);
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();

  if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) {
    return res.status(400).json({ error: 'Invalid date range: startDate must be before endDate' });
  }

  const stepMs = (endMs - startMs) / numThreads;
  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };

  console.log(`[parallel-query] Running ${numThreads} parallel worker threads from ${startDate} to ${endDate}`);

  const workerPromises = Array.from({ length: numThreads }, (_, i) => {
    const tStart = new Date(startMs + (i * stepMs)).toISOString();
    const tEnd   = new Date(startMs + ((i + 1) * stepMs)).toISOString();

    let clause = `${dateField} >= ${tStart} AND ${dateField} < ${tEnd}`;
    let subQuery = baseQuery;
    if (/\bWHERE\b/i.test(baseQuery)) {
      subQuery = baseQuery.replace(/\bWHERE\b/i, `WHERE (${clause}) AND `);
    } else if (/\bFROM\s+([a-zA-Z0-9_]+)/i.test(baseQuery)) {
      subQuery = baseQuery.replace(/(\bFROM\s+[a-zA-Z0-9_]+)/i, `$1 WHERE ${clause}`);
    }

    const url = `${base}/services/data/v66.0/query?q=${encodeURIComponent(subQuery)}`;
    return sfGet(url, headers).then(res => ({
      thread: i + 1,
      subQuery,
      totalSize: res.totalSize || 0,
      records: res.records || [],
      error: res.errorCode ? `${res.errorCode}: ${res.message}` : null
    })).catch(err => ({ thread: i + 1, subQuery, error: err.message, records: [] }));
  });

  try {
    const workerResults = await Promise.all(workerPromises);
    let totalRecords = 0;
    let combinedRecords = [];
    let errors = [];

    workerResults.forEach(r => {
      if (r.error) errors.push(`Thread ${r.thread}: ${r.error}`);
      else {
        totalRecords += r.totalSize;
        combinedRecords.push(...r.records);
      }
    });

    res.json({
      success: errors.length === 0,
      threads: numThreads,
      totalRecords,
      fetchedRecords: combinedRecords.length,
      records: combinedRecords,
      errors: errors.length > 0 ? errors : null
    });
  } catch (err) {
    console.error('[parallel-query error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /describe — Fetch sObject fields with TTL/LRU Cache
════════════════════════════════════════════════════════════════ */
app.post('/describe', async (req, res) => {
  const { sobject, sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);

  if (!sobject || !sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid: sobject, sessionId, or instanceUrl' });
  }

  const sObjName = sobject.trim();
  const cacheKey = `${base}_${sObjName.toLowerCase()}`;
  const cached = getCacheItem(describeCache, cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const url = `${base}/services/data/v66.0/sobjects/${encodeURIComponent(sObjName)}/describe`;

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
    setCacheItem(describeCache, cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[describe error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /sobjects — List all sObjects with TTL/LRU Cache
════════════════════════════════════════════════════════════════ */
app.post('/sobjects', async (req, res) => {
  const { sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);

  if (!sessionId || !base) {
    return res.status(400).json({ error: 'Missing or invalid: sessionId or instanceUrl' });
  }

  const cacheKey = base;
  const cached = getCacheItem(sobjectsCache, cacheKey);
  if (cached) {
    return res.json(cached);
  }

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

    setCacheItem(sobjectsCache, cacheKey, result);
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
    const base = validateInstanceUrl(instanceUrl);
    if (base && sessionId) {
      await sfFetch(`${base}/services/oauth2/revoke?token=${encodeURIComponent(sessionId)}`);
    }
  } catch (_) {}
  res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════
   Helpers
════════════════════════════════════════════════════════════════ */
async function sfGet(url, headers) {
  const r = await sfFetch(url, { headers });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) return r.json();
  return { _text: await r.text() };
}

function extractXml(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

/* ════════════════════════════════════════════════════════════════
   Metadata Sync & Non-blocking Workspace Global Search
════════════════════════════════════════════════════════════════ */

app.post('/api/metadata/sync', async (req, res) => {
  const { sessionId, instanceUrl, orgId } = req.body;
  const base = validateInstanceUrl(instanceUrl);
  const safeOrgId = validateOrgId(orgId);

  if (!sessionId || !base || !safeOrgId) {
    return res.status(400).json({ error: 'Missing or invalid parameters (auth, instanceUrl, or orgId)' });
  }

  const API = `${base}/services/data/v66.0`;
  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const wsDir = path.join(__dirname, 'workspace', safeOrgId);

  try {
    await fse.ensureDir(wsDir);
    
    const fetchAndSave = async (query, folderName, nameField, bodyField, ext) => {
      const q = encodeURIComponent(query);
      const url = `${API}/tooling/query?q=${q}`;
      const r = await sfFetch(url, { headers });
      const data = await r.json();
      
      if (data.records && data.records.length > 0) {
        const targetDir = path.join(wsDir, folderName);
        await fse.ensureDir(targetDir);
        for (const rec of data.records) {
          const body = rec[bodyField] || '';
          if (body) {
            await fse.writeFile(path.join(targetDir, `${rec[nameField]}.${ext}`), body, 'utf8');
          }
        }
      }
    };

    await fetchAndSave('SELECT Name, Body FROM ApexClass WHERE NamespacePrefix=null AND Status=\'Active\'', 'classes', 'Name', 'Body', 'cls');
    await fetchAndSave('SELECT Name, Body FROM ApexTrigger WHERE NamespacePrefix=null AND Status=\'Active\'', 'triggers', 'Name', 'Body', 'trigger');

    res.json({ ok: true, message: 'Metadata synced to workspace/' + safeOrgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { query, orgId } = req.body;
  const safeOrgId = validateOrgId(orgId);

  if (!query || !safeOrgId) {
    return res.status(400).json({ error: 'Missing or invalid parameters: query or orgId' });
  }

  const wsDir = path.join(__dirname, 'workspace', safeOrgId);
  if (!fse.existsSync(wsDir)) return res.json({ results: [] });

  try {
    const files = await new Promise((resolve, reject) => {
      glob('**/*.*', { cwd: wsDir, absolute: true }, (err, matches) => {
        if (err) reject(err); else resolve(matches);
      });
    });

    const results = [];
    const queryLower = query.toLowerCase();

    for (const file of files) {
      if (results.length >= 100) break;
      try {
        const content = await fse.readFile(file, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            results.push({
              file: path.relative(wsDir, file),
              line: i + 1,
              text: lines[i].trim()
            });
            if (results.length >= 100) break;
          }
        }
      } catch (_) {}
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   Start Server
════════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║    Lapex Flash Server — http://localhost:' + PORT + '         ║');
  console.log('  ║    Auth: SOAP Login  +  OAuth 2.0 (Login with SF)   ║');
  console.log('  ║    Status: Security Hardened & Performance Optimized║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  ▶  Open: http://localhost:' + PORT + '/apex-executor.html');
  console.log('');
});
