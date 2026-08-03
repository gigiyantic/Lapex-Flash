/**
 * Apex Executor — Chrome Extension Background Service Worker
 * ──────────────────────────────────────────────────────────
 * THE MAGIC: Chrome extensions can read browser cookies directly.
 * We read the Salesforce 'sid' cookie → instant session, zero login.
 *
 * All Salesforce API calls happen here (no CORS because host_permissions
 * in manifest.json grants us permission to call *.salesforce.com directly).
 */

/* ── Open side panel when extension icon is clicked ── */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (_) {
    // Fallback for older Chrome: open as new tab
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
  }
});

/* ── Message handler ── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // keep channel open for async
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'GET_SESSION': return getSession();
    case 'VERIFY':      return verifySession(msg.sessionId, msg.instanceUrl);
    case 'EXECUTE':     return executeApex(msg);
    default:            throw new Error('Unknown: ' + msg.type);
  }
}

/* ════════════════════════════════════════════════════════════
   GET SESSION — reads the 'sid' cookie from Salesforce tabs
   This is how Lightning Studio and other SF extensions do it!
════════════════════════════════════════════════════════════ */
async function getSession() {
  // Step 1: Find an open Salesforce tab to know the instance URL
  const allTabs = await chrome.tabs.query({});
  const sfTab = allTabs.find(t =>
    t.url && /https?:\/\/[^/]+\.(salesforce|force)\.com/.test(t.url)
  );

  if (sfTab) {
    try {
      const url      = new URL(sfTab.url);
      const instUrl  = `${url.protocol}//${url.hostname}`;
      const cookie   = await chrome.cookies.get({ url: instUrl, name: 'sid' });

      if (cookie?.value) {
        // Verify it's still valid
        const info = await getUserInfo(instUrl, cookie.value);
        if (!info.error) {
          return {
            found:       true,
            sessionId:   cookie.value,
            instanceUrl: instUrl,
            name:        info.name,
            email:       info.email,
            orgId:       info.organization_id,
            autoDetected: true,
            sfTabTitle:  sfTab.title,
          };
        }
      }
    } catch (_) {}
  }

  // Step 2: Fallback — search ALL cookies for a salesforce.com 'sid'
  const allSfCookies = await chrome.cookies.getAll({ name: 'sid' });
  const sfCookie = allSfCookies.find(c =>
    c.domain.includes('salesforce.com') || c.domain.includes('force.com')
  );

  if (sfCookie) {
    const domain  = sfCookie.domain.replace(/^\./, '');
    const instUrl = `https://${domain}`;
    const info    = await getUserInfo(instUrl, sfCookie.value);
    if (!info.error) {
      return {
        found:       true,
        sessionId:   sfCookie.value,
        instanceUrl: instUrl,
        name:        info.name,
        email:       info.email,
        orgId:       info.organization_id,
        autoDetected: true,
      };
    }
  }

  return { found: false, error: 'No active Salesforce session found.\nPlease open Salesforce in a browser tab first.' };
}

async function getUserInfo(instanceUrl, sessionId) {
  try {
    const r = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
      headers: { 'Authorization': `Bearer ${sessionId}` },
    });
    return r.json();
  } catch (_) { return { error: 'network' }; }
}

async function verifySession(sessionId, instanceUrl) {
  const info = await getUserInfo(instanceUrl, sessionId);
  if (info.error) return { ok: false, error: info.error_description || info.error };
  return { ok: true, name: info.name, email: info.email, orgId: info.organization_id };
}

/* ════════════════════════════════════════════════════════════
   EXECUTE ANONYMOUS — calls Salesforce Tooling API directly
   No CORS issue: host_permissions in manifest grants access
════════════════════════════════════════════════════════════ */
async function executeApex({ sessionId, instanceUrl, code, category, level }) {
  const base    = instanceUrl.replace(/\/$/, '');
  const headers = { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
  const API     = `${base}/services/data/v66.0`;

  // Get user ID
  const me = await getUserInfo(base, sessionId);
  if (me.error) throw new Error('Session expired — open Salesforce tab and try again.');
  const userId = me.user_id || (me.id || '').split('/').pop();

  // Set up trace flag
  await ensureTraceFlag(API, headers, userId, level || 'DEBUG');

  // Execute Anonymous
  const execResult = await fetch(
    `${API}/tooling/executeAnonymous/?anonymousBody=${encodeURIComponent(code)}`,
    { headers }
  ).then(r => r.json());

  if (Array.isArray(execResult)) {
    throw new Error(`${execResult[0]?.errorCode || 'SF_ERROR'}: ${execResult[0]?.message}`);
  }
  if (execResult.errorCode) throw new Error(`${execResult.errorCode}: ${execResult.message}`);

  // Wait for Salesforce to write the debug log
  await sleep(1800);

  // Fetch latest ApexLog
  let logBody = '';
  const logQ = await fetch(
    `${API}/tooling/query?q=SELECT+Id+FROM+ApexLog+WHERE+Request='Anonymous'+ORDER+BY+StartTime+DESC+LIMIT+1`,
    { headers }
  ).then(r => r.json());

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

  const existing = await fetch(
    `${API}/tooling/query?q=SELECT+Id,DebugLevelId+FROM+TraceFlag+WHERE+TracedEntityId='${userId}'+AND+LogType='USER_DEBUG'`,
    { headers }
  ).then(r => r.json());

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
    body: JSON.stringify({ DeveloperName: 'ApexExt_' + Date.now(), MasterLabel: 'Apex Executor Ext', ApexCode: sfLevel, System: sfLevel, Callout: 'INFO', Database: 'INFO', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', ApexProfiling: 'NONE' }),
  }).then(r => r.json());

  await fetch(`${API}/tooling/sobjects/TraceFlag/`, {
    method: 'POST', headers,
    body: JSON.stringify({ TracedEntityId: userId, DebugLevelId: dl.id, LogType: 'USER_DEBUG', ExpirationDate: exp15 }),
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
