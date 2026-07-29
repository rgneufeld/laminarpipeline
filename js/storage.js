/**
 * Storage adapter — localStorage implementation.
 * The application must not access localStorage directly.
 * Swap this module to replace the storage provider.
 */

import { isValidTransition, validateDeliver } from './stages.js';

const FRAMEWORK_KEY  = 'lbs-framework-v1';
const LEGACY_BLP_KEY = 'lbs-launchpad-v2';
const LEGACY_SOC_KEY = 'lbs-social-v1';

// ── Auto-save file handle ─────────────────────────────────────────────────────
// Holds a FileSystemFileHandle (File System Access API) when the user has
// connected a backup file. saveState() writes to it on every change.

let _autoSaveHandle   = null;
let _autoSaveListener = null;  // (result: {ok, at, error?}) => void

export function getAutoSaveHandle()            { return _autoSaveHandle; }
export function setAutoSaveHandle(handle)      { _autoSaveHandle = handle; }
export function clearAutoSaveHandle()          { _autoSaveHandle = null; }
export function setAutoSaveListener(fn)        { _autoSaveListener = fn; }

async function _writeToFile(state) {
  if (!_autoSaveHandle) return;
  try {
    const writable = await _autoSaveHandle.createWritable();
    await writable.write(JSON.stringify(state));
    await writable.close();                          // must await — write doesn't commit until close
    if (_autoSaveListener) _autoSaveListener({ ok: true, at: new Date() });
  } catch (e) {
    console.warn('[Laminar] Auto-save write failed:', e);
    if (_autoSaveListener) _autoSaveListener({ ok: false, at: new Date(), error: e });
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const Storage = {
  get(key)       { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) { console.error('Storage write failed', e); } },
  remove(key)    { localStorage.removeItem(key); },
  keys()         { return Object.keys(localStorage); },
};

// ── Framework state ───────────────────────────────────────────────────────────

export function loadState() {
  return Storage.get(FRAMEWORK_KEY) || _newState();
}

export function saveState(state) {
  state.savedAt = new Date().toISOString();
  Storage.set(FRAMEWORK_KEY, state);
  _writeToFile(state);
}

function _newState() {
  return {
    schemaVersion: 2,
    savedAt: new Date().toISOString(),
    ui: { activeByPlaybook: {} },
    projects: {},
  };
}

// ── Task default ──────────────────────────────────────────────────────────────

function _defaultTask() {
  return { stage: 'pending', blockedFrom: null, note: { internal: '', client: '' }, log: [] };
}

// ── Project helpers ───────────────────────────────────────────────────────────

export function getActiveProjectId(playbookId) {
  return loadState().ui.activeByPlaybook[playbookId] || null;
}

export function setActiveProjectId(playbookId, projectId) {
  const s = loadState();
  s.ui.activeByPlaybook[playbookId] = projectId;
  saveState(s);
}

export function getProject(projectId) {
  return loadState().projects[projectId] || null;
}

export function mutateProject(projectId, fn) {
  const s = loadState();
  if (!s.projects[projectId]) return;
  fn(s.projects[projectId]);
  s.projects[projectId].updatedAt = new Date().toISOString();
  saveState(s);
}

export function listProjects(playbookId) {
  const s = loadState();
  return Object.values(s.projects)
    .filter(p => p.playbookId === playbookId)
    .sort((a, b) => a.clientName.localeCompare(b.clientName));
}

export function createProject(clientName, playbookId) {
  const s = loadState();
  const id = generateId();
  s.projects[id] = {
    id,
    clientName,
    playbookId,
    status: 'qualified',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    qualification: {},
    tasks: {},
    assets: {},
    deliverables: {},
    training: {},
  };
  s.ui.activeByPlaybook[playbookId] = id;
  saveState(s);
  return id;
}

export function renameProject(projectId, newName) {
  mutateProject(projectId, p => { p.clientName = newName; });
}

export function deleteProject(projectId) {
  const s = loadState();
  const playbookId = s.projects[projectId]?.playbookId;
  delete s.projects[projectId];
  if (playbookId && s.ui.activeByPlaybook[playbookId] === projectId) {
    const remaining = Object.values(s.projects).filter(p => p.playbookId === playbookId);
    s.ui.activeByPlaybook[playbookId] = remaining.length ? remaining[0].id : null;
  }
  saveState(s);
  return s.ui.activeByPlaybook[playbookId] || null;
}

export function resetProjectTasks(projectId) {
  mutateProject(projectId, p => { p.tasks = {}; });
}

// ── Task helpers ──────────────────────────────────────────────────────────────

export function getTask(project, key) {
  return project.tasks[key] || _defaultTask();
}

// Transition a task to a new stage. Returns { ok, error?, task? }.
// Validates the transition and appends a log entry. The task's current note
// is snapshotted into the log entry at transition time. Pass logNote to
// override what goes into the log entry (used by bulk operations).
export function transitionTask(projectId, key, toStage, logNote = null) {
  const s = loadState();
  const project = s.projects[projectId];
  if (!project) return { ok: false, error: 'Project not found' };

  const task = project.tasks[key] || _defaultTask();
  const fromStage = task.stage || 'pending';

  if (!isValidTransition(fromStage, toStage, task.blockedFrom)) {
    return { ok: false, error: `Cannot move from "${fromStage}" to "${toStage}".` };
  }

  if (toStage === 'delivered') {
    const err = validateDeliver(task);
    if (err) return { ok: false, error: err };
  }

  const entryNote = logNote
    ? { internal: logNote.internal || '', client: logNote.client || '' }
    : { internal: task.note?.internal || '', client: task.note?.client || '' };
  const entry = { stage: toStage, at: new Date().toISOString(), note: entryNote };

  const updatedTask = {
    stage:       toStage,
    blockedFrom: toStage === 'blocked' ? fromStage : null,
    note:        task.note || { internal: '', client: '' },
    log:         [...(task.log || []), entry],
  };

  project.tasks[key] = updatedTask;
  project.updatedAt = new Date().toISOString();
  s.savedAt = new Date().toISOString();
  Storage.set(FRAMEWORK_KEY, s);
  _writeToFile(s);

  return { ok: true, task: updatedTask };
}

// Update a task's current note without creating a log entry.
// field: 'internal' | 'client'
export function updateTaskNote(projectId, key, field, value) {
  const s = loadState();
  const project = s.projects[projectId];
  if (!project) return;
  if (!project.tasks[key]) project.tasks[key] = _defaultTask();
  if (!project.tasks[key].note) project.tasks[key].note = { internal: '', client: '' };
  project.tasks[key].note[field] = value;
  project.updatedAt = new Date().toISOString();
  s.savedAt = new Date().toISOString();
  Storage.set(FRAMEWORK_KEY, s);
  _writeToFile(s);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Cycle helpers ─────────────────────────────────────────────────────────────

// Upgrades a cycle's work items and time entries to the current schema without
// persisting — the first mutateCycle call will permanently write the new shape.
function _migrateCycleData(cycle) {
  const work = (cycle.work || []).map(w => {
    if (w.title !== undefined) return w;
    return {
      id: w.id || generateId(),
      title: w.initiative || '',
      priorityId: null,
      roadmapRef: '',
      description: '',
      owner: 'laminar',
      status: w.status || 'planned',
      plannedHours: w.plannedHours || 0,
      targetOutcome: '',
      dueDate: '',
      dependency: '',
      evidence: '',
      separateScope: false,
      archived: false,
      notes: w.notes || '',
    };
  });
  const timeEntries = (cycle.capacity?.timeEntries || []).map(e => ({
    ...e,
    workItemId:      e.workItemId      !== undefined ? e.workItemId      : null,
    billingCategory: e.billingCategory !== undefined ? e.billingCategory : 'included',
  }));
  return { ...cycle, work, capacity: { ...cycle.capacity, timeEntries } };
}

export function getCycles(projectId) {
  const project = getProject(projectId);
  if (!project) return [];
  return Object.values(project.cycles || {})
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(_migrateCycleData);
}

export function getCycle(projectId, cycleId) {
  const project = getProject(projectId);
  const c = project?.cycles?.[cycleId] || null;
  return c ? _migrateCycleData(c) : null;
}

export function createCycle(projectId, period) {
  const s = loadState();
  const project = s.projects[projectId];
  if (!project) return null;
  if (!project.cycles) project.cycles = {};
  if (Object.values(project.cycles).find(c => c.period === period)) return null;

  const prevCycles = Object.values(project.cycles)
    .filter(c => c.period < period)
    .sort((a, b) => b.period.localeCompare(a.period));
  const prev = prevCycles[0] || null;

  const carryForward = (prev?.closeout?.deferredWork || [])
    .filter(d => d.disposition === 'carry-forward')
    .map(d => ({ id: generateId(), label: d.text, estimatedHours: 0, notes: 'Carried forward' }));

  const id  = generateId();
  const now = new Date().toISOString();

  project.cycles[id] = {
    id, period, status: 'draft', startDate: '', endDate: '',
    capacity: { includedHours: 20, approvedAdditionalHours: 0, timeEntries: [] },
    plan: { primaryObjective: '', priorities: carryForward, clientResponsibilities: [] },
    work: [],
    governance: { decisions: [], blockers: [], clientActions: [] },
    deliverables: {
      operatingReview: { status: 'pending', completedAt: '', notes: '' },
      roadmapUpdate:   { status: 'pending', completedAt: '', notes: '' },
      capacityReport:  { status: 'pending', completedAt: '', notes: '' },
      kpiReview:       { status: 'pending', completedAt: '', notes: '' },
    },
    closeout: {
      outcomes: [], deferredWork: [], nextCycleRecommendations: '',
      clientAcknowledgement: { status: 'pending', receivedAt: '', notes: '' },
    },
    locked: false, closedAt: null, closureSnapshot: null,
    auditLog: [{ timestamp: now, action: 'cycle_created' }],
  };

  project.updatedAt = now;
  saveState(s);
  return id;
}

export function mutateCycle(projectId, cycleId, fn) {
  const s = loadState();
  const project = s.projects[projectId];
  if (!project?.cycles?.[cycleId]) return;
  if (project.cycles[cycleId].locked) return;
  // Migrate before mutation so fn always operates on current schema
  const migrated = _migrateCycleData(project.cycles[cycleId]);
  Object.assign(project.cycles[cycleId], migrated);
  fn(project.cycles[cycleId]);
  project.updatedAt = new Date().toISOString();
  saveState(s);
}

export function closeCycle(projectId, cycleId) {
  const s = loadState();
  const project = s.projects[projectId];
  if (!project?.cycles?.[cycleId]) return false;
  const cycle = project.cycles[cycleId];
  const now   = new Date().toISOString();
  cycle.closureSnapshot = { capturedAt: now, cycleData: JSON.parse(JSON.stringify(cycle)) };
  cycle.locked   = true;
  cycle.closedAt = now;
  cycle.status   = 'closed';
  cycle.auditLog = [...(cycle.auditLog || []), { timestamp: now, action: 'cycle_closed' }];
  project.updatedAt = now;
  saveState(s);
  return true;
}

export function reopenCycle(projectId, cycleId, reason) {
  const s = loadState();
  const project = s.projects[projectId];
  if (!project?.cycles?.[cycleId]) return false;
  const cycle = project.cycles[cycleId];
  const now   = new Date().toISOString();
  cycle.locked = false;
  cycle.status = 'active';
  cycle.auditLog = [...(cycle.auditLog || []), { timestamp: now, action: 'cycle_reopened', reason }];
  project.updatedAt = now;
  saveState(s);
  return true;
}

// ── Migration ─────────────────────────────────────────────────────────────────

export function migrateIfNeeded() {
  const existing = Storage.get(FRAMEWORK_KEY);

  // No data at all — check for legacy tool data to import
  if (!existing) {
    const s = _newState();
    let firstId = null;

    const blp = Storage.get(LEGACY_BLP_KEY);
    if (blp?.clients) {
      const active = blp.active;
      Object.entries(blp.clients).forEach(([name, client]) => {
        const id = generateId();
        s.projects[id] = _fromLegacy(id, name, 'business-launch', client);
        if (name === active || !firstId) firstId = id;
      });
      if (firstId) s.ui.activeByPlaybook['business-launch'] = firstId;
      firstId = null;
    }

    const soc = Storage.get(LEGACY_SOC_KEY);
    if (soc?.clients) {
      const active = soc.active;
      Object.entries(soc.clients).forEach(([name, client]) => {
        const id = generateId();
        s.projects[id] = _fromLegacy(id, name, 'digital-presence-launch', client);
        if (name === active || !firstId) firstId = id;
      });
      if (firstId) s.ui.activeByPlaybook['digital-presence-launch'] = firstId;
    }

    saveState(s);
    return;
  }

  // v1 → v2: convert flat { completed, skipped, notes } tasks to stage + log model
  if (existing.schemaVersion === 1) {
    const migrationAt = new Date().toISOString();
    Object.values(existing.projects || {}).forEach(project => {
      const newTasks = {};
      Object.entries(project.tasks || {}).forEach(([key, t]) => {
        newTasks[key] = _migrateTaskV1toV2(t, migrationAt);
      });
      project.tasks = newTasks;
    });
    existing.schemaVersion = 2;
    saveState(existing);
    return;
  }
}

function _migrateTaskV1toV2(t, migrationAt) {
  if (t.log !== undefined) return t; // already v2

  const note = { internal: t.notes?.internal || '', client: t.notes?.client || '' };

  if (t.skipped) {
    return {
      stage: 'na', blockedFrom: null, note,
      log: [{ stage: 'na', at: migrationAt, note }],
    };
  }
  if (t.completed) {
    return {
      stage: 'complete', blockedFrom: null, note,
      log: [{ stage: 'complete', at: migrationAt, note }],
    };
  }
  // Pending — carry any existing note forward in a pending log entry
  const log = (note.internal || note.client)
    ? [{ stage: 'pending', at: migrationAt, note }]
    : [];
  return { stage: 'pending', blockedFrom: null, note, log };
}

const STATUS_MAP = {
  discovery:       'qualified',
  'in-progress':   'active',
  'waiting-client':'blocked',
  'client-review': 'client-review',
  'ready-launch':  'ready-launch',
  live:            'live',
};

function _fromLegacy(id, clientName, playbookId, client) {
  const migrationAt = new Date().toISOString();
  const tasks = {};
  const merge = (key, updates) => {
    tasks[key] = { ...{ completed: false, skipped: false, notes: { internal: '', client: '' } }, ...(tasks[key] || {}), ...updates };
  };
  Object.entries(client.checks  || {}).forEach(([k, v]) => merge(k, { completed: !!v }));
  Object.entries(client.skipped || {}).forEach(([k, v]) => merge(k, { skipped:   !!v }));
  Object.entries(client.notes   || {}).forEach(([k, n]) => {
    const internal = typeof n === 'string' ? n : (n?.internal || '');
    const cl       = typeof n === 'object' && n ? (n.client || '') : '';
    merge(k, { notes: { internal, client: cl } });
  });

  // Immediately migrate to v2 task shape
  const v2Tasks = {};
  Object.entries(tasks).forEach(([key, t]) => {
    v2Tasks[key] = _migrateTaskV1toV2(t, migrationAt);
  });

  return {
    id, clientName, playbookId,
    status: STATUS_MAP[client.status] || 'active',
    createdAt: migrationAt,
    updatedAt: migrationAt,
    qualification: {}, tasks: v2Tasks, assets: {}, deliverables: {}, training: {},
  };
}
