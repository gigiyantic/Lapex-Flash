/**
 * Lapex Flash — sObject listing & describe, for autocomplete.
 * Cached (TTL/LRU) since describe payloads are large and rarely change.
 */
const describeCache = {};
const sobjectsCache = {};

async function listSobjects({ sessionId, instanceUrl }) {
  await hydrateCacheFromStorage(sobjectsCache, 'lf_sobjects_cache');

  const base     = normalizeBase(instanceUrl);
  const cacheKey = base;
  const cached   = getCacheItem(sobjectsCache, cacheKey);
  if (cached) return { sobjects: cached };

  const headers = buildAuthHeaders(sessionId);
  const url     = `${base}/services/data/v66.0/sobjects/`;

  const data = await sfFetchJson(url, { headers });
  if (!data.sobjects) throw new Error(data.message || 'Failed to list sObjects');

  const result = data.sobjects
    .map(o => ({ name: o.name, label: o.label, custom: o.custom, queryable: o.queryable }))
    .filter(o => o.queryable);

  setCacheItem(sobjectsCache, cacheKey, result, 'lf_sobjects_cache');
  return { sobjects: result };
}

async function describeSobject({ sessionId, instanceUrl, sobject }) {
  await hydrateCacheFromStorage(describeCache, 'lf_describe_cache');

  const base      = normalizeBase(instanceUrl);
  const sObjName  = sobject.trim();
  const cacheKey  = `${base}_${sObjName.toLowerCase()}`;
  const cached    = getCacheItem(describeCache, cacheKey);
  if (cached) return cached;

  const headers = buildAuthHeaders(sessionId);
  const url     = `${base}/services/data/v66.0/sobjects/${encodeURIComponent(sObjName)}/describe`;

  const data = await sfFetchJson(url, { headers });
  if (!data.fields) throw new Error(data.message || 'Failed to describe sObject');

  const result = {
    name:   data.name,
    label:  data.label,
    fields: data.fields.map(f => ({
      name: f.name,
      label: f.label,
      type: f.type,
      relationshipName: f.relationshipName,
    })),
  };

  setCacheItem(describeCache, cacheKey, result, 'lf_describe_cache');
  return result;
}
