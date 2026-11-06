/**
 * Lapex Flash — Smart Permissions.
 * Type a user's name and see every source granting them access: profile,
 * permission sets, permission set groups (with what's inside them), public
 * groups, queues and role. Reuses the existing QUERY message — no new
 * background handler needed.
 */
const PERM_USER_LIMIT = 25;

/** Runs a SOQL query, returning [] instead of throwing — one unsupported
    object (older org, missing PermissionSetGroup) shouldn't sink the
    whole report. */
async function permQuery(soql) {
  const data = await msg('QUERY', {
    sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, query: soql, isTooling: false,
  });
  if (data.error) throw new Error(data.error);
  return data.records || [];
}
async function permQuerySafe(soql) {
  try { return await permQuery(soql); } catch (_) { return []; }
}

function permBody() { return document.getElementById('perm-body'); }

function permStatus(html) { permBody().innerHTML = html; }

async function runPermissionLookup() {
  const term = document.getElementById('perm-input').value.trim();
  if (!term) { document.getElementById('perm-input').focus(); return; }
  if (!SF.sessionId) { showNC('Session lost. Re-detecting…'); refreshSession(); return; }

  const btn = document.getElementById('btn-perm-search');
  btn.disabled = true;
  permStatus('<div class="empty-state"><div class="empty-ico">⏳</div><span>Looking up users…</span></div>');

  try {
    const like = `%${sqlEscape(term)}%`;
    const users = await permQuery(
      `SELECT Id, Name, Username, Email, IsActive, UserType, Profile.Name, UserRole.Name
       FROM User
       WHERE Name LIKE '${like}' OR Username LIKE '${like}' OR Email LIKE '${like}'
       ORDER BY IsActive DESC, Name LIMIT ${PERM_USER_LIMIT}`.replace(/\s+/g, ' ')
    );

    if (users.length === 0) {
      permStatus(`<div class="banner b-info">ℹ️ No user matched “${esc(term)}”.</div>`);
      return;
    }
    if (users.length === 1) { await showUserPermissions(users[0]); return; }
    renderUserPicker(users);
  } catch (err) {
    permStatus(`<div class="banner b-err">❌ ${esc(err.message)}</div>`);
  } finally {
    btn.disabled = false;
  }
}

function renderUserPicker(users) {
  const rows = users.map(u => `
    <button class="perm-pick" data-id="${esc(u.Id)}">
      <span class="perm-pick-name">${esc(u.Name)}${u.IsActive ? '' : ' <span class="perm-chip perm-chip-off">Inactive</span>'}</span>
      <span class="perm-pick-sub">${esc(u.Username)} · ${esc(u.Profile ? u.Profile.Name : '—')}</span>
    </button>`).join('');

  permBody().innerHTML = `<div class="perm-picker"><div class="perm-sec-head">${users.length} users matched — pick one</div>${rows}</div>`;
  permBody().querySelectorAll('.perm-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const user = users.find(u => u.Id === btn.dataset.id);
      if (user) showUserPermissions(user);
    });
  });
}

async function showUserPermissions(user) {
  permStatus('<div class="empty-state"><div class="empty-ico">⏳</div><span>Tracing access sources…</span></div>');

  const uid = sqlEscape(user.Id);
  const [assignments, memberships] = await Promise.all([
    permQuerySafe(
      `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile,
              PermissionSetGroupId, PermissionSetGroup.MasterLabel
       FROM PermissionSetAssignment WHERE AssigneeId = '${uid}'`.replace(/\s+/g, ' ')
    ),
    permQuerySafe(
      `SELECT GroupId, Group.Name, Group.DeveloperName, Group.Type
       FROM GroupMember WHERE UserOrGroupId = '${uid}'`.replace(/\s+/g, ' ')
    ),
  ]);

  // Profile-backing permission sets are an implementation detail, not a grant.
  const real = assignments.filter(a => !(a.PermissionSet && a.PermissionSet.IsOwnedByProfile));
  const viaGroup = real.filter(a => a.PermissionSetGroupId);
  const direct   = real.filter(a => !a.PermissionSetGroupId);

  const groupIds = [...new Set(viaGroup.map(a => a.PermissionSetGroupId))];
  let components = [];
  if (groupIds.length) {
    const inList = groupIds.map(id => `'${sqlEscape(id)}'`).join(',');
    components = await permQuerySafe(
      `SELECT PermissionSetGroupId, PermissionSet.Label, PermissionSet.Name
       FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN (${inList})`.replace(/\s+/g, ' ')
    );
  }

  renderPermissionReport(user, { direct, viaGroup, components, memberships });
}

function permSection(icon, title, count, rowsHtml, emptyText) {
  return `
    <div class="perm-sec">
      <div class="perm-sec-head">${icon} ${esc(title)}${count !== null ? ` <span class="perm-count">${count}</span>` : ''}</div>
      ${rowsHtml || `<div class="perm-empty">${esc(emptyText)}</div>`}
    </div>`;
}

function permRow(label, sub, tag) {
  return `<div class="perm-row">
    <div class="perm-row-main">
      <div class="perm-row-label">${esc(label)}</div>
      ${sub ? `<div class="perm-row-sub">${esc(sub)}</div>` : ''}
    </div>
    ${tag ? `<span class="perm-chip">${esc(tag)}</span>` : ''}
  </div>`;
}

const GROUP_TYPE_LABEL = { Regular: 'Public Group', Queue: 'Queue', Role: 'Role', RoleAndSubordinates: 'Role + Subs' };

function renderPermissionReport(user, { direct, viaGroup, components, memberships }) {
  const profileName = user.Profile ? user.Profile.Name : null;
  const roleName    = user.UserRole ? user.UserRole.Name : null;

  const groupsById = new Map();
  viaGroup.forEach(a => {
    const id = a.PermissionSetGroupId;
    if (!groupsById.has(id)) {
      groupsById.set(id, { label: a.PermissionSetGroup ? a.PermissionSetGroup.MasterLabel : id, sets: [] });
    }
  });
  components.forEach(c => {
    const g = groupsById.get(c.PermissionSetGroupId);
    if (g && c.PermissionSet) g.sets.push(c.PermissionSet.Label || c.PermissionSet.Name);
  });

  const totalSources = (profileName ? 1 : 0) + groupsById.size + direct.length + memberships.length + (roleName ? 1 : 0);

  const psgRows = [...groupsById.values()].map(g => `
    <div class="perm-row perm-row-stack">
      <div class="perm-row-main">
        <div class="perm-row-label">${esc(g.label)}</div>
        <div class="perm-row-sub">${g.sets.length ? esc(g.sets.join(' · ')) : 'Contents unavailable'}</div>
      </div>
      <span class="perm-chip">${g.sets.length} set${g.sets.length === 1 ? '' : 's'}</span>
    </div>`).join('');

  const directRows = direct.map(a => {
    const ps = a.PermissionSet || {};
    return permRow(ps.Label || ps.Name || a.PermissionSetId, ps.Label && ps.Name !== ps.Label ? ps.Name : '', 'Direct');
  }).join('');

  const memberRows = memberships.map(m => {
    const g = m.Group || {};
    return permRow(g.Name || g.DeveloperName || m.GroupId, g.DeveloperName || '', GROUP_TYPE_LABEL[g.Type] || g.Type);
  }).join('');

  permBody().innerHTML = `
    <div class="perm-user">
      <div class="perm-user-name">${esc(user.Name)}
        <span class="perm-chip ${user.IsActive ? 'perm-chip-on' : 'perm-chip-off'}">${user.IsActive ? 'Active' : 'Inactive'}</span>
      </div>
      <div class="perm-user-sub">${esc(user.Username)}</div>
      <div class="perm-user-sub">${totalSources} access source${totalSources === 1 ? '' : 's'} found</div>
    </div>

    ${permSection('🧩', 'Profile', null, profileName ? permRow(profileName, 'Base profile — every user has exactly one', 'Profile') : '', 'No profile found')}
    ${permSection('🎛', 'Permission Set Groups', groupsById.size, psgRows, 'No permission set groups assigned')}
    ${permSection('🔑', 'Permission Sets', direct.length, directRows, 'No permission sets assigned directly')}
    ${permSection('👥', 'Groups & Queues', memberships.length, memberRows, 'Not a member of any public group or queue')}
    ${permSection('🏢', 'Role', null, roleName ? permRow(roleName, 'Grants record access through the role hierarchy', 'Role') : '', 'No role assigned')}
  `;
}
