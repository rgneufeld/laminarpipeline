import { supabase } from './supabase-client.js';
import { ICONS, autoResize } from './ui.js';
import { COUNTABLE_STAGES, DONE_STAGES, getValidTransitions, isRescope, STAGE_META, stageFromDatabase } from './stages.js';
import { loadProjectSections, loadProjectWorkspace, saveTaskNote, transitionTask, updateAssetItem, updateDeliverable, updateQualification, updateTraining } from './project-repository.js';

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
  deliverables: document.querySelector('#projectDeliverables'),
  training: document.querySelector('#projectTraining'),
  cycles: document.querySelector('#projectCycles'),
  details: document.querySelector('#projectDetails'),
};

let workspace = null;
let sections = null;
let activeView = ['overview', 'phases', 'assets', 'deliverables', 'training', 'cycles', 'details'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let openStageTaskId = null;
let openNoteTaskId = null;
let pendingRescope = null;

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function setStatus(value = '') { status.textContent = value; }
function playbookName(row) { const version = Array.isArray(row.playbook_versions) ? row.playbook_versions[0] : row.playbook_versions; const playbook = version && (Array.isArray(version.playbooks) ? version.playbooks[0] : version.playbooks); return playbook?.name || 'Laminar project'; }
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
  sectionViews.overview.innerHTML = `
    <div class="project-section-grid">
      <article class="project-data-card"><span>Delivery progress</span><strong>${done} / ${countable.length}</strong><p>Countable playbook tasks complete.</p></article>
      <article class="project-data-card"><span>Qualification</span><strong>${completedQualification} / ${qualificationDefs.length || sections.qualification.length}</strong><p>Engagement readiness items complete.</p></article>
      <article class="project-data-card"><span>Assets</span><strong>${sections.assets.filter(item => item.status === 'received').length} / ${sections.assets.length}</strong><p>Required and supporting inputs received.</p></article>
      <article class="project-data-card"><span>Deliverables</span><strong>${sections.deliverables.filter(item => item.status === 'approved').length} / ${sections.deliverables.length}</strong><p>Approved deliverables.</p></article>
    </div>
    <section class="project-data-panel"><div class="section-label">Qualification</div>${qualificationDefs.length ? `<div class="project-check-list">${qualificationDefs.map(item => { const row = qualification.get(item.id); return `<label class="project-check-row${row?.complete ? ' complete' : ''}"><input type="checkbox" data-action="qualification-update" data-item-id="${esc(row?.id || '')}" ${row?.complete ? 'checked' : ''} ${row ? '' : 'disabled'}><span>${row?.complete ? '✓' : '○'}</span>${esc(item.label)}</label>`; }).join('')}</div>` : emptyState('No qualification items were defined for this playbook.')}</section>`;

  sectionViews.assets.innerHTML = sections.assets.length ? `<div class="asset-grid">${sections.assets.map(item => {
    const def = definitionByKey(project, 'assets', item.stable_key);
    return `<article class="asset-card"><div class="asset-card-header"><div><div class="asset-name">${esc(def.name || item.stable_key)}</div><div class="asset-cat">${esc(def.category || 'Project asset')}</div></div><select class="status-select" data-action="asset-status" data-item-id="${esc(item.id)}"><option value="missing" ${item.status === 'missing' ? 'selected' : ''}>Not received</option><option value="requested" ${item.status === 'requested' ? 'selected' : ''}>Requested</option><option value="received" ${item.status === 'received' ? 'selected' : ''}>Received</option><option value="not_required" ${item.status === 'not_required' ? 'selected' : ''}>Not required</option></select></div>${def.description ? `<p class="project-data-description">${esc(def.description)}</p>` : ''}<textarea class="asset-note" rows="2" data-item-note="${esc(item.id)}" placeholder="Secure reference or internal note…">${esc(item.internal_note || '')}</textarea><button class="btn btn-ghost btn-sm" type="button" data-action="asset-save" data-item-id="${esc(item.id)}">Save asset</button></article>`;
  }).join('')}</div>` : emptyState('No materialized asset requirements are available for this project yet.');

  sectionViews.deliverables.innerHTML = sections.deliverables.length ? `<div class="deliverable-list">${sections.deliverables.map(item => {
    const def = definitionByKey(project, 'deliverables', item.stable_key);
    return `<article class="deliverable-card"><div class="deliverable-header"><span class="deliverable-name">${esc(item.title || def.name || item.stable_key || 'Deliverable')}</span><select class="status-select" data-deliverable-status="${esc(item.id)}"><option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option><option value="delivered" ${item.status === 'delivered' ? 'selected' : ''}>Delivered</option><option value="approved" ${item.status === 'approved' ? 'selected' : ''}>Approved</option></select></div>${def.description ? `<p class="deliverable-desc">${esc(def.description)}</p>` : ''}<label class="project-visibility-control"><input type="checkbox" data-deliverable-visible="${esc(item.id)}" ${item.client_visible ? 'checked' : ''}> Approved for client visibility</label><button class="btn btn-ghost btn-sm" type="button" data-action="deliverable-save" data-item-id="${esc(item.id)}">Save deliverable</button></article>`;
  }).join('')}</div>` : emptyState('No materialized deliverables are available for this project yet.');

  sectionViews.training.innerHTML = sections.training.length ? `<div class="training-list">${sections.training.map(item => {
    const def = definitionByKey(project, 'training', item.stable_key);
    const competencies = item.metadata?.competencies && typeof item.metadata.competencies === 'object' ? Object.values(item.metadata.competencies).filter(Boolean).length : 0;
    return `<article class="training-card"><div class="training-card-header"><div class="training-tool-info"><div class="training-tool-name">${esc(def.name || item.stable_key)}</div>${def.scope ? `<div class="training-scope">${esc(def.scope)}</div>` : ''}</div><select class="status-select" data-training-status="${esc(item.id)}"><option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option><option value="in_progress" ${item.status === 'in_progress' ? 'selected' : ''}>In progress</option><option value="complete" ${item.status === 'complete' ? 'selected' : ''}>Complete</option></select></div>${competencies ? `<p class="project-data-note">${competencies} competency record${competencies === 1 ? '' : 's'} preserved.</p>` : ''}<button class="btn btn-ghost btn-sm" type="button" data-action="training-save" data-item-id="${esc(item.id)}">Save training</button></article>`;
  }).join('')}</div>` : emptyState('No materialized training records are available for this project yet.');

  sectionViews.cycles.innerHTML = sections.cycles.length ? `<div class="cycle-list">${sections.cycles.map(cycle => {
    const workItems = sections.workItems.filter(item => item.cycle_id === cycle.id);
    const timeEntries = sections.timeEntries.filter(item => item.cycle_id === cycle.id);
    const hours = timeEntries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
    return `<article class="cycle-header-card"><div class="cycle-header-top"><div><div class="cycle-header-period">${esc(String(cycle.period).slice(0, 7))}</div><p class="project-data-note">${workItems.length} work item${workItems.length === 1 ? '' : 's'} · ${hours.toFixed(1)} recorded hours</p></div><span class="stage-pill stage-${esc(cycle.status === 'closed' ? 'complete' : 'active')}">${esc(displayStatus(cycle.status))}</span></div></article>`;
  }).join('')}</div>` : emptyState('No materialized operating cycles are available for this project yet.');

  sectionViews.details.innerHTML = `<section class="project-data-panel"><div class="section-label">Project record</div><dl class="project-detail-list"><div><dt>Client</dt><dd>${esc(project.client_name || 'Not recorded')}</dd></div><div><dt>Project status</dt><dd>${esc(project.status)}</dd></div><div><dt>Playbook</dt><dd>${esc(playbookName(project))}</dd></div><div><dt>Audit events retained</dt><dd>${sections.audit.length} recent events visible</dd></div></dl></section>`;
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
  if (input?.dataset.itemId) void persistSection(() => updateQualification({ itemId: input.dataset.itemId, complete: input.checked }));
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
