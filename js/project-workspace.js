import { supabase } from './supabase-client.js';

const projectId = new URLSearchParams(location.search).get('id');
const projectName = document.querySelector('#projectName');
const projectClient = document.querySelector('#projectClient');
const projectPlaybook = document.querySelector('#projectPlaybook');
const projectSummary = document.querySelector('#projectSummary');
const projectProgressBar = document.querySelector('#projectProgressBar');
const projectProgressCount = document.querySelector('#projectProgressCount');
const status = document.querySelector('#projectWorkspaceStatus');
const phases = document.querySelector('#projectPhases');

const labels = { pending: 'Pending', in_scope: 'In scope', na: 'N/A', active: 'Active', blocked: 'Blocked', client_review: 'Client review', complete: 'Complete', delivered: 'Delivered' };
const allowedTransitions = {
  pending: ['in_scope', 'na'], in_scope: ['active', 'na', 'blocked'], na: ['in_scope'], active: ['client_review', 'complete', 'blocked', 'in_scope', 'na'], blocked: ['na'], client_review: ['complete', 'active', 'blocked'], complete: ['delivered', 'active', 'blocked'], delivered: ['complete'],
};

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function setStatus(value = '') { status.textContent = value; }
function playbookName(row) { const version = Array.isArray(row.playbook_versions) ? row.playbook_versions[0] : row.playbook_versions; const playbook = version && (Array.isArray(version.playbooks) ? version.playbooks[0] : version.playbooks); return playbook?.name || 'Laminar project'; }
function phaseRow(row) { return Array.isArray(row.playbook_phases) ? row.playbook_phases[0] : row.playbook_phases; }

function render(project, tasks) {
  document.title = `${project.name} — Laminar Pipeline`;
  projectName.textContent = project.name;
  projectClient.textContent = project.client_name || 'No client name recorded';
  projectPlaybook.textContent = playbookName(project);
  const countable = tasks.filter(task => task.stage !== 'pending' && task.stage !== 'na');
  const done = tasks.filter(task => task.stage === 'complete' || task.stage === 'delivered').length;
  const percent = countable.length ? Math.round((done / countable.length) * 100) : 0;
  projectProgressBar.style.width = `${percent}%`;
  projectProgressCount.textContent = `${done} / ${countable.length}`;
  projectSummary.hidden = false;

  const grouped = new Map();
  for (const task of tasks) {
    const phase = phaseRow(task);
    if (!phase) continue;
    if (!grouped.has(phase.id)) grouped.set(phase.id, { phase, tasks: [] });
    grouped.get(phase.id).tasks.push(task);
  }
  phases.innerHTML = [...grouped.values()].sort((a, b) => a.phase.position - b.phase.position).map(({ phase, tasks: phaseTasks }) => `
    <section class="phase"><header class="phase-header"><span class="phase-tag" style="background:${esc(phase.color || '#4B8EFF')}">${esc(phase.label)}</span><div class="phase-title-wrap"><div class="phase-title">${esc(phase.title)}</div>${phase.objective ? `<div class="phase-objective">${esc(phase.objective)}</div>` : ''}</div><span class="phase-progress">${phaseTasks.filter(task => ['complete','delivered'].includes(task.stage)).length}/${phaseTasks.length}</span></header>
    <div class="phase-body">${phaseTasks.sort((a,b) => Number(a.sort_rank) - Number(b.sort_rank)).map(task => taskHtml(task)).join('')}</div></section>`).join('');
  phases.querySelectorAll('[data-task-transition]').forEach(button => button.addEventListener('click', () => void transition(button.dataset.taskTransition, button.dataset.to)));
}

function taskHtml(task) {
  const options = allowedTransitions[task.stage] || [];
  const blockedFrom = task.metadata?.blocked_from;
  if (task.stage === 'blocked' && blockedFrom && !options.includes(blockedFrom)) options.unshift(blockedFrom);
  return `<article class="item"><div class="item-row"><button class="stage-pill stage-${esc(task.stage)}" type="button">${esc(labels[task.stage] || task.stage)}</button><div class="item-content"><div class="item-label">${esc(task.title)}</div>${task.blocked_reason ? `<div class="item-hint">Blocked: ${esc(task.blocked_reason)}</div>` : ''}</div></div>${options.length ? `<div class="stage-menu open"><div class="stage-menu-inner"><span class="stage-menu-label">Move to</span><div class="stage-menu-options">${options.map(stage => `<button class="stage-option stage-${esc(stage)}" type="button" data-task-transition="${esc(task.id)}" data-to="${esc(stage)}">${esc(labels[stage])}</button>`).join('')}</div></div></div>` : ''}</article>`;
}

async function loadProject() {
  if (!projectId) { setStatus('Project ID is missing.'); return; }
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return;
  setStatus('Loading project…');
  const [projectResult, taskResult] = await Promise.all([
    supabase.from('projects').select('id,name,client_name,status,playbook_versions(playbooks(name,code))').eq('id', projectId).maybeSingle(),
    supabase.from('project_tasks').select('id,title,stage,sort_rank,blocked_reason,metadata,playbook_phases(id,position,label,title,objective,color)').eq('project_id', projectId),
  ]);
  if (projectResult.error || taskResult.error) { setStatus(projectResult.error?.message || taskResult.error?.message || 'Unable to load project.'); return; }
  if (!projectResult.data) { setStatus('This project is unavailable to your account.'); return; }
  render(projectResult.data, taskResult.data || []);
  setStatus('Changes are saved to Supabase and recorded in the project audit history.');
}

async function transition(taskId, toStage) {
  const button = phases.querySelector(`[data-task-transition="${CSS.escape(taskId)}"][data-to="${CSS.escape(toStage)}"]`);
  let blockedReason = null;
  if (toStage === 'blocked') {
    blockedReason = window.prompt('Why is this task blocked?');
    if (!blockedReason?.trim()) return;
  }
  if (button) button.disabled = true;
  setStatus(`Moving task to ${labels[toStage]}…`);
  const { error } = await supabase.rpc('transition_project_task', { p_task: taskId, p_to: toStage, p_blocked_reason: blockedReason });
  if (error) { setStatus(error.message); if (button) button.disabled = false; return; }
  await loadProject();
}

supabase.auth.onAuthStateChange((_event, session) => { if (session) void loadProject(); });
void loadProject();
