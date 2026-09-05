/**
 * Lapex Flash — Metadata sync (fetches Apex class/trigger source for the
 * panel's client-side code search). No filesystem access from the service
 * worker — the panel owns persistence (IndexedDB, see db.js).
 */
async function syncMetadata({ sessionId, instanceUrl }) {
  const base    = normalizeBase(instanceUrl);
  const headers = buildAuthHeaders(sessionId);
  const API     = `${base}/services/data/v66.0`;

  const fetchRecords = async (query) => {
    const url  = `${API}/tooling/query?q=${encodeURIComponent(query)}`;
    const data = await sfFetchJson(url, { headers });
    if (data.errorCode) throw new Error(`${data.errorCode}: ${data.message}`);
    return data.records || [];
  };

  const [classRecords, triggerRecords] = await Promise.all([
    fetchRecords("SELECT Name, Body FROM ApexClass WHERE NamespacePrefix=null AND Status='Active'"),
    fetchRecords("SELECT Name, Body FROM ApexTrigger WHERE NamespacePrefix=null AND Status='Active'"),
  ]);

  return {
    classes:  classRecords.map(r => ({ name: r.Name, body: r.Body || '' })),
    triggers: triggerRecords.map(r => ({ name: r.Name, body: r.Body || '' })),
  };
}
