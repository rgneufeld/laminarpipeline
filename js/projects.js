import { supabase } from './supabase-client.js';

const projectList = document.querySelector('#projectList');
const workspaceStatus = document.querySelector('#workspaceStatus');
const showCreateProject = document.querySelector('#showCreateProject');
const createPanel = document.querySelector('#projectCreatePanel');
const createForm = document.querySelector('#projectCreateForm');
const cancelCreate = document.querySelector('#cancelCreateProject');
const createSubmit = document.querySelector('#createProjectSubmit');
const formMessage = document.querySelector('#projectFormMessage');
const versionSelect = document.querySelector('#playbookVersion');
const projectName = document.querySelector('#projectName');
const clientName = document.querySelector('#clientName');

let organisationId = null;
let canCreateProjects = false;

function setWorkspaceStatus(value) {
  workspaceStatus.textContent = value;
}

function setFormMessage(value = '') {
  formMessage.textContent = value;
}

function projectPlaybook(row) {
  const version = Array.isArray(row.playbook_versions) ? row.playbook_versions[0] : row.playbook_versions;
  const playbook = version && (Array.isArray(version.playbooks) ? version.playbooks[0] : version.playbooks);
  return playbook?.name || 'Laminar playbook';
}

function renderProjects(projects, taskCounts) {
  projectList.innerHTML = '';
  if (!projects.length) {
    projectList.innerHTML = '<p class="projects-empty">No projects are currently assigned to you.</p>';
    return;
  }

  for (const project of projects) {
    const card = document.createElement('article');
    card.className = 'project-workspace-card';
    const taskCount = taskCounts.get(project.id) || 0;
    card.innerHTML = `
      <div class="project-workspace-type">${escapeHtml(projectPlaybook(project))}</div>
      <h2>${escapeHtml(project.name)}</h2>
      <p>${escapeHtml(project.client_name || 'No client name recorded')}</p>
      <div class="project-workspace-meta">${taskCount} delivery tasks · ${escapeHtml(project.status)}</div>
    `;
    projectList.append(card);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function loadWorkspace() {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return;

  setWorkspaceStatus('Loading projects…');
  const { data: organisations, error: organisationError } = await supabase
    .from('organisations')
    .select('id,name')
    .order('created_at', { ascending: true })
    .limit(1);
  if (organisationError || !organisations?.length) {
    setWorkspaceStatus(organisationError?.message || 'No organisation is available for this account.');
    return;
  }

  organisationId = organisations[0].id;
  const { data: memberships } = await supabase
    .from('organisation_memberships')
    .select('role')
    .eq('organisation_id', organisationId)
    .eq('user_id', sessionData.session.user.id)
    .limit(1);
  const role = memberships?.[0]?.role;
  canCreateProjects = role === 'organisation_owner' || role === 'delivery_manager';
  showCreateProject.hidden = !canCreateProjects;

  const [projectResult, versionResult] = await Promise.all([
    supabase
      .from('projects')
      .select('id,name,client_name,status,updated_at,playbook_versions(playbooks(name,code))')
      .order('updated_at', { ascending: false }),
    supabase
      .from('playbook_versions')
      .select('id,version_number,playbooks(name,code)')
      .eq('status', 'published')
      .order('created_at', { ascending: true }),
  ]);

  if (projectResult.error) {
    setWorkspaceStatus(projectResult.error.message);
    return;
  }
  if (versionResult.error) {
    setWorkspaceStatus(versionResult.error.message);
    return;
  }

  versionSelect.innerHTML = '';
  for (const version of versionResult.data || []) {
    const playbook = Array.isArray(version.playbooks) ? version.playbooks[0] : version.playbooks;
    const option = document.createElement('option');
    option.value = version.id;
    option.textContent = `${playbook?.name || 'Laminar playbook'} · v${version.version_number}`;
    versionSelect.append(option);
  }

  const projects = projectResult.data || [];
  const taskCounts = new Map();
  if (projects.length) {
    const { data: tasks, error: taskError } = await supabase
      .from('project_tasks')
      .select('project_id')
      .in('project_id', projects.map(project => project.id));
    if (taskError) {
      setWorkspaceStatus(taskError.message);
      return;
    }
    for (const task of tasks || []) taskCounts.set(task.project_id, (taskCounts.get(task.project_id) || 0) + 1);
  }

  renderProjects(projects, taskCounts);
  setWorkspaceStatus(`${projects.length} project${projects.length === 1 ? '' : 's'} accessible to you.`);
}

function toggleCreatePanel(open) {
  createPanel.hidden = !open;
  if (open) {
    setFormMessage();
    projectName.focus();
  }
}

showCreateProject.addEventListener('click', () => toggleCreatePanel(true));
cancelCreate.addEventListener('click', () => toggleCreatePanel(false));

createForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!organisationId || !canCreateProjects || !versionSelect.value) return;

  createSubmit.disabled = true;
  createSubmit.textContent = 'Creating…';
  setFormMessage('Creating project and its pinned task set…');
  const { error } = await supabase.rpc('create_project_from_playbook', {
    p_organisation_id: organisationId,
    p_playbook_version_id: versionSelect.value,
    p_name: projectName.value.trim(),
    p_client_name: clientName.value.trim() || null,
  });
  createSubmit.disabled = false;
  createSubmit.textContent = 'Create project';
  if (error) {
    setFormMessage(error.message);
    return;
  }

  createForm.reset();
  toggleCreatePanel(false);
  await loadWorkspace();
});

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) void loadWorkspace();
});

void loadWorkspace();
