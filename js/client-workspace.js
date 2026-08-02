import { supabase } from './supabase-client.js';
import { artifactDownloadUrl } from './artifact-repository.js';

const status = document.querySelector('#clientWorkspaceStatus');
const list = document.querySelector('#clientProjectList');
const detail = document.querySelector('#clientProjectDetail');
const title = document.querySelector('#clientWorkspaceTitle');
const intro = document.querySelector('#clientWorkspaceIntro');
const projectId = new URLSearchParams(location.search).get('project');
const stageOptions = {
  pending: ['in_scope', 'na'], in_scope: ['pending', 'active', 'na', 'blocked'], na: ['in_scope'],
  active: ['client_review', 'complete', 'blocked', 'in_scope', 'na'], blocked: ['na'],
  client_review: ['complete', 'active', 'blocked'], complete: ['delivered', 'active', 'blocked'], delivered: ['complete'],
};
const stageLabels = { pending: 'Pending', in_scope: 'In scope', na: 'N/A', active: 'Active', blocked: 'Blocked', client_review: 'Client review', complete: 'Complete', delivered: 'Delivered' };

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const playbook = row => (Array.isArray(row.playbook_versions) ? row.playbook_versions[0] : row.playbook_versions)?.playbooks;

function setStatus(message) { status.textContent = message; }

function projectCard(project, taskCount, deliverableCount) {
  const pb = playbook(project);
  return `<a class="client-project-card" href="client.html?project=${encodeURIComponent(project.id)}">
    <div class="project-workspace-type">${escapeHtml(pb?.name || 'Laminar project')}</div>
    <h2>${escapeHtml(project.name)}</h2>
    <p>${escapeHtml(project.client_name || '')}</p>
    <div class="project-workspace-meta">${taskCount} action${taskCount === 1 ? '' : 's'} · ${deliverableCount} deliverable${deliverableCount === 1 ? '' : 's'} shared</div>
  </a>`;
}

async function loadList() {
  const { data: projects, error } = await supabase.from('projects').select('id,name,client_name,status,playbook_versions(playbooks(name))').order('updated_at', { ascending: false });
  if (error) return setStatus(error.message);
  const ids = (projects || []).map(project => project.id);
  if (!ids.length) { list.innerHTML = '<p class="projects-empty">No client projects are currently assigned to you.</p>'; return setStatus('No client projects are available.'); }
  const [taskResult, deliverableResult] = await Promise.all([
    supabase.from('project_tasks').select('project_id').in('project_id', ids),
    supabase.from('deliverables').select('project_id').in('project_id', ids),
  ]);
  if (taskResult.error || deliverableResult.error) return setStatus(taskResult.error?.message || deliverableResult.error?.message || 'Unable to load your workspace.');
  const taskCounts = new Map(), deliverableCounts = new Map();
  for (const row of taskResult.data || []) taskCounts.set(row.project_id, (taskCounts.get(row.project_id) || 0) + 1);
  for (const row of deliverableResult.data || []) deliverableCounts.set(row.project_id, (deliverableCounts.get(row.project_id) || 0) + 1);
  list.innerHTML = projects.map(p => projectCard(p, taskCounts.get(p.id) || 0, deliverableCounts.get(p.id) || 0)).join('');
  setStatus(`${projects.length} project${projects.length === 1 ? '' : 's'} available to you.`);
}

async function transition(taskId, next) {
  const { error } = await supabase.rpc('transition_project_task', { p_task: taskId, p_to: next, p_blocked_reason: null, p_client_note: null });
  if (error) { setStatus(error.message); return; }
  await loadDetail();
}

async function approve(deliverableId) {
  const { error } = await supabase.rpc('approve_client_deliverable', { p_deliverable: deliverableId });
  if (error) { setStatus(error.message); return; }
  setStatus('Deliverable approved and recorded in the project audit history.');
  await loadDetail();
}

async function download(projectIdValue, artifactId) {
  try { window.open(await artifactDownloadUrl({ projectId: projectIdValue, artifactId }), '_blank', 'noopener'); }
  catch (error) { setStatus(error.message); }
}

function clientTask(task) {
  const options = (stageOptions[task.stage] || []).filter(next => next !== 'blocked').map(next => `<button class="btn btn-ghost client-action" data-task="${task.id}" data-next="${next}">${stageLabels[next]}</button>`).join('');
  return `<article class="client-action-row"><div><span class="stage-pill stage-${task.stage.replace('_', '-')}">${stageLabels[task.stage]}</span><strong>${escapeHtml(task.title)}</strong>${task.due_on ? `<small>Due ${escapeHtml(task.due_on)}</small>` : ''}</div><div class="client-action-options">${options || '<span class="workspace-status">No action required</span>'}</div></article>`;
}

async function loadDetail() {
  const { data: project, error } = await supabase.from('projects').select('id,name,client_name,status,playbook_versions(playbooks(name))').eq('id', projectId).maybeSingle();
  if (error || !project) { setStatus(error?.message || 'This project is not available to you.'); return; }
  const [taskResult, deliverableResult, artifactResult, trainingResult] = await Promise.all([
    supabase.from('project_tasks').select('id,title,stage,due_on').eq('project_id', projectId).order('due_on', { ascending: true, nullsFirst: false }),
    supabase.from('deliverables').select('id,title,status,approved_at').eq('project_id', projectId).order('title'),
    supabase.from('artifacts').select('id,title,visibility,status,created_at').eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase.from('training_records').select('id,stable_key,status,signed_off_at').eq('project_id', projectId).order('stable_key'),
  ]);
  const failure = [taskResult, deliverableResult, artifactResult, trainingResult].find(result => result.error);
  if (failure) return setStatus(failure.error.message);
  title.textContent = project.name; intro.textContent = `${playbook(project)?.name || 'Laminar project'} · shared client workspace.`;
  list.hidden = true; detail.hidden = false;
  const tasks = taskResult.data || [], deliverables = deliverableResult.data || [], artifacts = artifactResult.data || [], training = trainingResult.data || [];
  detail.innerHTML = `<a class="project-back" href="client.html">‹ All client projects</a>
    <div class="client-detail-grid">
      <section class="project-workspace-panel"><div class="section-label">Your actions</div><div class="client-action-list">${tasks.length ? tasks.map(clientTask).join('') : '<p class="projects-empty">No client actions are waiting for you.</p>'}</div></section>
      <section class="project-workspace-panel"><div class="section-label">Deliverables</div><div class="client-deliverable-list">${deliverables.length ? deliverables.map(row => `<article class="client-deliverable"><div><strong>${escapeHtml(row.title)}</strong><p>${escapeHtml(stageLabels[row.status] || row.status)}</p></div>${row.status === 'delivered' ? `<button class="btn btn-primary" data-approve="${row.id}">Approve</button>` : row.status === 'approved' ? '<span class="stage-pill stage-complete">Approved</span>' : ''}</article>`).join('') : '<p class="projects-empty">No approved deliverables have been shared yet.</p>'}</div></section>
      <section class="project-workspace-panel"><div class="section-label">Shared documents</div><div class="client-document-list">${artifacts.length ? artifacts.map(row => `<article class="client-deliverable"><div><strong>${escapeHtml(row.title)}</strong><p>${escapeHtml(row.visibility.replace('_', ' '))}</p></div><button class="btn btn-ghost" data-download="${row.id}">Download</button></article>`).join('') : '<p class="projects-empty">No documents have been shared yet.</p>'}</div></section>
      <section class="project-workspace-panel"><div class="section-label">Training</div><div class="client-training-list">${training.length ? training.map(row => `<article class="client-deliverable"><strong>${escapeHtml(row.stable_key.replace(/[-_]/g, ' '))}</strong><span class="stage-pill stage-complete">${escapeHtml(row.status)}</span></article>`).join('') : '<p class="projects-empty">No completed training has been shared yet.</p>'}</div></section>
    </div>`;
  detail.querySelectorAll('[data-task]').forEach(button => button.addEventListener('click', () => void transition(button.dataset.task, button.dataset.next)));
  detail.querySelectorAll('[data-approve]').forEach(button => button.addEventListener('click', () => void approve(button.dataset.approve)));
  detail.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => void download(projectId, button.dataset.download)));
  setStatus('Only client-facing records are shown here.');
}

async function boot() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return;
  if (projectId) await loadDetail(); else await loadList();
}
supabase.auth.onAuthStateChange((_event, session) => { if (session) void boot(); });
void boot();
