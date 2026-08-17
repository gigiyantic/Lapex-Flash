/**
 * Lapex Flash — Remote Node.js Server
 * ─────────────────────────────────────
 * High Performance & Hardened Architecture
 *   - Security: SSRF validation, XML escaping, Security Headers
 *   - Speed: Persistent HTTP/HTTPS connection pooling, LRU/TTL Describe Caching
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Connection Pooling Agents ── */
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });

async function sfFetch(url, options = {}) {
  const isHttps = url.startsWith('https:');
  const agent = isHttps ? httpsAgent : httpAgent;
  return fetch(url, { ...options, agent });
}

/* ── Security Headers ── */
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

/* ── SSRF Validation ── */
function validateInstanceUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    
    const isSfDomain = host.endsWith('.salesforce.com') ||
                       host.endsWith('.force.com') ||
                       host.endsWith('.cloudforce.com') ||
                       host.endsWith('.salesforce-setup.com') ||
                       host.endsWith('.site.com') ||
                       host.endsWith('.vf.force.com') ||
                       host.endsWith('.trailblazer.force.com');
    if (!isSfDomain) return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
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

/* ── Memory Cache TTL & LRU ── */
const CACHE_TTL_MS = 60 * 60 * 1000;
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

/* ── Load OAuth config ── */
let oauthCfg = {};
try {
  oauthCfg = require('./oauth-config.json');
  if (process.env.SF_CLIENT_ID) oauthCfg.client_id = process.env.SF_CLIENT_ID;
  if (process.env.SF_CLIENT_SECRET) oauthCfg.client_secret = process.env.SF_CLIENT_SECRET;
} catch(_) {}

const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`;

app.get('/oauth/config', (_req, res) => {
  const ready = !!(oauthCfg.client_id && oauthCfg.client_secret && !oauthCfg.client_id.includes('PASTE'));
  res.json({ ready });
});

app.get('/oauth/start', (req, res) => {
  if (!oauthCfg.client_id || oauthCfg.client_id.includes('PASTE')) {
    return res.status(400).send(`<h2>OAuth not configured</h2><p>Please configure client_id and client_secret in environment variables.</p>`);
  }

  const env       = req.query.env || 'login';
  const loginHost = env === 'test' ? 'https://test.salesforce.com' : 'https://login.salesforce.com';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     oauthCfg.client_id,
    redirect_uri:  REDIRECT_URI,
    scope:         'api web refresh_token offline_access',
    state:         env,
    prompt:        'login select_account',
  });

  res.redirect(`${loginHost}/services/oauth2/authorize?${params}`);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/apex-executor.html?oauth_error=${encodeURIComponent(error_description || error)}`);
  }

  const env       = state || 'login';
  const loginHost = env === 'test' ? 'https://test.salesforce.com' : 'https://login.salesforce.com';

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
    if (token.error) return res.redirect(`/apex-executor.html?oauth_error=${encodeURIComponent(token.error_description || token.error)}`);

    const userResp = await sfFetch(`${token.instance_url}/services/oauth2/userinfo`, {
      headers: { 'Authorization': `Bearer ${token.access_token}` },
    });
    const userInfo = await userResp.json();

    const sessionPayload = encodeURIComponent(JSON.stringify({
      sessionId:   token.access_token,
      instanceUrl: token.instance_url,
      userName:    userInfo.email || userInfo.preferred_username || '',
      displayName: userInfo.name  || userInfo.email || '',
      orgName:     userInfo.organization_id || '',
    }));

    res.redirect(`/apex-executor.html#oauth=${sessionPayload}`);
  } catch (err) {
    res.redirect(`/apex-executor.html?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/login', async (req, res) => {
  let { username, password, securityToken = '', environment = 'login', apiVersion = '66.0' } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'Username and password required.' });

  const loginHost = environment === 'test' ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
  const soapUrl = `${loginHost}/services/Soap/u/${apiVersion}`;

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${xmlEsc(username)}</n1:username>
      <n1:password>${xmlEsc(password + securityToken)}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`;

  try {
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

    const instanceUrl = serverUrl ? serverUrl.replace(/\/services\/Soap\/.*$/, '') : loginHost;
    res.json({ ok: true, sessionId, instanceUrl, userId, userName, orgName, displayName });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Network error: ' + err.message });
  }
});

app.post('/verify', async (req, res) => {
  const { sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);
  if (!sessionId || !base) return res.status(400).json({ ok: false, error: 'Valid Session ID and Instance URL required.' });

  try {
    const me = await sfGet(`${base}/services/oauth2/userinfo`, { 'Authorization': `Bearer ${sessionId}` });
    if (me && !me.error && (me.name || me.email)) {
      return res.json({ ok: true, name: me.name || me.email, email: me.email, orgId: me.organization_id || '' });
    }
    const limits = await sfGet(`${base}/services/data/v66.0/limits`, { 'Authorization': `Bearer ${sessionId}` });
    if (limits && !limits.error && limits.DailyApiRequests) {
      return res.json({ ok: true, name: 'Salesforce User', email: '', orgId: 'Connected Org' });
    }
    res.json({ ok: false, error: me?.error_description || me?.error || limits?.error || 'Invalid session ID or URL.' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/execute', async (req, res) => {
  const { code, category = 'Apex_code', level = 'Debug', sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);
  if (!code || !sessionId || !base) return res.status(400).json({ error: 'Missing or invalid: code, sessionId, or instanceUrl' });

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
    const resp = await sfFetch(soapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '""' },
      body: soapBody,
    });
    const xml = await resp.text();

    if (xml.includes('<faultcode>') || xml.includes(':Fault>')) {
      const fault = extractXml(xml, 'faultstring') || extractXml(xml, 'faultcode') || 'Execution failed';
      if (fault.includes('INVALID_SESSION_ID')) return res.status(401).json({ error: 'Session expired — please log in again.' });
      throw new Error(fault);
    }

    const compiled    = extractXml(xml, 'compiled') === 'true';
    const success     = extractXml(xml, 'success') === 'true';
    const lineVal     = parseInt(extractXml(xml, 'line') || '-1', 10);
    const colVal      = parseInt(extractXml(xml, 'column') || '-1', 10);
    const compileProblem      = extractXml(xml, 'compileProblem');
    const exceptionMessage    = extractXml(xml, 'exceptionMessage');
    const exceptionStackTrace = extractXml(xml, 'exceptionStackTrace');
    const debugLog            = extractXml(xml, 'debugLog') || '';

    res.json({
      success, compiled,
      line: lineVal > 0 ? lineVal : null,
      column: colVal > 0 ? colVal : null,
      compileProblem: compileProblem !== 'xsi:nil="true"' ? compileProblem : null,
      exceptionMessage: exceptionMessage !== 'xsi:nil="true"' ? exceptionMessage : null,
      exceptionStackTrace: exceptionStackTrace !== 'xsi:nil="true"' ? exceptionStackTrace : null,
      logBody: debugLog,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/query', async (req, res) => {
  const { query, isTooling = false, sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);
  if (!query || !sessionId || !base) return res.status(400).json({ error: 'Missing or invalid: query, sessionId, or instanceUrl' });

  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const endpoint = isTooling ? 'tooling/query' : 'query';
  const url = `${base}/services/data/v66.0/${endpoint}?q=${encodeURIComponent(query)}`;

  try {
    const result = await sfGet(url, headers);
    if (Array.isArray(result)) throw new Error(`${result[0]?.errorCode || 'SF_ERROR'}: ${result[0]?.message}`);
    if (result.errorCode) throw new Error(`${result.errorCode}: ${result.message}`);

    res.json({
      totalSize: result.totalSize ?? 0,
      done: result.done ?? true,
      records: result.records || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/describe', async (req, res) => {
  const { sobject, sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);
  if (!sobject || !sessionId || !base) return res.status(400).json({ error: 'Missing or invalid parameters' });

  const sObjName = sobject.trim();
  const cacheKey = `${base}_${sObjName.toLowerCase()}`;
  const cached = getCacheItem(describeCache, cacheKey);
  if (cached) return res.json(cached);

  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const url = `${base}/services/data/v66.0/sobjects/${encodeURIComponent(sObjName)}/describe`;

  try {
    const data = await sfGet(url, headers);
    if (!data.fields) throw new Error(data.message || 'Failed to describe sObject');

    const result = {
      name: data.name,
      label: data.label,
      fields: data.fields.map(f => ({ name: f.name, label: f.label, type: f.type, relationshipName: f.relationshipName }))
    };
    setCacheItem(describeCache, cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sobjects', async (req, res) => {
  const { sessionId, instanceUrl } = req.body;
  const base = validateInstanceUrl(instanceUrl);
  if (!sessionId || !base) return res.status(400).json({ error: 'Missing or invalid parameters' });

  const cacheKey = base;
  const cached = getCacheItem(sobjectsCache, cacheKey);
  if (cached) return res.json(cached);

  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const url = `${base}/services/data/v66.0/sobjects/`;

  try {
    const data = await sfGet(url, headers);
    if (!data.sobjects) throw new Error('Failed to list sObjects');

    const result = data.sobjects.map(o => ({ name: o.name, label: o.label, custom: o.custom, queryable: o.queryable })).filter(o => o.queryable);
    setCacheItem(sobjectsCache, cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.listen(PORT, () => {
  console.log(`Lapex Flash Remote Server running on port ${PORT}`);
});
