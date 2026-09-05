/**
 * Lapex Flash — Chrome Extension Background Service Worker
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

if (chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  });
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'GET_SESSION': return getSession();
    case 'VERIFY':      return verifySession(msg.sessionId, msg.instanceUrl);
    case 'EXECUTE':     return executeApex(msg);
    default:            throw new Error('Unknown: ' + msg.type);
  }
}

/* ════════════════════════════════════════════════════════════
   GET SESSION — reads the CORE 'sid' cookie from Salesforce tabs
   - Prioritizes active/focused tab
   - Handles MULTIPLE open orgs without cookie/url mixup
   - Converts lightning.force.com to my.salesforce.com to get
     the UNRESTRICTED core API session ID (bypasses "Illegal Session")
════════════════════════════════════════════════════════════ */
function toCoreSalesforceInfo(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let host = u.hostname.toLowerCase();
    if (host.endsWith('.lightning.force.com')) {
      host = host.replace('.lightning.force.com', '.my.salesforce.com');
    } else if (host.endsWith('.vf.force.com')) {
      host = host.replace('.vf.force.com', '.my.salesforce.com');
    }
    return {
      instUrl: `https://${host}`,
      host,
      subdomain: host.split('.')[0] // e.g. "nbx--preprod"
    };
  } catch (_) {
    return null;
  }
}

async function getSession() {
  const allTabs = await chrome.tabs.query({});
  const sfTabs = allTabs.filter(t =>
    t.url && /https?:\/\/[^/]+\.(salesforce|force)\.com/.test(t.url)
  );

  if (sfTabs.length === 0) {
    return { found: false, error: 'No open Salesforce tabs found.\nPlease open your Salesforce org in a browser tab first.' };
  }

  // Check currently active tab to prioritize user's active org
  let activeTab = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = t;
  } catch (_) {}

  // Order tabs: active tab first, then others
  const orderedTabs = [];
  if (activeTab && activeTab.url && /https?:\/\/[^/]+\.(salesforce|force)\.com/.test(activeTab.url)) {
    orderedTabs.push(activeTab);
  }
  for (const t of sfTabs) {
    if (!orderedTabs.some(ot => ot.id === t.id)) orderedTabs.push(t);
  }

  const allSfCookies = await chrome.cookies.getAll({ name: 'sid' });
  const detectedOrgs = [];
  const seenSubdomains = new Set();

  for (const tab of orderedTabs) {
    const core = toCoreSalesforceInfo(tab.url);
    if (!core || seenSubdomains.has(core.subdomain)) continue;

    try {
      const candidates = [];

      // 1. Direct cookie for core.instUrl (e.g. https://nbx--preprod.sandbox.my.salesforce.com)
      const directCookie = await chrome.cookies.get({ url: core.instUrl, name: 'sid' });
      if (directCookie?.value) candidates.push(directCookie);

      // 2. Cookie for tab.url
      if (tab.url) {
        const tabCookie = await chrome.cookies.get({ url: tab.url, name: 'sid' });
        if (tabCookie?.value && !candidates.some(c => c.value === tabCookie.value)) {
          candidates.push(tabCookie);
        }
      }

      // 3. Domain cookies from allSfCookies matching subdomain
      const domainMatches = allSfCookies.filter(c => 
        c.domain.includes(core.subdomain) || c.domain.endsWith('.salesforce.com')
      );

      // Sort domain matches: strictly prioritize non-lightning and non-vf cookies!
      domainMatches.sort((a, b) => {
        const aBad = a.domain.includes('lightning.force.com') || a.domain.includes('vf.force.com');
        const bBad = b.domain.includes('lightning.force.com') || b.domain.includes('vf.force.com');
        if (aBad && !bBad) return 1;
        if (!aBad && bBad) return -1;
        const aSub = a.domain.includes(core.subdomain);
        const bSub = b.domain.includes(core.subdomain);
        if (aSub && !bSub) return -1;
        if (!aSub && bSub) return 1;
        return 0;
      });

      for (const dm of domainMatches) {
        if (!candidates.some(c => c.value === dm.value)) {
          candidates.push(dm);
        }
      }

      // Test candidates against getUserInfo on core.instUrl
      let validCookie = null;
      let validInfo = null;

      for (const candidate of candidates) {
        const info = await getUserInfo(core.instUrl, candidate.value);
        if (!info.error && (info.name || info.email)) {
          validCookie = candidate;
          validInfo = info;
          break; // Found the working session!
        }
      }

      if (validCookie && validInfo) {
        seenSubdomains.add(core.subdomain);
        detectedOrgs.push({
          found: true,
          sessionId: validCookie.value,
          instanceUrl: core.instUrl,
          name: validInfo.name || validInfo.email,
          email: validInfo.email,
          orgId: validInfo.organization_id || '',
          orgName: core.subdomain.toUpperCase(),
          tabTitle: tab.title || core.subdomain,
          tabId: tab.id,
          isActive: tab.id === activeTab?.id,
          autoDetected: true,
        });
      }
    } catch (_) {}
  }

  if (detectedOrgs.length > 0) {
    const primary = detectedOrgs[0];
    return {
      found: true,
      ...primary,
      orgs: detectedOrgs, // list of all open orgs for instant 1-click switching
    };
  }

  return {
    found: false,
    error: 'Could not extract a valid session from your open Salesforce tabs.\nMake sure you are logged in to Salesforce and refresh your tab.'
  };
}

async function getUserInfo(instanceUrl, sessionId) {
  try {
    const cleanUrl = instanceUrl.replace('.lightning.force.com', '.my.salesforce.com');
    const r = await fetch(`${cleanUrl}/services/oauth2/userinfo`, {
      headers: { 'Authorization': `Bearer ${sessionId}` },
    });
    return r.json();
  } catch (_) { return { error: 'network' }; }
}

async function verifySession(sessionId, instanceUrl) {
  const cleanUrl = instanceUrl.replace('.lightning.force.com', '.my.salesforce.com');
  const info = await getUserInfo(cleanUrl, sessionId);
  if (info.error) return { ok: false, error: info.error_description || info.error };
  return { ok: true, name: info.name, email: info.email, orgId: info.organization_id };
}

/* ════════════════════════════════════════════════════════════
   EXECUTE ANONYMOUS — calls Salesforce Tooling API directly
   No CORS issue: host_permissions in manifest grants access
════════════════════════════════════════════════════════════ */
async function executeApex({ sessionId, instanceUrl, code, category, level }) {
  const base    = instanceUrl.replace(/\/$/, '').replace('.lightning.force.com', '.my.salesforce.com').replace('.vf.force.com', '.my.salesforce.com');
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
    body: JSON.stringify({ DeveloperName: 'LapexFlash_' + Date.now(), MasterLabel: 'Lapex Flash Ext', ApexCode: sfLevel, System: sfLevel, Callout: 'INFO', Database: 'INFO', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', ApexProfiling: 'NONE' }),
  }).then(r => r.json());

  await fetch(`${API}/tooling/sobjects/TraceFlag/`, {
    method: 'POST', headers,
    body: JSON.stringify({ TracedEntityId: userId, DebugLevelId: dl.id, LogType: 'USER_DEBUG', ExpirationDate: exp15 }),
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
