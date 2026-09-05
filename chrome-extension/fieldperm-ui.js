/**
 * Lapex Flash — Field Permissions checker.
 * Queries FieldPermissions to show which Profiles/Permission Sets can
 * read/edit a given sObject field. Reuses the existing QUERY message
 * type — no new background.js handler needed.
 */
function sqlEscape(s) {
  return s.replace(/'/g, "\\'");
}

async function checkFieldPerms() {
  const sobject = document.getElementById('fp-sobject').value.trim();
  const field = document.getElementById('fp-field').value.trim();
  if (!sobject || !field) {
    await showAlert('Enter both Object and Field (e.g. Account and Account.Industry)');
    return;
  }
  if (!SF.sessionId) { showNC('Session lost. Re-detecting…'); refreshSession(); return; }

  const query = `SELECT SobjectType, Field, PermissionsRead, PermissionsEdit, Parent.Profile.Name, Parent.Name, Parent.Label FROM FieldPermissions WHERE SobjectType='${sqlEscape(sobject)}' AND Field='${sqlEscape(field)}'`;

  const btn = document.getElementById('btn-exec'); btn.disabled = true;
  setStatus('sb-run', 'Checking Perms…', true);
  document.getElementById('out-body').innerHTML = '<div class="empty-state"><div class="empty-ico">⏳</div><span>Checking Field Permissions via Tooling API…</span></div>';
  document.getElementById('btn-dl').style.display = 'none';

  const t0 = Date.now();

  try {
    const data = await msg('QUERY', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, query, isTooling: false });
    if (data.error) throw new Error(data.error);

    let html = `<div style="margin-bottom:8px;font-size:13px;color:var(--blue);font-weight:700;">Field Permissions: ${esc(field)}</div>`;
    if (data.records.length === 0) {
      html += `<div class="banner b-info">ℹ️ No FieldPermissions records found for this object/field.</div>`;
    } else {
      html += `<div class="result-table-wrap"><table class="data-table"><thead><tr><th>Profile / PermSet</th><th>Read</th><th>Edit</th></tr></thead><tbody>`;
      data.records.forEach(rec => {
        const name = rec.Parent.Profile ? `Profile: ${rec.Parent.Profile.Name}` : `PermSet: ${rec.Parent.Label || rec.Parent.Name}`;
        html += `<tr><td>${esc(name)}</td><td>${rec.PermissionsRead ? '✅' : '❌'}</td><td>${rec.PermissionsEdit ? '✅' : '❌'}</td></tr>`;
      });
      html += `</tbody></table></div>`;
    }

    document.getElementById('out-body').innerHTML = html;
    setStatus('sb-ok', `✓ Found ${data.records.length} grant${data.records.length === 1 ? '' : 's'}`);

    pushHistoryEntry({
      kind: 'fieldperm', tabName: tabs[activeTabId]?.name, code: `${sobject}.${field}`, success: true,
      elapsedMs: Date.now() - t0, meta: { sobject, field },
      preview: `${data.records.length} permission grant(s)`,
    });
  } catch (err) {
    document.getElementById('out-body').innerHTML = `<div class="banner b-err">❌ ${esc(err.message)}</div>`;
    setStatus('sb-err', '✗ Error');
    pushHistoryEntry({
      kind: 'fieldperm', tabName: tabs[activeTabId]?.name, code: `${sobject}.${field}`, success: false,
      elapsedMs: Date.now() - t0, meta: { sobject, field }, preview: err.message.slice(0, 500),
    });
  } finally {
    btn.disabled = false;
  }
}
