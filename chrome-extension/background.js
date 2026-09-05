/**
 * Lapex Flash — Chrome Extension Background Service Worker
 * ──────────────────────────────────────────────────────────
 * THE MAGIC: Chrome extensions can read browser cookies directly.
 * We read the Salesforce 'sid' cookie → instant session, zero login.
 *
 * All Salesforce API calls happen here (no CORS because host_permissions
 * in manifest.json grants us permission to call *.salesforce.com directly).
 */

importScripts(
  'lib/sf-api.js',
  'lib/cache.js',
  'lib/apex-api.js',
  'lib/query-api.js',
  'lib/describe-api.js',
  'lib/bulk-api.js',
  'lib/parallel-api.js',
  'lib/metadata-api.js'
);

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
    case 'GET_SESSION':           return getSession();
    case 'VERIFY':                 return verifySession(msg.sessionId, msg.instanceUrl);
    case 'EXECUTE':                 return executeApex(msg);
    case 'QUERY':                   return runQuery(msg);
    case 'QUERY_NEXT':              return runQueryNext(msg);
    case 'LIST_SOBJECTS':           return listSobjects(msg);
    case 'DESCRIBE':                 return describeSobject(msg);
    case 'START_BULK_QUERY':        return startBulkQuery(msg);
    case 'GET_BULK_QUERY_STATUS':   return getBulkQueryStatus(msg);
    case 'DOWNLOAD_BULK_QUERY':     return downloadBulkQuery(msg);
    case 'RUN_PARALLEL_QUERY':      return runParallelQuery(msg);
    case 'SYNC_METADATA':           return syncMetadata(msg);
    default:                        throw new Error('Unknown: ' + msg.type);
  }
}

/* ════════════════════════════════════════════════════════════
   GET SESSION — reads the 'sid' cookie from Salesforce tabs
   - Resolves Lightning/Visualforce hosts to the "core" my.salesforce.com
     domain before calling the API: a session cookie scoped to
     *.lightning.force.com throws "Illegal Session" on direct REST/Tooling
     calls, since Lightning's cookie is API-restricted — the my-domain
     cookie is the one that actually works.
   - Detects every open Salesforce org (not just the first tab found),
     prioritizing the currently-focused tab, so the panel can offer a
     one-click switcher between multiple orgs open at once.
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
    return { instUrl: `https://${host}`, host, subdomain: host.split('.')[0] };
  } catch (_) {
    return null;
  }
}

async function getSession() {
  const allTabs = await chrome.tabs.query({});
  const sfTabs = allTabs.filter(t => t.url && /https?:\/\/[^/]+\.(salesforce|force)\.com/.test(t.url));

  if (sfTabs.length === 0) {
    return { found: false, error: 'No open Salesforce tabs found.\nPlease open your Salesforce org in a browser tab first.' };
  }

  let activeTab = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = t;
  } catch (_) {}

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

      const directCookie = await chrome.cookies.get({ url: core.instUrl, name: 'sid' });
      if (directCookie?.value) candidates.push(directCookie);

      const tabCookie = await chrome.cookies.get({ url: tab.url, name: 'sid' });
      if (tabCookie?.value && !candidates.some(c => c.value === tabCookie.value)) {
        candidates.push(tabCookie);
      }

      const domainMatches = allSfCookies.filter(c =>
        c.domain.includes(core.subdomain) || c.domain.endsWith('.salesforce.com')
      );
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
        if (!candidates.some(c => c.value === dm.value)) candidates.push(dm);
      }

      let validCookie = null, validInfo = null;
      for (const candidate of candidates) {
        const info = await getUserInfo(core.instUrl, candidate.value);
        if (!info.error && (info.name || info.email)) {
          validCookie = candidate;
          validInfo = info;
          break;
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
    return { found: true, ...primary, orgs: detectedOrgs };
  }

  return { found: false, error: 'Could not extract a valid session from your open Salesforce tabs.\nMake sure you are logged in to Salesforce and refresh your tab.' };
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

/* executeApex(), ensureTraceFlag() now live in lib/apex-api.js */
