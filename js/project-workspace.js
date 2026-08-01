import { supabase } from './supabase-client.js';
import { uploadProjectArtifact } from './artifact-repository.js';
import { ICONS, autoResize } from './ui.js';
import { COUNTABLE_STAGES, DONE_STAGES, getValidTransitions, isRescope, STAGE_META, stageFromDatabase } from './stages.js';
import { addCycleTimeEntry, addCycleWorkItem, attachQualificationArtifact, closeOperatingCycle, detachQualificationArtifact, loadProjectSections, loadProjectWorkspace, openOperatingCycle, saveTaskNote, transitionTask, updateAssetItem, updateDeliverable, updateQualification, updateTraining } from './project-repository.js';

const projectId = new URLSearchParams(location.search).get('id');
const projectName = document.querySelector('#projectName');
const projectClient = document.querySelector('#projectClient');
const projectPlaybook = document.querySelector('#projectPlaybook');
const projectSummary = document.querySelector('#projectSummary');
const projectProgressBar = document.querySelector('#projectProgressBar');
const projectProgressCount = document.querySelector('#projectProgressCount');
const status = document.querySelector('#projectWorkspaceStatus');
const phases = document.querySelector('#projectPhases');
const workspaceNav = document.querySelector('#projectWorkspaceNav');
const sectionViews = {
  overview: document.querySelector('#projectOverview'),
  phases,
  assets: document.querySelector('#projectAssets'),
  artifacts: document.querySelector('#projectArtifacts'),
  deliverables: document.querySelector('#projectDeliverables'),
  training: document.querySelector('#projectTraining'),
  cycles: document.querySelector('#projectCycles'),
  details: document.querySelector('#projectDetails'),
};

let workspace = null;
let sections = null;
let activeView = ['overview', 'phases', 'assets', 'artifacts', 'deliverables', 'training', 'cycles', 'details'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let openStageTaskId = null;
let openNoteTaskId = null;
let pendingRescope = null;

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function setStatus(value = '') { status.textContent = value; }
function playbookName(row) { const version = Array.isArray(row.playbook_versions) ? row.playbook_versions[0] : row.playbook_versions; const playbook = version && (Array.isArray(version.playbooks) ? version.playbooks[0] : version.playbooks); return playbook?.name || 'Laminar project'; }
function playbookCode(row) { const version = Array.isArray(row.playbook_versions) ? row.playbook_versions[0] : row.playbook_versions; const playbook = version && (Array.isArray(version.playbooks) ? version.playbooks[0] : version.playbooks); return playbook?.code || ''; }
function definition(project) { const version = Array.isArray(project.playbook_versions) ? project.playbook_versions[0] : project.playbook_versions; return version?.definition && typeof version.definition === 'object' ? version.definition : {}; }
function definitionByKey(project, section, stableKey) { return (definition(project)[section] || []).find(item => item.id === stableKey) || {}; }
function displayStatus(value) { return String(value || 'pending').replaceAll('_', ' '); }
function emptyState(message) { return `<div class="project-section-empty">${esc(message)}</div>`; }

function showView(view, updateHash = false) {
  activeView = sectionViews[view] ? view : 'overview';
  for (const [name, section] of Object.entries(sectionViews)) section.classList.toggle('active', name === activeView);
  workspaceNav.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === activeView;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  });
  if (updateHash && location.hash !== `#${activeView}`) history.replaceState(null, '', `#${activeView}`);
}

function renderSectionData(project, tasks) {
  if (!sections) return;
  const qualificationDefs = definition(project).qualification || [];
  const qualification = new Map(sections.qualification.map(item => [item.stable_key, item]));
  const completedQualification = sections.qualification.filter(item => item.complete).length;
  const countable = tasks.filter(task => COUNTABLE_STAGES.has(task.uiStage));
  const done = tasks.filter(task => DONE_STAGES.has(task.uiStage)).length;
  const qualificationLinks = new Map();
  for (const link of sections.qualificationArtifacts) {
    if (!qualificationLinks.has(link.qualification_item_id)) qualificationLinks.set(link.qualification_item_id, []);
    qualificationLinks.get(link.qualification_item_id).push(Array.isArray(link.artifacts) ? link.artifacts[0] : link.artifacts);
  }
  const availableDocuments = sections.artifacts.filter(item => item.status === 'available');
  sectionViews.overview.innerHTML = `
    <div class="project-section-grid">
      <article class="project-data-card"><span>Delivery progress</span><strong>${done} / ${countable.length}</strong><p>Countable playbook tasks complete.</p></article>
      <article class="project-data-card"><span>Qualification</span><strong>${completedQualification} / ${qualificationDefs.length || sections.qualification.length}</strong><p>Engagement readiness items complete.</p></article>
      <article class="project-data-card"><span>Assets</span><strong>${sections.assets.filter(item => item.status === 'received').length} / ${sections.assets.length}</strong><p>Required and supporting inputs received.</p></article>
      <article class="project-data-card"><span>Deliverables</span><strong>${sections.deliverables.filter(item => item.status === 'approved').length} / ${sections.deliverables.length}</strong><p>Approved deliverables.</p></article>
    </div>
    <section class="project-data-panel"><div class="section-label">Qualification</div><p class="project-data-note">Record the decision rationale and attach supporting project documents to each qualification item.</p>${qualificationDefs.length ? `<div class="qualification-record-list">${qualificationDefs.map(item => { const row = qualification.get(item.id); const linked = row ? qualificationLinks.get(row.id) || [] : []; return `<article class="qualification-record${row?.complete ? ' complete' : ''}"><label class="project-check-row"><input type="checkbox" data-action="qualification-update" data-item-id="${esc(row?.id || '')}" ${row?.complete ? 'checked' : ''} ${row ? '' : 'disabled'}><span>${row?.complete ? '✓' : '○'}</span>${esc(item.label)}</label>${row ? `<textarea class="qualification-note" rows="2" data-qualification-note="${esc(row.id)}" placeholder="Internal rationale, decision context, or follow-up…">${esc(row.internal_note || '')}</textarea><div class="qualification-evidence"><strong>Supporting documents</strong>${linked.length ? `<ul>${linked.filter(Boolean).map(doc => `<li>${esc(doc.title || 'Project document')} <button type="button" class="text-button" data-action="qualification-document-detach" data-item-id="${esc(row.id)}" data-artifact-id="${esc(doc.id)}">Remove</button></li>`).join('')}</ul>` : '<p>No supporting documents attached.</p>'}<div class="qualification-document-actions"><select data-qualification-document="${esc(row.id)}"><option value="">${availableDocuments.length ? 'Attach a project document…' : 'No uploaded project documents yet'}</option>${availableDocuments.filter(doc => !linked.some(attached => attached?.id === doc.id)).map(doc => `<option value="${esc(doc.id)}">${esc(doc.title)} · ${esc(doc.visibility)}</option>`).join('')}</select><button class="btn btn-ghost btn-sm" type="button" data-action="qualification-document-attach" data-item-id="${esc(row.id)}" ${availableDocuments.length ? '' : 'disabled'}>Attach document</button><button class="btn btn-ghost btn-sm" type="button" data-action="qualification-note-save" data-item-id="${esc(row.id)}">Save note</button></div></div>` : ''}</article>`; }).join('')}</div>` : emptyState('No qualification items were defined for this playbook.')}</section>`;

  sectionViews.assets.innerHTML = sections.assets.length ? `<div class="asset-grid">${sections.assets.map(item => {
    const def = definitionByKey(project, 'assets', item.stable_key);
    return `<article class="asset-card"><div class="asset-card-header"><div><div class="asset-name">${esc(def.name || item.stable_key)}</div><div class="asset-cat">${esc(def.category || 'Project asset')}</div></div><select class="status-select" data-action="asset-status" data-item-id="${esc(item.id)}"><option value="missing" ${item.status === 'missing' ? 'selected' : ''}>Not received</option><option value="requested" ${item.status === 'requested' ? 'selected' : ''}>Requested</option><option value="received" ${item.status === 'received' ? 'selected' : ''}>Received</option><option value="not_required" ${item.status === 'not_required' ? 'selected' : ''}>Not required</option></select></div>${def.description ? `<p class="project-data-description">${esc(def.description)}</p>` : ''}<textarea class="asset-note" rows="2" data-item-note="${esc(item.id)}" placeholder="Secure reference or internal note…">${esc(item.internal_note || '')}</textarea><button class="btn btn-ghost btn-sm" type="button" data-action="asset-save" data-item-id="${esc(item.id)}">Save asset</button></article>`;
  }).join('')}</div>` : emptyState('No materialized asset requirements are available for this project yet.');

  sectionViews.artifacts.innerHTML = `<section class="project-data-panel artifact-upload-panel"><div><div class="section-label">Project documents</div><p class="project-data-note">Files are private by default, versioned rather than overwritten, and recorded in the project audit history.</p></div><form class="artifact-upload-form" data-action="artifact-upload"><input name="title" maxlength="180" placeholder="Document title (optional)"><select name="visibility"><option value="internal">Internal only</option><option value="client">Client-visible after approval</option><option value="restricted">Restricted internal access</option><option value="client_upload">Client-provided document</option></select><input name="file" type="file" required><button class="btn btn-primary btn-sm" type="submit">Upload document</button></form></section>${sections.artifacts.length ? `<div class="artifact-list">${sections.artifacts.map(artifact => { const versions = (artifact.artifact_versions || []).filter(version => !version.superseded_at).sort((a, b) => Number(b.version_number) - Number(a.version_number)); const current = versions[0]; return `<article class="artifact-card"><div><div class="artifact-title">${esc(artifact.title)}</div><p class="project-data-note">${esc(artifact.visibility)} · ${esc(artifact.origin || 'upload')} · ${esc(artifact.status)}</p>${current ? `<p class="project-data-note">${esc(current.file_name)} · v${esc(current.version_number)}${current.byte_size ? ` · ${(Number(current.byte_size) / 1024).toFixed(1)} KB` : ''}</p>` : '<p class="project-data-note">Upload pending.</p>'}</div><form class="artifact-version-form" data-action="artifact-version" data-artifact-id="${esc(artifact.id)}"><input name="file" type="file" required><button class="btn btn-ghost btn-sm" type="submit">Add version</button></form></article>`; }).join('')}</div>` : emptyState('No project documents have been uploaded yet.')}`;

  sectionViews.deliverables.innerHTML = sections.deliverables.length ? `<div class="deliverable-list">${sections.deliverables.map(item => {
    const def = definitionByKey(project, 'deliverables', item.stable_key);
    return `<article class="deliverable-card"><div class="deliverable-header"><span class="deliverable-name">${esc(item.title || def.name || item.stable_key || 'Deliverable')}</span><select class="status-select" data-deliverable-status="${esc(item.id)}"><option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option><option value="delivered" ${item.status === 'delivered' ? 'selected' : ''}>Delivered</option><option value="approved" ${item.status === 'approved' ? 'selected' : ''}>Approved</option></select></div>${def.description ? `<p class="deliverable-desc">${esc(def.description)}</p>` : ''}<label class="project-visibility-control"><input type="checkbox" data-deliverable-visible="${esc(item.id)}" ${item.client_visible ? 'checked' : ''}> Approved for client visibility</label><button class="btn btn-ghost btn-sm" type="button" data-action="deliverable-save" data-item-id="${esc(item.id)}">Save deliverable</button></article>`;
  }).join('')}</div>` : emptyState('No materialized deliverables are available for this project yet.');

  sectionViews.training.innerHTML = sections.training.length ? `<div class="training-list">${sections.training.map(item => {
    const def = definitionByKey(project, 'training', item.stable_key);
    return `<article class="training-card"><div class="training-card-header"><div class="training-tool-info"><div class="training-tool-name">${esc(def.name || item.stable_key)}</div>${def.scope ? `<div class="training-scope">${esc(def.scope)}</div>` : ''}</div><select class="status-select" data-training-status="${esc(item.id)}"><option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option><option value="in_progress" ${item.status === 'in_progress' ? 'selected' : ''}>In progress</option><option value="complete" ${item.status === 'complete' ? 'selected' : ''}>Complete</option></select></div>${Array.isArray(def.competencies) && def.competencies.length ? `<ul class="training-competencies">${def.competencies.map(competency => `<li>${esc(competency)}</li>`).join('')}</ul>` : ''}<div class="training-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="training-save" data-item-id="${esc(item.id)}">Save training</button></div></article>`;
  }).join('')}</div>` : emptyState('No materialized training records are available for this project yet.');

  const cycleIntro = `<section class="project-data-panel cycle-create-panel"><div><div class="section-label">Operating cycle</div><p class="project-data-note">Open one deliberate monthly or quarterly delivery period. Its work, capacity, time, evidence, and close-out are then retained in the project audit history.</p></div><form class="cycle-open-form" data-action="cycle-open"><label>Period <input type="month" name="period" required value="${new Date().toISOString().slice(0, 7)}"></label><button class="btn btn-primary btn-sm" type="submit">Open cycle</button></form></section>`;
  sectionViews.cycles.innerHTML = `${cycleIntro}${sections.cycles.length ? `<div class="cycle-list">${sections.cycles.map(cycle => {
    const workItems = sections.workItems.filter(item => item.cycle_id === cycle.id);
    const timeEntries = sections.timeEntries.filter(item => item.cycle_id === cycle.id);
    const hours = timeEntries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
    const closed = cycle.status === 'closed';
    return `<article class="cycle-header-card"><div class="cycle-header-top"><div><div class="cycle-header-period">${esc(String(cycle.period).slice(0, 7))}</div><p class="project-data-note">${workItems.length} work item${workItems.length === 1 ? '' : 's'} · ${hours.toFixed(1)} recorded hours</p></div><span class="stage-pill stage-${esc(closed ? 'complete' : 'active')}">${esc(displayStatus(cycle.status))}</span></div><div class="cycle-detail-grid"><div><strong>Work items</strong>${workItems.length ? `<ul>${workItems.map(item => `<li>${esc(item.title)}${item.estimated_hours ? ` · ${esc(item.estimated_hours)}h planned` : ''}</li>`).join('')}</ul>` : '<p class="project-data-note">No work items yet.</p>'}</div><div><strong>Time entries</strong>${timeEntries.length ? `<ul>${timeEntries.map(entry => `<li>${esc(entry.category)} · ${esc(entry.hours)}h</li>`).join('')}</ul>` : '<p class="project-data-note">No time entries yet.</p>'}</div></div>${closed ? '' : `<form class="cycle-inline-form" data-action="cycle-work-item" data-cycle-id="${esc(cycle.id)}"><input name="title" placeholder="Add scoped work item" required><input name="hours" type="number" min="0" step="0.25" placeholder="Est. hours"><button class="btn btn-ghost btn-sm" type="submit">Add work</button></form><form class="cycle-inline-form" data-action="cycle-time-entry" data-cycle-id="${esc(cycle.id)}"><input name="hours" type="number" min="0.25" step="0.25" placeholder="Hours" required><input name="category" placeholder="Category" required><input name="note" placeholder="Note (optional)"><button class="btn btn-ghost btn-sm" type="submit">Log time</button></form><button class="btn btn-ghost btn-sm cycle-close" type="button" data-action="cycle-close" data-cycle-id="${esc(cycle.id)}">Close cycle</button>`}</article>`;
  }).join('')}</div>` : emptyState('No operating cycles have been opened for this project.')}`;

  sectionViews.details.innerHTML = `<section class="project-data-panel"><div class="section-label">Project record</div><dl class="project-detail-list"><div><dt>Client</dt><dd>${esc(project.client_name || 'Not recorded')}</dd></div><div><dt>Project status</dt><dd>${esc(project.status)}</dd></div><div><dt>Pinned playbook</dt><dd>${esc(playbookName(project))} · version ${esc(workspace.version?.version_number || '—')}</dd></div><div><dt>Last updated</dt><dd>${project.updated_at ? esc(new Date(project.updated_at).toLocaleString()) : 'Not recorded'}</dd></div></dl></section><section class="project-data-panel project-activity"><div class="section-label">Recent audit activity</div>${sections.audit.length ? `<div class="project-activity-list">${sections.audit.slice(0, 8).map(event => `<div><strong>${esc(event.event_type.replaceAll('.', ' '))}</strong><span>${esc(new Date(event.occurred_at).toLocaleString())}</span></div>`).join('')}</div>` : emptyState('No audit activity is visible yet.')}</section>`;
}

function render(project, tasks) {
  document.title = `${project.name} — Laminar Pipeline`;
  projectName.textContent = project.name;
  projectClient.textContent = project.client_name || 'No client name recorded';
  projectPlaybook.textContent = playbookName(project);
  const countable = tasks.filter(task => COUNTABLE_STAGES.has(task.uiStage));
  const done = tasks.filter(task => DONE_STAGES.has(task.uiStage)).length;
  const percent = countable.length ? Math.round((done / countable.length) * 100) : 0;
  projectProgressBar.style.width = `${percent}%`;
  projectProgressCount.textContent = `${done} / ${countable.length}`;
  projectSummary.hidden = false;
  const isOperational = ['operating-partnership', 'business-operations', 'digital-presence-operations'].includes(playbookCode(project));
  const cycleButton = workspaceNav.querySelector('[data-view="cycles"]');
  cycleButton.hidden = !isOperational;
  if (!isOperational && activeView === 'cycles') activeView = 'overview';

  const grouped = new Map();
  for (const task of tasks) {
    const phase = task.phase;
    if (!phase) continue;
    if (!grouped.has(phase.id)) grouped.set(phase.id, { phase, tasks: [] });
    grouped.get(phase.id).tasks.push(task);
  }
  phases.innerHTML = [...grouped.values()].sort((a, b) => a.phase.position - b.phase.position).map(({ phase, tasks: phaseTasks }) => `
    <section class="phase"><header class="phase-header"><span class="phase-tag" style="background:${esc(phase.color || '#4B8EFF')}">${esc(phase.label)}</span><div class="phase-title-wrap"><div class="phase-title">${esc(phase.title)}</div>${phase.objective ? `<div class="phase-objective">${esc(phase.objective)}</div>` : ''}</div><span class="phase-progress">${phaseTasks.filter(task => DONE_STAGES.has(task.uiStage)).length}/${phaseTasks.length}</span></header>
    <div class="phase-body">${phaseTasks.sort((a,b) => Number(a.sort_rank) - Number(b.sort_rank)).map(task => taskHtml(task)).join('')}</div></section>`).join('');
  phases.querySelectorAll('textarea').forEach(autoResize);
  renderSectionData(project, tasks);
  showView(activeView);
}

function taskHtml(task) {
  const blockedFrom = task.metadata?.blocked_from ? stageFromDatabase(task.metadata.blocked_from) : null;
  const options = getValidTransitions(task.uiStage, blockedFrom);
  const isMenuOpen = openStageTaskId === task.id;
  const isNoteOpen = openNoteTaskId === task.id;
  const awaitingRescope = pendingRescope?.taskId === task.id;
  const meta = STAGE_META[task.uiStage] || STAGE_META.pending;
  return `<article class="item" data-task-id="${esc(task.id)}"><div class="item-row"><button class="stage-pill stage-${esc(task.uiStage)}" type="button" data-action="stage-toggle" aria-expanded="${isMenuOpen}">${esc(meta.label)}</button><div class="item-content"><div class="item-label">${esc(task.title)}</div>${task.template?.guidance ? `<div class="item-hint">${esc(task.template.guidance)}</div>` : ''}${task.blocked_reason ? `<div class="item-hint">Blocked: ${esc(task.blocked_reason)}</div>` : ''}</div><button class="icon-btn${task.notes.internal || task.notes.client ? ' has-note' : ''}${isNoteOpen ? ' open' : ''}" type="button" data-action="note-toggle" title="Task notes">${task.notes.internal || task.notes.client ? ICONS.noteFilled : ICONS.noteOutline}</button></div>${isMenuOpen ? stageMenuHtml(task, options) : ''}${isNoteOpen ? notePanelHtml(task, awaitingRescope) : ''}</article>`;
}

function stageMenuHtml(task, options) {
  if (!options.length) return '';
  if (pendingRescope?.taskId === task.id && pendingRescope.kind === 'blocked') {
    return `<div class="stage-menu open"><div class="stage-menu-inner stage-block-form"><label class="stage-menu-label" for="blocked-reason-${esc(task.id)}">Blocked reason</label><textarea id="blocked-reason-${esc(task.id)}" rows="2" placeholder="What is preventing progress?"></textarea><div class="stage-menu-options"><button class="stage-option stage-blocked" type="button" data-action="blocked-confirm">Mark blocked</button><button class="stage-option" type="button" data-action="stage-cancel">Cancel</button></div></div></div>`;
  }
  return `<div class="stage-menu open"><div class="stage-menu-inner"><span class="stage-menu-label">Move to</span><div class="stage-menu-options">${options.map(stage => { const meta = STAGE_META[stage]; return `<button class="stage-option stage-${esc(stage)}" type="button" data-action="stage-transition" data-to="${esc(stage)}">${esc(meta.label)}</button>`; }).join('')}</div></div></div>`;
}

function notePanelHtml(task, awaitingRescope) {
  return `<div class="note-wrap open"><div class="note-field"><div class="note-field-label">Internal note</div><textarea class="note-textarea" rows="2" data-note-visibility="internal" placeholder="Internal delivery note…">${esc(task.notes.internal || '')}</textarea><button class="btn btn-ghost btn-sm" type="button" data-action="note-save" data-visibility="internal">Save internal note</button></div><div class="note-field"><div class="note-field-label note-field-label--client">Client note</div><textarea class="note-textarea note-textarea--client" rows="2" data-note-visibility="client" placeholder="Client-visible note…">${esc(task.notes.client || '')}</textarea><button class="btn btn-ghost btn-sm" type="button" data-action="note-save" data-visibility="client">Save client note</button></div>${awaitingRescope ? `<div class="note-rescope-bar" style="display:flex"><span class="note-rescope-msg">Save a client note to explain this scope change, then the stage will be updated.</span></div>` : ''}</div>`;
}

async function loadProject() {
  if (!projectId) { setStatus('Project ID is missing.'); return; }
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return;
  setStatus('Loading project…');
  try {
    const [loadedWorkspace, loadedSections] = await Promise.all([
      loadProjectWorkspace(projectId),
      loadProjectSections(projectId),
    ]);
    workspace = loadedWorkspace;
    sections = loadedSections;
    if (!workspace) { setStatus('This project is unavailable to your account.'); return; }
    render(workspace.project, workspace.tasks);
    setStatus('Changes are saved to Supabase and recorded in the project audit history.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unable to load project.');
  }
}

async function transition(task, toStage, blockedReason = null, clientNote = null) {
  setStatus(`Moving task to ${STAGE_META[toStage].label}…`);
  try {
    await transitionTask({ taskId: task.id, toStage, blockedReason, clientNote });
    openStageTaskId = null;
    pendingRescope = null;
    await loadProject();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unable to update task stage.');
  }
}

phases.addEventListener('click', event => {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl || !workspace) return;
  const taskEl = actionEl.closest('[data-task-id]');
  const task = workspace.tasks.find(candidate => candidate.id === taskEl?.dataset.taskId);
  if (!task) return;
  const action = actionEl.dataset.action;
  if (action === 'stage-toggle') { openStageTaskId = openStageTaskId === task.id ? null : task.id; openNoteTaskId = null; render(workspace.project, workspace.tasks); return; }
  if (action === 'note-toggle') { openNoteTaskId = openNoteTaskId === task.id ? null : task.id; openStageTaskId = null; render(workspace.project, workspace.tasks); return; }
  if (action === 'stage-cancel') { pendingRescope = null; render(workspace.project, workspace.tasks); return; }
  if (action === 'stage-transition') {
    const toStage = actionEl.dataset.to;
    if (toStage === 'blocked') { pendingRescope = { taskId: task.id, kind: 'blocked' }; render(workspace.project, workspace.tasks); return; }
    if (isRescope(task.uiStage, toStage) && !(task.notes.client || '').trim()) { pendingRescope = { taskId: task.id, toStage, kind: 'rescope' }; openNoteTaskId = task.id; openStageTaskId = null; render(workspace.project, workspace.tasks); return; }
    void transition(task, toStage);
    return;
  }
  if (action === 'blocked-confirm') {
    const reason = taskEl.querySelector('textarea')?.value.trim();
    if (!reason) { setStatus('A blocked reason is required.'); return; }
    void transition(task, 'blocked', reason);
    return;
  }
  if (action === 'note-save') {
    const visibility = actionEl.dataset.visibility;
    const textarea = taskEl.querySelector(`[data-note-visibility="${visibility}"]`);
    if (!textarea) return;
    void saveNote(task, visibility, textarea.value);
  }
});

workspaceNav.addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) showView(button.dataset.view, true);
});

async function persistSection(action) {
  setStatus('Saving project section…');
  try {
    await action();
    await loadProject();
    setStatus('Project section saved to Supabase and recorded in the audit history.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unable to save project section.');
  }
}

sectionViews.overview.addEventListener('change', event => {
  const input = event.target.closest('[data-action="qualification-update"]');
  if (!input?.dataset.itemId) return;
  const record = input.closest('.qualification-record');
  const note = record?.querySelector(`[data-qualification-note="${input.dataset.itemId}"]`);
  void persistSection(() => updateQualification({ itemId: input.dataset.itemId, complete: input.checked, internalNote: note?.value ?? null }));
});
sectionViews.overview.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button?.dataset.itemId) return;
  const record = button.closest('.qualification-record');
  const itemId = button.dataset.itemId;
  if (button.dataset.action === 'qualification-note-save') {
    const checked = record?.querySelector('[data-action="qualification-update"]')?.checked || false;
    const note = record?.querySelector(`[data-qualification-note="${itemId}"]`)?.value || '';
    void persistSection(() => updateQualification({ itemId, complete: checked, internalNote: note }));
  }
  if (button.dataset.action === 'qualification-document-attach') {
    const artifactId = record?.querySelector(`[data-qualification-document="${itemId}"]`)?.value;
    if (!artifactId) { setStatus('Choose an uploaded project document first.'); return; }
    void persistSection(() => attachQualificationArtifact({ itemId, artifactId }));
  }
  if (button.dataset.action === 'qualification-document-detach' && button.dataset.artifactId) void persistSection(() => detachQualificationArtifact({ itemId, artifactId: button.dataset.artifactId }));
});
sectionViews.assets.addEventListener('click', event => {
  const button = event.target.closest('[data-action="asset-save"]');
  if (!button) return;
  const card = button.closest('.asset-card');
  const itemId = button.dataset.itemId;
  const statusSelect = card?.querySelector('[data-action="asset-status"]');
  const note = card?.querySelector('[data-item-note]');
  if (itemId && statusSelect && note) void persistSection(() => updateAssetItem({ itemId, status: statusSelect.value, internalNote: note.value }));
});
sectionViews.artifacts.addEventListener('submit', event => {
  const form = event.target.closest('form[data-action]');
  if (!form || !workspace) return;
  event.preventDefault();
  const data = new FormData(form);
  const file = data.get('file');
  const isVersion = form.dataset.action === 'artifact-version';
  const button = form.querySelector('button[type="submit"]');
  if (!(file instanceof File) || !file.size) { setStatus('Choose a document to upload.'); return; }
  if (button) { button.disabled = true; button.textContent = 'Uploading…'; }
  setStatus('Preparing secure document upload…');
  void uploadProjectArtifact({
    projectId: workspace.project.id,
    file,
    title: String(data.get('title') || file.name),
    visibility: isVersion ? 'internal' : String(data.get('visibility') || 'internal'),
    artifactId: isVersion ? form.dataset.artifactId : null,
  }).then(async () => {
    await loadProject();
    setStatus('Document uploaded to Supabase and recorded in the audit history.');
  }).catch(error => {
    setStatus(error instanceof Error ? error.message : 'Unable to upload document.');
  }).finally(() => {
    if (button) { button.disabled = false; button.textContent = isVersion ? 'Add version' : 'Upload document'; }
  });
});
sectionViews.deliverables.addEventListener('click', event => {
  const button = event.target.closest('[data-action="deliverable-save"]');
  if (!button) return;
  const card = button.closest('.deliverable-card');
  const itemId = button.dataset.itemId;
  const statusSelect = card?.querySelector(`[data-deliverable-status="${itemId}"]`);
  const visible = card?.querySelector(`[data-deliverable-visible="${itemId}"]`);
  if (itemId && statusSelect && visible) void persistSection(() => updateDeliverable({ deliverableId: itemId, status: statusSelect.value, clientVisible: visible.checked }));
});
sectionViews.training.addEventListener('click', event => {
  const button = event.target.closest('[data-action="training-save"]');
  if (!button) return;
  const card = button.closest('.training-card');
  const itemId = button.dataset.itemId;
  const statusSelect = card?.querySelector(`[data-training-status="${itemId}"]`);
  if (itemId && statusSelect) void persistSection(() => updateTraining({ recordId: itemId, status: statusSelect.value }));
});
sectionViews.cycles.addEventListener('submit', event => {
  const form = event.target.closest('form[data-action]');
  if (!form || !workspace) return;
  event.preventDefault();
  const data = new FormData(form);
  if (form.dataset.action === 'cycle-open') {
    const period = data.get('period');
    if (period) void persistSection(() => openOperatingCycle({ projectId: workspace.project.id, period: `${period}-01` }));
    return;
  }
  const cycleId = form.dataset.cycleId;
  if (form.dataset.action === 'cycle-work-item' && cycleId) void persistSection(() => addCycleWorkItem({ cycleId, title: String(data.get('title') || ''), estimatedHours: Number(data.get('hours')) || null }));
  if (form.dataset.action === 'cycle-time-entry' && cycleId) void persistSection(() => addCycleTimeEntry({ cycleId, hours: Number(data.get('hours')), category: String(data.get('category') || ''), note: String(data.get('note') || '') }));
});
sectionViews.cycles.addEventListener('click', event => {
  const button = event.target.closest('[data-action="cycle-close"]');
  if (!button?.dataset.cycleId) return;
  if (!confirm('Close this cycle? Its work and time history will remain visible but the period will no longer accept changes.')) return;
  void persistSection(() => closeOperatingCycle({ cycleId: button.dataset.cycleId }));
});

window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

async function saveNote(task, visibility, body) {
  setStatus('Saving note…');
  try {
    await saveTaskNote({ taskId: task.id, visibility, body });
    task.notes[visibility] = body;
    if (pendingRescope?.taskId === task.id && pendingRescope.kind === 'rescope' && visibility === 'client') {
      await transition(task, pendingRescope.toStage, null, body);
      return;
    }
    render(workspace.project, workspace.tasks);
    setStatus('Note saved to Supabase and recorded in the audit history.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unable to save note.');
  }
}

supabase.auth.onAuthStateChange((_event, session) => { if (session) void loadProject(); });
void loadProject();
