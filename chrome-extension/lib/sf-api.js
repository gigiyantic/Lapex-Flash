/**
 * Lapex Flash — Shared Salesforce API helpers
 * Loaded into the background service worker via importScripts().
 */

function normalizeBase(instanceUrl) {
  return instanceUrl.replace(/\/$/, '');
}

function buildAuthHeaders(sessionId) {
  return { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' };
}

async function sfFetchJson(url, options = {}) {
  const r = await fetch(url, options);
  return r.json();
}

/** Throws if a Salesforce REST/Tooling response is an error shape. */
function parseSfError(result) {
  if (Array.isArray(result)) {
    const e = result[0] || {};
    throw new Error(`${e.errorCode || 'SF_ERROR'}: ${e.message || 'Unknown error'}`);
  }
  if (result && result.errorCode) {
    throw new Error(`${result.errorCode}: ${result.message}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
