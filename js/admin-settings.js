import { supabase } from './supabase-client.js';

const status = document.querySelector('#settingsStatus');
const profileForm = document.querySelector('#profileForm');
const displayName = document.querySelector('#displayName');
const passwordForm = document.querySelector('#passwordForm');
const newPassword = document.querySelector('#newPassword');
const organisationPanel = document.querySelector('#organisationPanel');
const organisationName = document.querySelector('#organisationName');
const organisationRole = document.querySelector('#organisationRole');
const memberAdminPanel = document.querySelector('#memberAdminPanel');
const inviteForm = document.querySelector('#inviteForm');
const inviteStatus = document.querySelector('#inviteStatus');
const memberDirectory = document.querySelector('#memberDirectory');

let sessionUser = null;
let currentMembership = null;
let isPlatformAdmin = false;

const roleLabels = {
  organisation_owner: 'Organisation owner', delivery_manager: 'Delivery manager', contributor: 'Contributor',
  client_admin: 'Client admin', client_collaborator: 'Client collaborator', viewer: 'Viewer',
};

function setStatus(value = '') { status.textContent = value; }
function setInviteStatus(value = '', kind = '') { inviteStatus.textContent = value; inviteStatus.dataset.kind = kind; }
function one(value) { return Array.isArray(value) ? value[0] || null : value || null; }
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]); }

async function loadSettings() {
  const { data: sessionData } = await supabase.auth.getSession();
  sessionUser = sessionData.session?.user || null;
  if (!sessionUser) return;
  setStatus('Loading settings…');
  try {
    const [{ data: profile, error: profileError }, { data: memberships, error: membershipError }, { data: platform, error: platformError }] = await Promise.all([
      supabase.from('user_profiles').select('display_name,email').eq('user_id', sessionUser.id).maybeSingle(),
      supabase.from('organisation_memberships').select('organisation_id,role,organisations(id,name)').eq('user_id', sessionUser.id),
      supabase.rpc('is_platform_admin'),
    ]);
    if (profileError || membershipError || platformError) throw new Error(profileError?.message || membershipError?.message || platformError?.message);
    displayName.value = profile?.display_name || sessionUser.email?.split('@')[0] || '';
    isPlatformAdmin = platform === true;
    currentMembership = memberships?.[0] || null;
    if (!currentMembership) { setStatus('No organisation membership is assigned to this account.'); return; }
    const organisation = one(currentMembership.organisations);
    organisationName.textContent = organisation?.name || 'Laminar organisation';
    organisationRole.textContent = `Your role: ${roleLabels[currentMembership.role] || currentMembership.role}`;
    organisationPanel.hidden = false;
    const canAdmin = isPlatformAdmin || currentMembership.role === 'organisation_owner' || currentMembership.role === 'delivery_manager';
    memberAdminPanel.hidden = !canAdmin;
    if (canAdmin) await loadMembers();
    setStatus('Settings loaded.');
  } catch (error) { setStatus(error instanceof Error ? error.message : 'Unable to load settings.'); }
}

async function loadMembers() {
  if (!currentMembership) return;
  const [{ data: memberships, error: membershipError }, { data: profiles, error: profileError }] = await Promise.all([
    supabase.from('organisation_memberships').select('user_id,role').eq('organisation_id', currentMembership.organisation_id),
    supabase.from('user_profiles').select('user_id,display_name,email'),
  ]);
  if (membershipError || profileError) throw new Error(membershipError?.message || profileError?.message);
  const profileById = new Map((profiles || []).map(profile => [profile.user_id, profile]));
  const canChangeRoles = isPlatformAdmin || currentMembership.role === 'organisation_owner';
  memberDirectory.innerHTML = (memberships || []).map(member => {
    const profile = profileById.get(member.user_id);
    const name = profile?.display_name || profile?.email || 'Invited member';
    const email = profile?.email || 'Email pending invitation acceptance';
    return `<article class="member-row"><div><strong>${esc(name)}</strong><span>${esc(email)}</span></div><div class="member-actions"><select data-member-role="${esc(member.user_id)}" ${canChangeRoles ? '' : 'disabled'}>${Object.entries(roleLabels).map(([value,label]) => `<option value="${value}" ${member.role === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${canChangeRoles && member.user_id !== sessionUser.id ? `<button class="btn btn-ghost btn-sm" type="button" data-action="member-remove" data-user-id="${esc(member.user_id)}">Remove</button>` : ''}</div></article>`;
  }).join('') || '<p class="project-data-note">No members are assigned.</p>';
}

profileForm.addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    setStatus('Saving profile…');
    const { error } = await supabase.from('user_profiles').update({ display_name: displayName.value.trim() }).eq('user_id', sessionUser?.id);
    setStatus(error ? error.message : 'Profile saved.');
  })();
});

passwordForm?.addEventListener('submit', event => {
  event.preventDefault();
  const password = newPassword.value;
  if (password.length < 12) { setStatus('Use a password with at least 12 characters.'); return; }
  void (async () => {
    setStatus('Saving password…');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setStatus(error.message); return; }
    newPassword.value = '';
    setStatus('Password saved. You can now sign in with email and password.');
  })();
});

inviteForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!currentMembership) return;
  const form = new FormData(inviteForm);
  void (async () => {
    setStatus('Inviting member…');
    setInviteStatus('Sending invitation…');
    const { data, error } = await supabase.functions.invoke('invite-organisation-member', { body: { organisationId: currentMembership.organisation_id, email: form.get('email'), role: form.get('role') } });
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Invitation failed.';
      if (!data?.error && error?.context instanceof Response) {
        try { detail = (await error.context.clone().json())?.error || detail; } catch { /* retain the transport message */ }
      }
      setStatus(detail);
      setInviteStatus(`Invitation failed: ${detail}`, 'error');
      return;
    }
    inviteForm.reset();
    await loadMembers();
    setStatus('Invitation sent and organisation role assigned.');
    setInviteStatus(`Invitation sent to ${data.email}. Add this member to a project after they appear below.`, 'success');
  })();
});

memberDirectory.addEventListener('change', event => {
  const select = event.target.closest('[data-member-role]');
  if (!select || !currentMembership) return;
  void (async () => {
    setStatus('Updating member role…');
    const { error } = await supabase.rpc('set_organisation_member_role', { p_organisation: currentMembership.organisation_id, p_user: select.dataset.memberRole, p_role: select.value });
    if (error) { setStatus(error.message); await loadMembers(); return; }
    setStatus('Member role updated.');
  })();
});

memberDirectory.addEventListener('click', event => {
  const button = event.target.closest('[data-action="member-remove"]');
  if (!button || !currentMembership || !confirm('Remove this member from the organisation? Their project access will no longer be available.')) return;
  void (async () => {
    setStatus('Removing member…');
    const { error } = await supabase.rpc('remove_organisation_member', { p_organisation: currentMembership.organisation_id, p_user: button.dataset.userId });
    if (error) { setStatus(error.message); return; }
    await loadMembers();
    setStatus('Member removed from the organisation.');
  })();
});

supabase.auth.onAuthStateChange((_event, session) => { if (session) void loadSettings(); });
void loadSettings();
