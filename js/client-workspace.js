import { supabase } from './supabase-client.js';
import { artifactDownloadUrl, uploadProjectArtifact } from './artifact-repository.js';

const status = document.querySelector('#clientWorkspaceStatus');
const list = document.querySelector('#clientProjectList');
const detail = document.querySelector('#clientProjectDetail');
const title = document.querySelector('#clientWorkspaceTitle');
const intro = document.querySelector('#clientWorkspaceIntro');
const projectId = new URLSearchParams(location.search).get('project');
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const one = value => Array.isArray(value) ? value[0] : value;
const pretty = value => String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

function setStatus(message) { status.textContent = message; }
function version(row) { return one(row.playbook_versions); }
function playbook(row) { return one(version(row)?.playbooks); }
function clientStatus(stage) {
  if (['complete', 'delivered'].includes(stage)) return 'Complete';
  if (stage === 'client_review') return 'Awaiting Laminar review';
  if (stage === 'blocked') return 'Awaiting Laminar update';
  return 'In progress';
}
function trainingName(row, project) {
  const entry = (version(project)?.definition?.training || []).find(item => item.id === row.stable_key);
  const known = { gbp: 'Google Business Profile', hubspot: 'HubSpot customer relationship management', 'website-cms': 'Website content management system', website_cms: 'Website content management system' };
  return entry?.name || known[row.stable_key] || pretty(row.stable_key);
}
function requestLabel(request) {
  if (request.status === 'open') return 'Client response required';
  if (request.status === 'responded') return 'Response sent to Laminar';
  if (request.status === 'approved') return 'Approved';
  return pretty(request.status);
}
function projectCard(project, counts) {
  return `<a class="client-project-card" href="client.html?project=${encodeURIComponent(project.id)}"><div class="project-workspace-type">${esc(playbook(project)?.name || 'Laminar project')}</div><h2>${esc(project.name)}</h2><p>${esc(project.client_name || '')}</p><div class="project-workspace-meta">${counts.open || 0} response${counts.open === 1 ? '' : 's'} needed · ${counts.deliverables || 0} deliverable${counts.deliverables === 1 ? '' : 's'} shared</div></a>`;
}

async function loadList() {
  const { data: projects, error } = await supabase.from('projects').select('id,name,client_name,status,playbook_versions(definition,playbooks(name))').order('updated_at', { ascending: false });
  if (error) return setStatus(error.message);
  const ids = (projects || []).map(row => row.id);
  if (!ids.length) { list.innerHTML = '<p class="projects-empty">No client projects are currently assigned to you.</p>'; return setStatus('No client projects are available.'); }
  const [requestsResult, deliverablesResult] = await Promise.all([
    supabase.from('client_response_requests').select('project_id,status').in('project_id', ids),
    supabase.from('deliverables').select('project_id').in('project_id', ids),
  ]);
  if (requestsResult.error || deliverablesResult.error) return setStatus(requestsResult.error?.message || deliverablesResult.error?.message || 'Unable to load your workspace.');
  const counts = new Map();
  for (const id of ids) counts.set(id, { open: 0, deliverables: 0 });
  for (const row of requestsResult.data || []) if (row.status === 'open') counts.get(row.project_id).open += 1;
  for (const row of deliverablesResult.data || []) counts.get(row.project_id).deliverables += 1;
  list.innerHTML = projects.map(project => projectCard(project, counts.get(project.id))).join('');
  setStatus(`${projects.length} project${projects.length === 1 ? '' : 's'} available to you.`);
}

function requestHtml(request, isClientAdmin) {
  const messages = (request.client_response_messages || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const attachments = request.client_response_artifacts || [];
  const isOpen = request.status === 'open';
  const completeLabel = request.request_type === 'approval' ? 'Approve and complete' : request.request_type === 'review' ? 'Mark reviewed' : 'Complete response';
  return `<article class="client-request${isOpen ? ' client-request-open' : ''}" data-request-id="${esc(request.id)}">
    <header><span class="client-request-status">${esc(requestLabel(request))}</span><strong>${esc(request.title)}</strong></header>
    ${request.instructions ? `<p class="client-request-instructions">${esc(request.instructions)}</p>` : ''}
    ${request.request_type === 'approval' ? `<p class="client-request-approval">Approval: ${esc(request.approval_subject || request.title)}${request.approval_version ? ` · ${esc(request.approval_version)}` : ''}</p>` : ''}
    ${request.due_on ? `<p class="client-request-due">Requested by ${esc(request.due_on)}</p>` : ''}
    <div class="client-request-messages">${messages.length ? messages.map(message => `<div class="client-request-message"><span>${esc(new Date(message.created_at).toLocaleString())}</span><p>${esc(message.body)}</p></div>`).join('') : '<p class="project-data-note">No notes have been added yet.</p>'}</div>
    ${attachments.length ? `<div class="client-request-files">${attachments.map(link => `<button class="text-button" type="button" data-download="${esc(link.artifact_id)}">${esc(one(link.artifacts)?.title || 'Attached document')}</button>`).join('')}</div>` : ''}
    ${isOpen ? `<form class="client-response-message-form" data-message-form="${esc(request.id)}"><textarea name="message" rows="2" maxlength="6000" placeholder="Add your response or question…"></textarea><button class="btn btn-ghost btn-sm" type="submit">Add note</button></form>
    <form class="client-response-upload-form" data-upload-form="${esc(request.id)}"><input name="file" type="file" required><button class="btn btn-ghost btn-sm" type="submit">Upload requested document</button></form>
    <button class="btn btn-primary btn-sm" data-complete-request="${esc(request.id)}" data-approval="${request.request_type === 'approval'}" ${request.request_type === 'approval' && !isClientAdmin ? 'disabled title="A client administrator must provide formal approval."' : ''}>${completeLabel}</button>` : ''}
  </article>`;
}

function taskHtml(task, requests, isClientAdmin) {
  const note = (task.task_notes || []).find(row => row.visibility === 'client');
  const taskRequests = requests.filter(request => request.task_id === task.id);
  const template = one(task.playbook_task_templates);
  return `<article class="client-phase-task"><div class="client-phase-task-title"><span class="stage-pill stage-${esc(task.stage.replace('_', '-'))}">${esc(clientStatus(task.stage))}</span><strong>${esc(task.title)}</strong></div>${template?.guidance ? `<p>${esc(template.guidance)}</p>` : ''}${note?.body ? `<div class="client-facing-note"><span>Laminar note</span>${esc(note.body)}</div>` : ''}${taskRequests.map(request => requestHtml(request, isClientAdmin)).join('')}</article>`;
}

async function addMessage(requestId, body) {
  const { error } = await supabase.rpc('add_client_response_message', { p_request: requestId, p_body: body });
  if (error) throw new Error(error.message);
}
async function completeRequest(requestId, approval) {
  const { error } = await supabase.rpc('complete_client_response_request', { p_request: requestId, p_approval: approval });
  if (error) throw new Error(error.message);
}
async function attachUpload(requestId, form) {
  const file = new FormData(form).get('file');
  if (!(file instanceof File) || !file.size) throw new Error('Choose a document to upload.');
  const artifactId = await uploadProjectArtifact({ projectId, file, title: file.name, visibility: 'client_upload' });
  const { error } = await supabase.rpc('attach_client_response_artifact', { p_request: requestId, p_artifact: artifactId });
  if (error) throw new Error(error.message);
}
async function download(artifactId) {
  try { window.open(await artifactDownloadUrl({ projectId, artifactId }), '_blank', 'noopener'); }
  catch (error) { setStatus(error.message); }
}

async function loadDetail() {
  const { data: project, error } = await supabase.from('projects').select('id,name,client_name,status,playbook_versions(definition,playbooks(name))').eq('id', projectId).maybeSingle();
  if (error || !project) return setStatus(error?.message || 'This project is not available to you.');
  const [tasksResult, requestsResult, deliverablesResult, artifactsResult, trainingResult, membersResult] = await Promise.all([
    supabase.from('project_tasks').select('id,title,stage,due_on,playbook_phases(id,position,label,title),playbook_task_templates(guidance),task_notes(visibility,body)').eq('project_id', projectId).order('sort_rank'),
    supabase.from('client_response_requests').select('id,project_id,task_id,title,instructions,request_type,status,due_on,requires_artifact,requires_signed_artifact,approval_subject,approval_version,created_at,client_response_messages(id,body,created_by,created_at),client_response_artifacts(artifact_id,artifacts(id,title))').eq('project_id', projectId).order('created_at'),
    supabase.from('deliverables').select('id,title,status,approved_at').eq('project_id', projectId).order('title'),
    supabase.from('artifacts').select('id,title,visibility,status,created_at').eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase.from('training_records').select('id,stable_key,status,signed_off_at').eq('project_id', projectId).eq('status', 'complete').order('stable_key'),
    supabase.from('project_members').select('user_id,role').eq('project_id', projectId),
  ]);
  const failed = [tasksResult, requestsResult, deliverablesResult, artifactsResult, trainingResult, membersResult].find(result => result.error);
  if (failed) return setStatus(failed.error.message);
  const { data: sessionData } = await supabase.auth.getSession();
  const isClientAdmin = (membersResult.data || []).some(member => member.user_id === sessionData.session?.user.id && member.role === 'client_admin');
  const tasks = tasksResult.data || [], requests = requestsResult.data || [];
  const grouped = new Map();
  for (const task of tasks) {
    const phase = one(task.playbook_phases) || { id: 'other', position: 999, title: 'Project actions' };
    if (!grouped.has(phase.id)) grouped.set(phase.id, { phase, tasks: [] });
    grouped.get(phase.id).tasks.push(task);
  }
  const taskIds = new Set(tasks.map(task => task.id));
  const projectRequests = requests.filter(request => !request.task_id || !taskIds.has(request.task_id));
  title.textContent = project.name; intro.textContent = `${playbook(project)?.name || 'Laminar project'} · client workspace.`;
  list.hidden = true; detail.hidden = false;
  detail.innerHTML = `<a class="project-back" href="client.html">‹ All client projects</a>
    ${projectRequests.length ? `<section class="project-workspace-panel client-response-panel"><div class="section-label">Client response required</div><p class="project-data-note">These requests need your input. Your notes, documents, completion, and approvals are recorded for both your team and Laminar.</p>${projectRequests.map(request => requestHtml(request, isClientAdmin)).join('')}</section>` : ''}
    <section class="project-workspace-panel"><div class="section-label">Project phases</div><p class="project-data-note">Expand a phase to see the client-facing steps, Laminar notes, and anything that needs a response from you.</p><div class="client-phase-list">${[...grouped.values()].sort((a,b) => (a.phase.position || 0) - (b.phase.position || 0)).map(({ phase, tasks: phaseTasks }) => { const open = phaseTasks.some(task => requests.some(request => request.task_id === task.id && request.status === 'open')); const complete = phaseTasks.filter(task => ['complete', 'delivered'].includes(task.stage)).length; return `<details class="client-phase" ${open ? 'open' : ''}><summary><span>${esc(phase.label || `Phase ${phase.position || ''}`)}</span><strong>${esc(phase.title || 'Project phase')}</strong><small>${complete}/${phaseTasks.length} complete</small></summary><div class="client-phase-body">${phaseTasks.map(task => taskHtml(task, requests, isClientAdmin)).join('')}</div></details>`; }).join('') || '<p class="projects-empty">No client-facing steps have been shared yet.</p>'}</div></section>
    <div class="client-detail-grid"><section class="project-workspace-panel"><div class="section-label">Deliverables</div><div class="client-deliverable-list">${(deliverablesResult.data || []).length ? (deliverablesResult.data || []).map(row => `<article class="client-deliverable"><div><strong>${esc(row.title)}</strong><p>${esc(row.status === 'approved' ? 'Approved' : 'Ready for your approval')}</p></div>${row.status === 'delivered' ? `<button class="btn btn-primary btn-sm" data-deliverable-approve="${esc(row.id)}">Approve deliverable</button>` : '<span class="stage-pill stage-complete">Approved</span>'}</article>`).join('') : '<p class="projects-empty">No deliverables have been shared yet.</p>'}</div></section>
    <section class="project-workspace-panel"><div class="section-label">Shared documents</div><div class="client-document-list">${(artifactsResult.data || []).length ? (artifactsResult.data || []).map(row => `<article class="client-deliverable"><div><strong>${esc(row.title)}</strong><p>${esc(pretty(row.visibility))}</p></div><button class="btn btn-ghost btn-sm" data-download="${esc(row.id)}">Download</button></article>`).join('') : '<p class="projects-empty">No documents have been shared yet.</p>'}</div></section>
    <section class="project-workspace-panel"><div class="section-label">Completed training</div><div class="client-training-list">${(trainingResult.data || []).length ? (trainingResult.data || []).map(row => `<article class="client-deliverable"><strong>${esc(trainingName(row, project))}</strong><span class="stage-pill stage-complete">Complete</span></article>`).join('') : '<p class="projects-empty">No completed training has been shared yet.</p>'}</div></section></div>`;
  detail.querySelectorAll('[data-message-form]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); const body = new FormData(form).get('message')?.trim(); if (!body) return; void addMessage(form.dataset.messageForm, body).then(loadDetail).catch(error => setStatus(error.message)); }));
  detail.querySelectorAll('[data-upload-form]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); void attachUpload(form.dataset.uploadForm, form).then(() => { setStatus('Document uploaded and attached to your response.'); return loadDetail(); }).catch(error => setStatus(error.message)); }));
  detail.querySelectorAll('[data-complete-request]').forEach(button => button.addEventListener('click', () => void completeRequest(button.dataset.completeRequest, button.dataset.approval === 'true').then(() => { setStatus(button.dataset.approval === 'true' ? 'Approval recorded and sent to Laminar.' : 'Response completed and sent to Laminar.'); return loadDetail(); }).catch(error => setStatus(error.message))));
  detail.querySelectorAll('[data-deliverable-approve]').forEach(button => button.addEventListener('click', () => void supabase.rpc('approve_client_deliverable', { p_deliverable: button.dataset.deliverableApprove }).then(result => { if (result.error) throw new Error(result.error.message); return loadDetail(); }).catch(error => setStatus(error.message))));
  detail.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => void download(button.dataset.download)));
  setStatus('Only client-facing work, notes, documents, and requests are shown here.');
}

async function boot() { const { data } = await supabase.auth.getSession(); if (!data.session) return; if (projectId) await loadDetail(); else await loadList(); }
supabase.auth.onAuthStateChange((_event, session) => { if (session) void boot(); });
void boot();
