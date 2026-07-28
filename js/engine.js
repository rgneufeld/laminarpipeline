/**
 * Playbook Engine — rendering, interactions, and progress calculation.
 * All sections are rendered by this module. No section renders HTML on its own.
 * Uses event delegation: no onclick attributes in generated HTML.
 */

import { escHtml, autoResize, ICONS } from './ui.js';
import {
  getProject, mutateProject, getTask,
  transitionTask, updateTaskNote, generateId,
} from './storage.js';
import * as Cycles from './cycles.js';
import {
  STAGE_META, isValidTransition, getValidTransitions, validateDeliver,
  isRescope, BLOCK_UNAVAILABLE, COUNTABLE_STAGES, DONE_STAGES,
} from './stages.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _playbook         = null;
let _projectId        = null;
let _onUpdate         = null;
let _phasesContainer  = null;

// Tracks pending rescope transitions waiting for a client note: "phaseId-idx" → toStage
const _pendingRescopes = new Map();

// Tracks pending phase bulk transitions: phaseId → { toStage, requiresClientNote, note }
const _pendingBulkStages = new Map();

// Active stage filter chips — set of stage strings currently selected
const _activeFilters = new Set();

export function init(playbook, projectId, onUpdateCallback) {
  _playbook  = playbook;
  _projectId = projectId;
  _onUpdate  = onUpdateCallback || (() => {});
}

export function setProject(projectId) {
  _projectId        = projectId;
  _phasesContainer  = null;
  _pendingRescopes.clear();
  _pendingBulkStages.clear();
  _activeFilters.clear();
  Cycles.resetCycles();
}

// ── Public render API ─────────────────────────────────────────────────────────

export function renderSection(name, container) {
  switch (name) {
    case 'phases':        renderPhases(container);                                              break;
    case 'qualification': renderQualification(container);                                       break;
    case 'assets':        renderAssets(container);                                              break;
    case 'deliverables':  renderDeliverables(container);                                        break;
    case 'training':      renderTraining(container);                                            break;
    case 'cycles':        Cycles.renderCycles(container, _playbook, _projectId, _onUpdate);    break;
  }
}

// ── Progress / summary ────────────────────────────────────────────────────────

export function getProgress() {
  const project = getProject(_projectId);
  if (!project) return { done: 0, total: 0, pct: 0, currentPhase: null, clientActions: 0 };
  let done = 0, total = 0, clientActions = 0;
  _playbook.phases.forEach(phase => {
    phase.tasks.forEach((task, idx) => {
      const key   = `${phase.id}-${idx}`;
      const ts    = getTask(project, key);
      const stage = ts.stage || 'pending';
      if (!COUNTABLE_STAGES.has(stage)) return;
      total++;
      if (DONE_STAGES.has(stage)) done++;
      if (task.clientAction && !DONE_STAGES.has(stage)) clientActions++;
    });
  });
  const pct          = total ? Math.round(done / total * 100) : 0;
  const currentPhase = _currentPhase(project);
  return { done, total, pct, currentPhase, clientActions };
}

export function getMissingAssetCount() {
  const project = getProject(_projectId);
  if (!project) return 0;
  return (_playbook.assets || []).filter(def => {
    if (!def.required) return false;
    const state = (project.assets || {})[def.id];
    return !state || state.status === 'missing' || !state.status;
  }).length;
}

export function getQualProgress() {
  const project = getProject(_projectId);
  if (!project || !_playbook.qualification?.length) return null;
  const done  = _playbook.qualification.filter(q => !!(project.qualification || {})[q.id]?.value).length;
  const total = _playbook.qualification.length;
  return { done, total };
}

// ── Phases section ────────────────────────────────────────────────────────────

function renderPhases(container) {
  const project = getProject(_projectId);
  if (!project) { container.innerHTML = _empty('No project selected.'); return; }
  _phasesContainer = container;

  const filterBarHTML = _renderFilterBar(_buildStageCounts(project));

  container.innerHTML = filterBarHTML + _playbook.phases.map(phase => {
    let phaseDone = 0, phaseTotal = 0;
    const itemsHTML = phase.tasks.map((task, idx) => {
      const key   = `${phase.id}-${idx}`;
      const ts    = getTask(project, key);
      const stage = ts.stage || 'pending';
      if (COUNTABLE_STAGES.has(stage)) { phaseTotal++; if (DONE_STAGES.has(stage)) phaseDone++; }
      return _itemHTML(phase.id, task, idx, ts);
    }).join('');

    const objHTML     = phase.objective   ? `<span class="phase-objective">${escHtml(phase.objective)}</span>` : '';
    const secNoteHTML = phase.sectionNote ? `<div class="section-note"><strong>Note:</strong> ${escHtml(phase.sectionNote)}</div>` : '';

    const bulkStages = ['in-scope', 'na', 'active', 'client-review', 'complete', 'delivered', 'blocked'];
    const bulkOptions = bulkStages.map(to => {
      const tm = STAGE_META[to];
      return `<button class="stage-option" data-action="phase-bulk-stage" data-phase="${phase.id}" data-to="${to}"
        style="background:var(${tm.bgVar});color:var(${tm.colorVar})">${escHtml(tm.label)}</button>`;
    }).join('');

    return `<div class="phase" id="phase-${phase.id}">
      <div class="phase-header" data-action="phase-toggle" data-phase="${phase.id}">
        <span class="phase-tag" style="background:${phase.color}">${escHtml(phase.tag)}</span>
        <div class="phase-title-wrap">
          <span class="phase-title">${escHtml(phase.title)}</span>${objHTML}
        </div>
        <span class="phase-progress" id="prog-${phase.id}">${phaseDone}/${phaseTotal}</span>
        <button class="phase-bulk-btn" data-action="phase-bulk-toggle" data-phase="${phase.id}" title="Bulk set all tasks in this phase to a stage">Set all</button>
        ${ICONS.chevron}
      </div>
      <div class="phase-bulk-menu" id="phase-bulk-${phase.id}">
        <div class="phase-bulk-stages">
          <span class="stage-menu-label">Set all tasks to</span>
          <div class="stage-menu-options">${bulkOptions}</div>
        </div>
        <div class="phase-bulk-note" id="phase-bulk-note-${phase.id}" style="display:none">
          <div class="note-field">
            <div class="note-field-label">Internal note <span class="note-field-tag">Laminar only</span></div>
            <textarea class="note-textarea" data-action="phase-bulk-note-internal" data-phase="${phase.id}"
              placeholder="Internal context for this bulk change…" rows="2"></textarea>
          </div>
          <div class="note-field note-field--client">
            <div class="note-field-label note-field-label--client">Client note <span class="note-field-tag note-field-tag--client">appears in client report</span></div>
            <textarea class="note-textarea note-textarea--client" data-action="phase-bulk-note-client" data-phase="${phase.id}"
              placeholder="Client-facing explanation of this scope change…" rows="2"></textarea>
          </div>
          <div class="phase-bulk-actions">
            <span class="phase-bulk-summary" id="phase-bulk-summary-${phase.id}"></span>
            <div class="phase-bulk-btns">
              <button class="btn btn-primary btn-sm" data-action="phase-bulk-confirm" data-phase="${phase.id}">Apply</button>
              <button class="btn btn-ghost btn-sm"   data-action="phase-bulk-cancel"  data-phase="${phase.id}">Cancel</button>
            </div>
          </div>
        </div>
      </div>
      <div class="phase-body">${itemsHTML}${secNoteHTML}</div>
    </div>`;
  }).join('');

  _attachPhaseEvents(container);
  if (_activeFilters.size > 0) _applyFilters();
}

function _itemHTML(phaseId, task, idx, ts) {
  const stage      = ts.stage || 'pending';
  const meta       = STAGE_META[stage] || STAGE_META['pending'];
  const isNA       = stage === 'na';
  const isBlocked  = stage === 'blocked';
  const blockAvail = !BLOCK_UNAVAILABLE.has(stage);
  const hasInt     = !!(ts.note?.internal);
  const hasClient  = !!(ts.note?.client);
  const hasNote    = hasInt || hasClient;

  const transitions  = getValidTransitions(stage, ts.blockedFrom);
  const hintHTML     = task.hint ? `<div class="item-hint">${escHtml(task.hint)}</div>` : '';
  const subsHTML     = task.subs ? `<div class="sub-items">${task.subs.map(s => `<span class="sub-item">${escHtml(s)}</span>`).join('')}</div>` : '';
  const clientBadge  = task.clientAction ? `<span class="client-action-badge">Client</span>` : '';

  const menuOptions = transitions.map(to => {
    const tm     = STAGE_META[to] || STAGE_META['pending'];
    const rescopeAttr = isRescope(stage, to) ? ' data-rescope="1"' : '';
    return `<button class="stage-option" data-action="stage-transition" data-phase="${phaseId}" data-idx="${idx}" data-to="${escHtml(to)}"${rescopeAttr}
      style="background:var(${tm.bgVar});color:var(${tm.colorVar})">${escHtml(tm.label)}</button>`;
  }).join('');

  const noteIntVal    = escHtml(ts.note?.internal || '');
  const noteClientVal = escHtml(ts.note?.client   || '');

  return `<div class="item" data-stage="${escHtml(stage)}" id="item-${phaseId}-${idx}">
    <div class="item-row">
      <button class="stage-pill" data-action="stage-menu-toggle" data-phase="${phaseId}" data-idx="${idx}"
        style="background:var(${meta.bgVar});color:var(${meta.colorVar})"
        title="Change stage">${escHtml(meta.label)}</button>
      <div class="item-content">
        <div class="item-label">${escHtml(task.label)}</div>
        ${hintHTML}${subsHTML}
      </div>
      ${clientBadge}
      ${blockAvail
        ? `<button class="icon-btn block-btn${isBlocked ? ' block-active' : ''}" data-action="toggle-blocked"
            data-phase="${phaseId}" data-idx="${idx}" title="${isBlocked ? 'Unblock' : 'Mark blocked'}">${ICONS.na}</button>`
        : ''}
      <button class="icon-btn${hasNote ? ' has-note' : ''}" id="notebtn-${phaseId}-${idx}"
        data-action="note" data-phase="${phaseId}" data-idx="${idx}"
        title="${hasNote ? 'Edit notes' : 'Add note'}">${hasNote ? ICONS.noteFilled : ICONS.noteOutline}</button>
    </div>
    <div class="stage-menu" id="stage-menu-${phaseId}-${idx}">
      <div class="stage-menu-inner">
        <span class="stage-menu-label">Move to</span>
        <div class="stage-menu-options">${menuOptions}</div>
      </div>
    </div>
    <div class="note-wrap" id="note-wrap-${phaseId}-${idx}">
      <div class="note-field">
        <div class="note-field-label">Internal note <span class="note-field-tag">Laminar only</span></div>
        <textarea class="note-textarea" data-action="note-internal" data-phase="${phaseId}" data-idx="${idx}"
          placeholder="Internal context, blockers, or progress notes…" rows="2">${noteIntVal}</textarea>
      </div>
      <div class="note-field note-field--client">
        <div class="note-field-label note-field-label--client">Client note <span class="note-field-tag note-field-tag--client">appears in client report</span></div>
        <textarea class="note-textarea note-textarea--client" data-action="note-client" data-phase="${phaseId}" data-idx="${idx}"
          placeholder="Client-facing context or scope explanation…" rows="2">${noteClientVal}</textarea>
      </div>
      <div class="note-rescope-bar" id="rescope-bar-${phaseId}-${idx}" style="display:none">
        <span class="note-rescope-msg">A client note is required to explain this scope change.</span>
        <button class="btn btn-primary btn-sm" data-action="rescope-confirm" data-phase="${phaseId}" data-idx="${idx}">Confirm</button>
        <button class="btn btn-ghost btn-sm"   data-action="rescope-cancel"  data-phase="${phaseId}" data-idx="${idx}">Cancel</button>
      </div>
    </div>
  </div>`;
}

function _attachPhaseEvents(container) {
  container.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) { _closeAllMenus(container); return; }
    const { action, phase, idx, to, rescope } = el.dataset;
    const i = +idx;
    if (action === 'stage-menu-toggle')      _handleStageMenuToggle(container, phase, i);
    if (action === 'stage-transition')       _handleStageTransition(container, phase, i, to, rescope === '1');
    if (action === 'toggle-blocked')         _handleToggleBlocked(phase, i);
    if (action === 'note')                   _handleNoteToggle(phase, i);
    if (action === 'rescope-confirm')        _handleRescapeConfirm(phase, i);
    if (action === 'rescope-cancel')         _handleRescapeCancel(phase, i);
    if (action === 'phase-bulk-toggle')      _handlePhaseBulkToggle(phase);
    if (action === 'phase-bulk-stage')       _handlePhaseBulkStage(phase, to);
    if (action === 'phase-bulk-confirm')     _handlePhaseBulkConfirm(phase);
    if (action === 'phase-bulk-cancel')      _handlePhaseBulkCancel(phase);
    if (action === 'phase-toggle')           _handlePhaseToggle(el.closest('.phase'));
    if (action === 'filter-chip') {
      const stage = el.dataset.stage;
      if (_activeFilters.has(stage)) _activeFilters.delete(stage); else _activeFilters.add(stage);
      _applyFilters();
    }
    if (action === 'filter-clear') { _activeFilters.clear(); _applyFilters(); }
  });
  container.addEventListener('input', e => {
    const { action, phase, idx } = e.target.dataset;
    const i = +idx;
    if (action === 'note-internal')            { _handleNoteSave(phase, i, 'internal', e.target.value); autoResize(e.target); }
    if (action === 'note-client')              { _handleNoteSave(phase, i, 'client',   e.target.value); autoResize(e.target); }
    if (action === 'phase-bulk-note-internal') { _handlePhaseBulkNoteSave(phase, 'internal', e.target.value); autoResize(e.target); }
    if (action === 'phase-bulk-note-client')   { _handlePhaseBulkNoteSave(phase, 'client',   e.target.value); autoResize(e.target); }
  });
}

// ── Stage menu ────────────────────────────────────────────────────────────────

function _handleStageMenuToggle(container, phaseId, idx) {
  const menuEl = document.getElementById(`stage-menu-${phaseId}-${idx}`);
  if (!menuEl) return;
  const isOpen = menuEl.classList.contains('open');
  _closeAllMenus(container);
  if (!isOpen) menuEl.classList.add('open');
}

function _closeAllMenus(container) {
  container.querySelectorAll('.stage-menu.open').forEach(m => m.classList.remove('open'));
}

// ── Stage transition ──────────────────────────────────────────────────────────

function _handleStageTransition(container, phaseId, idx, toStage, needsClientNote) {
  // Close stage menu
  const menuEl = document.getElementById(`stage-menu-${phaseId}-${idx}`);
  if (menuEl) menuEl.classList.remove('open');

  if (needsClientNote) {
    // Check if client note already has content
    const project = getProject(_projectId);
    const ts = getTask(project, `${phaseId}-${idx}`);
    if (!(ts.note?.client || '').trim()) {
      // Register pending rescope and open note panel with prompt
      _pendingRescopes.set(`${phaseId}-${idx}`, toStage);
      _openNotePanel(phaseId, idx, true);
      return;
    }
  }

  _fireTransition(phaseId, idx, toStage);
}

function _fireTransition(phaseId, idx, toStage) {
  const result = transitionTask(_projectId, `${phaseId}-${idx}`, toStage);
  if (!result.ok) {
    alert(result.error);
    return;
  }
  _pendingRescopes.delete(`${phaseId}-${idx}`);
  _rerenderItem(phaseId, idx);
  _updatePhaseProgress(phaseId);
  _refreshFilterBar();
  _applyFilters();
  _onUpdate();
}

function _handleToggleBlocked(phaseId, idx) {
  const project = getProject(_projectId);
  const ts = getTask(project, `${phaseId}-${idx}`);
  const toStage = ts.stage === 'blocked' ? (ts.blockedFrom || 'in-scope') : 'blocked';
  _fireTransition(phaseId, idx, toStage);
}

// ── Rescope confirm / cancel ──────────────────────────────────────────────────

function _handleRescapeConfirm(phaseId, idx) {
  const key = `${phaseId}-${idx}`;
  const project = getProject(_projectId);
  const ts = getTask(project, key);
  if (!(ts.note?.client || '').trim()) {
    const barEl = document.getElementById(`rescope-bar-${phaseId}-${idx}`);
    if (barEl) {
      barEl.querySelector('.note-rescope-msg').textContent = 'Please add a client note before confirming.';
    }
    return;
  }
  const toStage = _pendingRescopes.get(key);
  if (!toStage) return;
  _hideRescapeBar(phaseId, idx);
  _fireTransition(phaseId, idx, toStage);
}

function _handleRescapeCancel(phaseId, idx) {
  _pendingRescopes.delete(`${phaseId}-${idx}`);
  _hideRescapeBar(phaseId, idx);
  _closeNotePanel(phaseId, idx);
}

function _hideRescapeBar(phaseId, idx) {
  const barEl = document.getElementById(`rescope-bar-${phaseId}-${idx}`);
  if (barEl) barEl.style.display = 'none';
}

// ── Note panel ────────────────────────────────────────────────────────────────

function _handleNoteToggle(phaseId, idx) {
  const wrapEl = document.getElementById(`note-wrap-${phaseId}-${idx}`);
  if (!wrapEl) return;
  if (wrapEl.classList.contains('open')) {
    // Don't close if there's a pending rescope
    if (_pendingRescopes.has(`${phaseId}-${idx}`)) return;
    _closeNotePanel(phaseId, idx);
  } else {
    _openNotePanel(phaseId, idx, false);
  }
}

function _openNotePanel(phaseId, idx, showRescapeBar) {
  const wrapEl = document.getElementById(`note-wrap-${phaseId}-${idx}`);
  if (!wrapEl) return;
  wrapEl.classList.add('open');
  const barEl = document.getElementById(`rescope-bar-${phaseId}-${idx}`);
  if (barEl) {
    barEl.style.display = showRescapeBar ? 'flex' : 'none';
    if (showRescapeBar) barEl.querySelector('.note-rescope-msg').textContent = 'A client note is required to explain this scope change.';
  }
  // Update note button state
  const btnEl = document.getElementById(`notebtn-${phaseId}-${idx}`);
  if (btnEl) btnEl.classList.add('open');
  // Focus client textarea if rescope bar is showing, else internal
  const textareas = wrapEl.querySelectorAll('textarea');
  const ta = showRescapeBar ? textareas[1] : textareas[0];
  if (ta) { ta.focus(); autoResize(ta); }
}

function _closeNotePanel(phaseId, idx) {
  const wrapEl = document.getElementById(`note-wrap-${phaseId}-${idx}`);
  if (wrapEl) wrapEl.classList.remove('open');
  const btnEl = document.getElementById(`notebtn-${phaseId}-${idx}`);
  if (btnEl) btnEl.classList.remove('open');
  _hideRescapeBar(phaseId, idx);
}

function _handleNoteSave(phaseId, idx, field, value) {
  updateTaskNote(_projectId, `${phaseId}-${idx}`, field, value);
  // Update note button icon
  const project = getProject(_projectId);
  const ts = getTask(project, `${phaseId}-${idx}`);
  const hasNote = !!(ts.note?.internal) || !!(ts.note?.client);
  const btnEl = document.getElementById(`notebtn-${phaseId}-${idx}`);
  if (btnEl) {
    btnEl.classList.toggle('has-note', hasNote);
    btnEl.innerHTML = hasNote ? ICONS.noteFilled : ICONS.noteOutline;
  }
}

// ── Phase bulk actions ────────────────────────────────────────────────────────

function _handlePhaseBulkToggle(phaseId) {
  const menuEl = document.getElementById(`phase-bulk-${phaseId}`);
  if (!menuEl) return;
  const isOpen = menuEl.classList.contains('open');
  // Close all other bulk menus first
  document.querySelectorAll('.phase-bulk-menu.open').forEach(m => m.classList.remove('open'));
  _pendingBulkStages.clear();
  if (!isOpen) menuEl.classList.add('open');
}

function _handlePhaseBulkStage(phaseId, toStage) {
  const phase   = _playbook.phases.find(p => p.id === phaseId);
  const project = getProject(_projectId);
  if (!phase || !project) return;

  let affected = 0, anyRescope = false;
  phase.tasks.forEach((_, idx) => {
    const ts        = getTask(project, `${phaseId}-${idx}`);
    const fromStage = ts.stage || 'pending';
    if (!isValidTransition(fromStage, toStage, ts.blockedFrom)) return;
    affected++;
    if (isRescope(fromStage, toStage)) anyRescope = true;
  });

  const meta = STAGE_META[toStage];
  _pendingBulkStages.set(phaseId, { toStage, requiresClientNote: anyRescope, note: { internal: '', client: '' } });

  const noteEl = document.getElementById(`phase-bulk-note-${phaseId}`);
  if (noteEl) {
    noteEl.style.display = 'block';
    noteEl.querySelectorAll('textarea').forEach(ta => { ta.value = ''; ta.style.borderColor = ''; });
    const tas = noteEl.querySelectorAll('textarea');
    const focusTa = anyRescope ? tas[1] : tas[0];
    if (focusTa) { focusTa.focus(); autoResize(focusTa); }
  }

  const summaryEl = document.getElementById(`phase-bulk-summary-${phaseId}`);
  if (summaryEl) {
    if (affected === 0) {
      summaryEl.textContent = `No tasks can move to ${meta.label}`;
      summaryEl.dataset.warn = '1';
    } else {
      summaryEl.textContent = `${affected} task${affected !== 1 ? 's' : ''} → ${meta.label}${anyRescope ? ' · client note required' : ''}`;
      summaryEl.dataset.warn = '0';
    }
  }
}

function _handlePhaseBulkNoteSave(phaseId, field, value) {
  const pending = _pendingBulkStages.get(phaseId);
  if (pending) pending.note[field] = value;
}

function _handlePhaseBulkConfirm(phaseId) {
  const pending = _pendingBulkStages.get(phaseId);
  if (!pending) return;

  if (pending.requiresClientNote && !pending.note.client.trim()) {
    const noteEl  = document.getElementById(`phase-bulk-note-${phaseId}`);
    const clientTa = noteEl?.querySelectorAll('textarea')[1];
    if (clientTa) {
      clientTa.style.borderColor = 'var(--stage-blocked)';
      clientTa.focus();
    }
    const summaryEl = document.getElementById(`phase-bulk-summary-${phaseId}`);
    if (summaryEl) { summaryEl.textContent = 'A client note is required for scope changes.'; summaryEl.dataset.warn = '1'; }
    return;
  }

  const phase   = _playbook.phases.find(p => p.id === phaseId);
  const project = getProject(_projectId);
  if (!phase || !project) return;

  phase.tasks.forEach((_, idx) => {
    const key       = `${phaseId}-${idx}`;
    const ts        = getTask(project, key);
    const fromStage = ts.stage || 'pending';
    if (!isValidTransition(fromStage, pending.toStage, ts.blockedFrom)) return;
    transitionTask(_projectId, key, pending.toStage, pending.note);
  });

  _handlePhaseBulkCancel(phaseId);
  phase.tasks.forEach((_, idx) => _rerenderItem(phaseId, idx));
  _updatePhaseProgress(phaseId);
  _refreshFilterBar();
  _applyFilters();
  _onUpdate();
}

function _handlePhaseBulkCancel(phaseId) {
  _pendingBulkStages.delete(phaseId);
  const menuEl = document.getElementById(`phase-bulk-${phaseId}`);
  if (menuEl) menuEl.classList.remove('open');
}

function _handlePhaseToggle(phaseEl) {
  if (phaseEl) phaseEl.classList.toggle('collapsed');
}

// ── Stage filter chips ────────────────────────────────────────────────────────

function _buildStageCounts(project) {
  const counts = {};
  _playbook.phases.forEach(phase => {
    phase.tasks.forEach((_, idx) => {
      const stage = (getTask(project, `${phase.id}-${idx}`).stage) || 'pending';
      counts[stage] = (counts[stage] || 0) + 1;
    });
  });
  return counts;
}

function _renderFilterBar(counts) {
  const order = ['pending','in-scope','na','active','blocked','client-review','complete','delivered'];
  const chips = order
    .filter(s => (counts[s] || 0) > 0)
    .map(s => {
      const m = STAGE_META[s];
      const cls = _activeFilters.has(s) ? ' active' : '';
      return `<button class="filter-chip${cls}" data-action="filter-chip" data-stage="${s}"
        style="color:var(${m.colorVar});background:var(${m.bgVar})">${escHtml(m.label)
        }<span class="filter-chip-count">${counts[s]}</span></button>`;
    }).join('');
  const hasFilter = _activeFilters.size > 0;
  return `<div class="stage-filter-bar" id="stage-filter-bar">
    <span class="filter-label">Filter</span>
    <div class="filter-chips">${chips}</div>
    <button class="filter-clear" data-action="filter-clear"${hasFilter ? '' : ' style="display:none"'}>Clear</button>
  </div>`;
}

function _refreshFilterBar() {
  if (!_phasesContainer) return;
  const barEl = document.getElementById('stage-filter-bar');
  if (!barEl) return;
  const project = getProject(_projectId);
  if (!project) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = _renderFilterBar(_buildStageCounts(project));
  barEl.replaceWith(tmp.firstElementChild);
}

function _applyFilters() {
  if (!_phasesContainer) return;
  const filtering = _activeFilters.size > 0;
  _phasesContainer.querySelectorAll('.item').forEach(item => {
    item.classList.toggle('filter-hidden', filtering && !_activeFilters.has(item.dataset.stage || 'pending'));
  });
  const project = getProject(_projectId);
  _playbook.phases.forEach(phase => {
    const el = document.getElementById(`prog-${phase.id}`);
    if (!el) return;
    if (!filtering) { _updatePhaseProgress(phase.id); return; }
    let match = 0;
    phase.tasks.forEach((_, idx) => {
      const s = project ? (getTask(project, `${phase.id}-${idx}`).stage || 'pending') : 'pending';
      if (_activeFilters.has(s)) match++;
    });
    el.textContent = `${match} shown`;
  });
  const clearBtn = _phasesContainer.querySelector('[data-action="filter-clear"]');
  if (clearBtn) clearBtn.style.display = filtering ? '' : 'none';
  _phasesContainer.querySelectorAll('.filter-chip').forEach(chip => {
    chip.classList.toggle('active', _activeFilters.has(chip.dataset.stage));
  });
}

// ── Re-render a single item after a state change ──────────────────────────────

function _rerenderItem(phaseId, idx) {
  const itemEl = document.getElementById(`item-${phaseId}-${idx}`);
  if (!itemEl) return;
  const phase   = _playbook.phases.find(p => p.id === phaseId);
  const project = getProject(_projectId);
  if (!phase || !project) return;
  const task = phase.tasks[idx];
  const ts   = getTask(project, `${phaseId}-${idx}`);
  const temp = document.createElement('div');
  temp.innerHTML = _itemHTML(phaseId, task, idx, ts);
  itemEl.replaceWith(temp.firstElementChild);
}

function _updatePhaseProgress(phaseId) {
  const phase   = _playbook.phases.find(p => p.id === phaseId);
  const project = getProject(_projectId);
  if (!phase || !project) return;
  let done = 0, total = 0;
  phase.tasks.forEach((_, i) => {
    const key   = `${phaseId}-${i}`;
    const ts    = getTask(project, key);
    const stage = ts.stage || 'pending';
    if (!COUNTABLE_STAGES.has(stage)) return;
    total++;
    if (DONE_STAGES.has(stage)) done++;
  });
  const el = document.getElementById(`prog-${phaseId}`);
  if (el) el.textContent = `${done}/${total}`;
}

// ── Qualification section ─────────────────────────────────────────────────────

function renderQualification(container) {
  const project = getProject(_projectId);
  const defs    = _playbook.qualification || [];
  if (!defs.length) { container.innerHTML = '<p style="color:var(--muted);padding:16px">No qualification fields defined for this playbook.</p>'; return; }
  const qual    = project?.qualification || {};
  const done    = defs.filter(q => !!qual[q.id]?.value).length;

  container.innerHTML = `
    <div class="qual-section-note">Qualification items establish that the engagement is properly scoped and authorised. They are not counted in delivery progress.</div>
    <div class="card" style="overflow:hidden;margin-bottom:12px">
      ${defs.map(q => {
        const checked = !!qual[q.id]?.value;
        return `<div class="qual-item${checked ? ' done' : ''}" id="qual-${q.id}">
          <input type="checkbox" class="qual-check" data-action="qual-check" data-qid="${q.id}" ${checked ? 'checked' : ''}>
          <label class="qual-label" data-action="qual-label" data-qid="${q.id}">${escHtml(q.label)}</label>
        </div>`;
      }).join('')}
    </div>
    <div style="font-size:12px;color:var(--muted)">${done} of ${defs.length} qualification items complete</div>`;

  container.addEventListener('change', e => {
    if (e.target.dataset.action === 'qual-check') _handleQualCheck(e.target);
  });
  container.addEventListener('click', e => {
    const el = e.target.closest('[data-action="qual-label"]');
    if (el) {
      const cb = container.querySelector(`[data-action="qual-check"][data-qid="${el.dataset.qid}"]`);
      if (cb) { cb.checked = !cb.checked; _handleQualCheck(cb); }
    }
  });
}

function _handleQualCheck(input) {
  const qid = input.dataset.qid;
  mutateProject(_projectId, p => {
    if (!p.qualification) p.qualification = {};
    p.qualification[qid] = { value: input.checked };
  });
  const rowEl = document.getElementById(`qual-${qid}`);
  if (rowEl) rowEl.classList.toggle('done', input.checked);
  _onUpdate();
}

// ── Assets section ────────────────────────────────────────────────────────────

function renderAssets(container) {
  const project = getProject(_projectId);
  const defs    = _playbook.assets || [];
  if (!defs.length) { container.innerHTML = '<p style="color:var(--muted);padding:16px">No assets defined for this playbook.</p>'; return; }
  const assetState = project?.assets || {};

  const statusOpts = [
    { value: 'missing',      label: '⬜ Not received' },
    { value: 'requested',    label: '🟡 Requested from client' },
    { value: 'received',     label: '✅ Received' },
    { value: 'not-required', label: '— Not required' },
  ];

  const required = defs.filter(d => d.required);
  const optional = defs.filter(d => !d.required);

  const cardHTML = (def) => {
    const state  = assetState[def.id] || {};
    const status = state.status || 'missing';
    const note   = state.internalNote || '';
    return `<div class="asset-card" id="asset-${def.id}">
      <div class="asset-card-header">
        <div>
          <div class="asset-name">${escHtml(def.name)}</div>
          <div class="asset-cat">${escHtml(def.category)}</div>
        </div>
        <span class="badge ${def.required ? 'badge-req' : 'badge-opt'}">${def.required ? 'Required' : 'Optional'}</span>
      </div>
      <select class="status-select" data-action="asset-status" data-aid="${def.id}">
        ${statusOpts.map(o => `<option value="${o.value}" ${status === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      ${def.description ? `<div style="font-size:11px;color:var(--muted);margin-bottom:6px;line-height:1.4">${escHtml(def.description)}</div>` : ''}
      <textarea class="asset-note" data-action="asset-note" data-aid="${def.id}"
        placeholder="Secure reference or internal note…" rows="1">${escHtml(note)}</textarea>
    </div>`;
  };

  container.innerHTML = `
    ${required.length ? `<div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Required Assets</div>
    <div class="asset-grid" style="margin-bottom:20px">${required.map(cardHTML).join('')}</div>` : ''}
    ${optional.length ? `<div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Optional / Situational Assets</div>
    <div class="asset-grid">${optional.map(cardHTML).join('')}</div>` : ''}`;

  container.addEventListener('change', e => {
    if (e.target.dataset.action === 'asset-status') {
      const aid = e.target.dataset.aid;
      mutateProject(_projectId, p => {
        if (!p.assets) p.assets = {};
        p.assets[aid] = { ...(p.assets[aid] || {}), status: e.target.value };
      });
      _onUpdate();
    }
  });
  container.addEventListener('input', e => {
    if (e.target.dataset.action === 'asset-note') {
      const aid = e.target.dataset.aid;
      mutateProject(_projectId, p => {
        if (!p.assets) p.assets = {};
        p.assets[aid] = { ...(p.assets[aid] || {}), internalNote: e.target.value };
      });
      autoResize(e.target);
    }
  });
}

// ── Deliverables section ──────────────────────────────────────────────────────

const _DEL_STATUS_OPTS = [
  { value: 'pending',   label: '⬜ Pending' },
  { value: 'delivered', label: '🟡 Delivered' },
  { value: 'approved',  label: '✅ Approved' },
];

function _renderDeliverableList(container) {
  const project  = getProject(_projectId);
  const defs     = _playbook.deliverables || [];
  const delState = project?.deliverables || {};

  const customEntries = Object.entries(delState)
    .filter(([, v]) => v?.isCustom)
    .sort(([a], [b]) => a.localeCompare(b));

  const renderCard = (id, name, description, isCustom, clientApprovalRequired) => {
    const state   = delState[id] || {};
    const inScope = state.inScope !== false;
    const status  = state.status || 'pending';
    const note    = state.notes  || '';
    const approvalBadge = (clientApprovalRequired && inScope)
      ? `<span class="badge" style="background:var(--accent-lt);color:var(--accent);border:1px solid var(--accent)">Client Approval</span>`
      : '';
    const deleteBtn = isCustom
      ? `<button class="del-delete-btn" data-action="del-delete" data-did="${id}" title="Remove deliverable">×</button>`
      : '';
    return `<div class="deliverable-card${inScope ? '' : ' deliverable-oos'}" id="del-${id}">
      <div class="deliverable-header">
        <span class="deliverable-name">${escHtml(name)}</span>
        <div class="deliverable-header-actions">
          ${approvalBadge}
          <button class="scope-btn ${inScope ? 'scope-btn--on' : 'scope-btn--off'}" data-action="del-scope" data-did="${id}">
            ${inScope ? '⦿ In Scope' : '⊘ Out of Scope'}
          </button>
          ${deleteBtn}
        </div>
      </div>
      ${description ? `<div class="deliverable-desc">${escHtml(description)}</div>` : ''}
      ${inScope
        ? `<div class="deliverable-controls">
            <select class="status-select" style="flex:0 0 auto;width:auto" data-action="del-status" data-did="${id}">
              ${_DEL_STATUS_OPTS.map(o => `<option value="${o.value}" ${status === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
           </div>
           <textarea class="deliverable-note" data-action="del-note" data-did="${id}"
             placeholder="Notes, URL, or evidence reference…" rows="1">${escHtml(note)}</textarea>`
        : `<div class="deliverable-oos-label">Out of scope for this engagement</div>`}
    </div>`;
  };

  const inner = container.querySelector('.del-list-inner');
  if (inner) {
    inner.innerHTML = [
      ...defs.map(d => renderCard(d.id, d.name, d.description || '', false, d.clientApprovalRequired)),
      ...customEntries.map(([id, v]) => renderCard(id, v.name || 'Custom Deliverable', '', true, false)),
    ].join('');
    inner.querySelectorAll('.deliverable-note').forEach(autoResize);
  }

  // Refresh pick chips — filter out names already present (standard or custom)
  const chipsEl = container.querySelector('.del-pick-chips');
  if (chipsEl) {
    const usedNames = new Set([
      ...defs.map(d => d.name.toLowerCase()),
      ...customEntries.map(([, v]) => (v.name || '').toLowerCase()),
    ]);
    const options = (_playbook.deliverableOptions || []).filter(n => !usedNames.has(n.toLowerCase()));
    chipsEl.innerHTML = options.map(n =>
      `<button class="del-pick-chip" data-action="del-pick" data-name="${escHtml(n)}">${escHtml(n)}</button>`
    ).join('') + `<button class="del-pick-chip del-pick-chip--custom" data-action="del-pick-custom">Custom…</button>`;
  }
}

function renderDeliverables(container) {
  const defs = _playbook.deliverables || [];
  const project = getProject(_projectId);
  const hasCustom = Object.values(project?.deliverables || {}).some(v => v?.isCustom);
  if (!defs.length && !hasCustom) {
    container.innerHTML = '<p style="color:var(--muted);padding:16px">No deliverables defined for this playbook.</p>';
    return;
  }

  container.innerHTML = `
    <div class="deliverable-list">
      <div class="del-list-inner"></div>
      <div class="del-add-bar">
        <button class="btn btn-ghost del-add-open-btn" data-action="del-add-open">+ Add Deliverable</button>
      </div>
      <div class="del-pick-panel" style="display:none">
        <div class="del-pick-chips"></div>
        <div class="del-add-form" style="display:none">
          <input class="del-add-input" placeholder="e.g. Discord Server, YouTube Channel…">
          <button class="btn btn-primary" data-action="del-add-confirm">Add</button>
          <button class="btn btn-ghost"   data-action="del-pick-custom-cancel">Cancel</button>
        </div>
      </div>
    </div>`;

  _renderDeliverableList(container);

  container.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.action === 'del-status') {
      const did = el.dataset.did;
      mutateProject(_projectId, p => {
        if (!p.deliverables) p.deliverables = {};
        p.deliverables[did] = { ...(p.deliverables[did] || {}), status: el.value };
      });
      _onUpdate();
    }
  });

  container.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.action === 'del-note') {
      const did = el.dataset.did;
      mutateProject(_projectId, p => {
        if (!p.deliverables) p.deliverables = {};
        p.deliverables[did] = { ...(p.deliverables[did] || {}), notes: el.value };
      });
      autoResize(el);
    }
  });

  const _closePicker = () => {
    const panel = container.querySelector('.del-pick-panel');
    const form  = container.querySelector('.del-add-form');
    const input = container.querySelector('.del-add-input');
    if (panel)  panel.style.display  = 'none';
    if (form)   form.style.display   = 'none';
    if (input)  input.value = '';
  };

  const _addDeliverable = (name) => {
    const did = 'custom-' + generateId();
    mutateProject(_projectId, p => {
      if (!p.deliverables) p.deliverables = {};
      p.deliverables[did] = { isCustom: true, name, inScope: true, status: 'pending', notes: '' };
    });
    _closePicker();
    _renderDeliverableList(container);
    _onUpdate();
  };

  container.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'del-scope') {
      const did = el.dataset.did;
      mutateProject(_projectId, p => {
        if (!p.deliverables) p.deliverables = {};
        const cur = p.deliverables[did] || {};
        p.deliverables[did] = { ...cur, inScope: cur.inScope === false ? true : false };
      });
      _renderDeliverableList(container);
      _onUpdate();
    }

    if (action === 'del-add-open') {
      const panel = container.querySelector('.del-pick-panel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }

    if (action === 'del-pick') {
      _addDeliverable(el.dataset.name);
    }

    if (action === 'del-pick-custom') {
      const form  = container.querySelector('.del-add-form');
      const input = container.querySelector('.del-add-input');
      form.style.display = 'flex';
      input.focus();
    }

    if (action === 'del-pick-custom-cancel') {
      const form  = container.querySelector('.del-add-form');
      const input = container.querySelector('.del-add-input');
      form.style.display = 'none';
      input.value = '';
    }

    if (action === 'del-add-confirm') {
      const input = container.querySelector('.del-add-input');
      const name  = input.value.trim();
      if (!name) { input.focus(); return; }
      _addDeliverable(name);
    }

    if (action === 'del-delete') {
      const did = el.dataset.did;
      const project = getProject(_projectId);
      const name = project?.deliverables?.[did]?.name || 'this deliverable';
      if (confirm(`Remove "${name}"?`)) {
        mutateProject(_projectId, p => { if (p.deliverables) delete p.deliverables[did]; });
        _renderDeliverableList(container);
        _onUpdate();
      }
    }
  });

  container.addEventListener('keydown', e => {
    if (e.target.classList.contains('del-add-input')) {
      if (e.key === 'Enter')  { e.preventDefault(); container.querySelector('[data-action="del-add-confirm"]').click(); }
      if (e.key === 'Escape') { container.querySelector('[data-action="del-pick-custom-cancel"]').click(); }
    }
  });
}

// ── Training section ──────────────────────────────────────────────────────────

function renderTraining(container) {
  const project  = getProject(_projectId);
  const tools    = _playbook.training || [];
  if (!tools.length) { container.innerHTML = '<p style="color:var(--muted);padding:16px">No training defined for this playbook.</p>'; return; }
  const trainState = project?.training || {};

  container.innerHTML = `<div class="training-list">${tools.map(tool => {
    const ts        = trainState[tool.id] || {};
    const comps     = ts.competencies || {};
    const done      = tool.competencies.filter((_, i) => !!comps[i]).length;
    const resources = ts.resources || '';

    return `<div class="training-card" id="training-${tool.id}">
      <div class="training-card-header">
        <div class="training-tool-info">
          <div class="training-tool-name">${escHtml(tool.name)}</div>
          ${tool.scope ? `<div class="training-scope">${escHtml(tool.scope)}</div>` : ''}
        </div>
        <span class="training-prog" id="tprog-${tool.id}">${done}/${tool.competencies.length}</span>
      </div>
      <div class="training-body">
        ${tool.competencies.map((c, i) => {
          const checked = !!comps[i];
          return `<div class="competency-item${checked ? ' done' : ''}" id="comp-${tool.id}-${i}">
            <input type="checkbox" class="competency-check" data-action="comp-check"
              data-tool="${tool.id}" data-cidx="${i}" ${checked ? 'checked' : ''}>
            <div class="competency-label" data-action="comp-label" data-tool="${tool.id}" data-cidx="${i}">${escHtml(c)}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="training-resources">
        <div class="training-res-label">Resources Provided</div>
        <textarea class="training-res-note" data-action="training-resources" data-tool="${tool.id}"
          placeholder="List resources provided — documentation links, video tutorials, guides shared with client…"
          rows="2">${escHtml(resources)}</textarea>
      </div>
    </div>`;
  }).join('')}</div>`;

  container.addEventListener('change', e => {
    if (e.target.dataset.action === 'comp-check') _handleCompCheck(e.target);
  });
  container.addEventListener('click', e => {
    const el = e.target.closest('[data-action="comp-label"]');
    if (el) {
      const cb = container.querySelector(`[data-action="comp-check"][data-tool="${el.dataset.tool}"][data-cidx="${el.dataset.cidx}"]`);
      if (cb) { cb.checked = !cb.checked; _handleCompCheck(cb); }
    }
  });
  container.addEventListener('input', e => {
    if (e.target.dataset.action === 'training-resources') {
      const tid = e.target.dataset.tool;
      mutateProject(_projectId, p => {
        if (!p.training) p.training = {};
        p.training[tid] = { ...(p.training[tid] || {}), resources: e.target.value };
      });
      autoResize(e.target);
    }
  });
}

function _handleCompCheck(input) {
  const tid  = input.dataset.tool;
  const cidx = +input.dataset.cidx;
  mutateProject(_projectId, p => {
    if (!p.training) p.training = {};
    if (!p.training[tid]) p.training[tid] = {};
    if (!p.training[tid].competencies) p.training[tid].competencies = {};
    if (input.checked) p.training[tid].competencies[cidx] = true;
    else delete p.training[tid].competencies[cidx];
  });
  const rowEl = document.getElementById(`comp-${tid}-${cidx}`);
  if (rowEl) rowEl.classList.toggle('done', input.checked);
  const project = getProject(_projectId);
  const tool    = _playbook.training.find(t => t.id === tid);
  if (tool && project) {
    const comps = project.training?.[tid]?.competencies || {};
    const done  = tool.competencies.filter((_, i) => !!comps[i]).length;
    const el    = document.getElementById(`tprog-${tid}`);
    if (el) el.textContent = `${done}/${tool.competencies.length}`;
  }
  _onUpdate();
}

// ── Export snapshot ───────────────────────────────────────────────────────────

export function exportSnapshot() {
  const project = getProject(_projectId);
  if (!project) return;
  const { done, total, pct, currentPhase, clientActions } = getProgress();
  const statusLabel = (_playbook.statuses.find(s => s.value === project.status) || _playbook.statuses[0]).label;
  const now         = new Date();
  const dateDisplay = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Collect outstanding client actions
  const pendingActions = [];
  _playbook.phases.forEach(phase => {
    phase.tasks.forEach((task, idx) => {
      const key   = `${phase.id}-${idx}`;
      const ts    = getTask(project, key);
      const stage = ts.stage || 'pending';
      if (task.clientAction && COUNTABLE_STAGES.has(stage) && !DONE_STAGES.has(stage)) {
        pendingActions.push({ task, phase });
      }
    });
  });

  // Collect missing required assets
  const missingAssets = (_playbook.assets || []).filter(def => {
    if (!def.required) return false;
    const state = (project.assets || {})[def.id];
    return !state || !state.status || state.status === 'missing';
  });

  const phasesHTML = _exportPhasesHTML(project, 'internal');

  const clientActionsHTML = pendingActions.length ? `
    <div style="background:#FFFBEB;border:1px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-bottom:16px">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#92700A;margin-bottom:10px">Outstanding Client Actions</div>
      ${pendingActions.map(({ task, phase }) => `
        <div style="display:flex;gap:10px;margin-bottom:8px;align-items:flex-start">
          <span style="color:#92700A;font-size:14px;flex-shrink:0">☐</span>
          <div>
            <div style="font-size:13px;font-weight:600;color:#0D1626">${_escExport(task.label)}</div>
            <div style="font-size:11px;color:#92700A">${_escExport(phase.tag)} — ${_escExport(phase.title)}</div>
          </div>
        </div>`).join('')}
    </div>` : '';

  const missingAssetsHTML = missingAssets.length ? `
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:14px 18px;margin-bottom:16px">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#DC2626;margin-bottom:10px">Assets Not Yet Received</div>
      ${missingAssets.map(a => `<div style="font-size:13px;color:#0D1626;margin-bottom:4px">• ${_escExport(a.name)}</div>`).join('')}
    </div>` : '';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${_escExport(project.clientName)} — ${_escExport(_playbook.shortName)} Snapshot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#F2F5F9;color:#0D1626;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.6;padding:40px 20px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto}
.no-print{background:#0D1626;color:#fff;padding:10px 18px;border-radius:6px;text-align:center;margin-bottom:24px;font-size:13px}
.no-print button{background:#4B8EFF;color:#fff;border:none;border-radius:5px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;margin-left:12px}
@media print{.no-print{display:none}body{background:#fff;padding:20px}}
</style>
</head><body><div class="wrap">
<div class="no-print">Snapshot for ${_escExport(project.clientName)} — ${_escExport(dateDisplay)}
  <button onclick="window.print()">Print / Save PDF</button>
</div>
<div style="font-size:10.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#1A5FDB;margin-bottom:8px">Laminar Business Systems</div>
<div style="font-size:24px;font-weight:700;letter-spacing:-.02em;color:#0D1626;margin-bottom:4px">${_escExport(_playbook.name)}</div>
<div style="font-size:18px;font-weight:600;color:#1A5FDB;margin-bottom:6px">${_escExport(project.clientName)}</div>
<div style="display:inline-block;font-size:13px;font-weight:600;color:#0D1626;background:#EBF1FD;border:1px solid #C7D9F8;border-radius:6px;padding:3px 12px;margin-bottom:6px">${_escExport(statusLabel)}</div>
<div style="font-size:12px;color:#5A6A85;margin-bottom:24px">Exported ${_escExport(dateDisplay)}</div>
<div style="background:#fff;border:1px solid #DCE3EE;border-radius:8px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(13,22,38,.07)">
  <div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5A6A85;margin-bottom:6px">Overall Progress</div>
  <div style="font-size:15px;font-weight:700;color:#0D1626;margin-bottom:8px">${done} of ${total} tasks complete (${pct}%)</div>
  <div style="height:5px;background:#DCE3EE;border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#1A5FDB;border-radius:3px"></div></div>
  ${currentPhase ? `<div style="font-size:12px;color:#5A6A85;margin-top:8px">Current phase: <strong style="color:#0D1626">${_escExport(currentPhase.tag)} — ${_escExport(currentPhase.title)}</strong></div>` : ''}
</div>
${clientActionsHTML}${missingAssetsHTML}${phasesHTML}
<div style="text-align:center;margin-top:36px;font-size:11px;color:#5A6A85;border-top:1px solid #DCE3EE;padding-top:16px">
  Generated by Laminar Pipeline &middot; ${_escExport(dateDisplay)} &middot; ${_escExport(_playbook.name)} v${_playbook.version}
</div>
</div></body></html>`;

  const win = window.open('', '_blank');
  if (win) { win.document.write(html); win.document.close(); }
}

// ── Export client report ──────────────────────────────────────────────────────

export function exportClientReport() {
  const project = getProject(_projectId);
  if (!project) return;
  const { done, total, pct, currentPhase } = getProgress();
  const now         = new Date();
  const dateDisplay = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Outstanding client actions
  const pendingActions = [];
  _playbook.phases.forEach(phase => {
    phase.tasks.forEach((task, idx) => {
      const ts    = getTask(project, `${phase.id}-${idx}`);
      const stage = ts.stage || 'pending';
      if (task.clientAction && COUNTABLE_STAGES.has(stage) && !DONE_STAGES.has(stage)) {
        pendingActions.push({ task, phase, ts });
      }
    });
  });

  const clientActionsHTML = pendingActions.length ? `
    <div style="background:#FFFBEB;border:1px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-bottom:16px">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#92700A;margin-bottom:10px">Your Outstanding Actions</div>
      ${pendingActions.map(({ task, phase }) => `
        <div style="display:flex;gap:10px;margin-bottom:8px;align-items:flex-start">
          <span style="color:#92700A;font-size:14px;flex-shrink:0">☐</span>
          <div>
            <div style="font-size:13px;font-weight:600;color:#0D1626">${_escExport(task.label)}</div>
            <div style="font-size:11px;color:#92700A">${_escExport(phase.tag)} — ${_escExport(phase.title)}</div>
          </div>
        </div>`).join('')}
    </div>` : '';

  const phasesHTML = _exportPhasesHTML(project, 'client');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${_escExport(project.clientName)} — ${_escExport(_playbook.shortName)} Client Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#F2F5F9;color:#0D1626;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.6;padding:40px 20px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto}
.no-print{background:#0D1626;color:#fff;padding:10px 18px;border-radius:6px;text-align:center;margin-bottom:24px;font-size:13px}
.no-print button{background:#4B8EFF;color:#fff;border:none;border-radius:5px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;margin-left:12px}
@media print{.no-print{display:none}body{background:#fff;padding:20px}}
</style>
</head><body><div class="wrap">
<div class="no-print">Client Report for ${_escExport(project.clientName)} — ${_escExport(dateDisplay)}
  <button onclick="window.print()">Print / Save PDF</button>
</div>
<div style="font-size:10.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#1A5FDB;margin-bottom:8px">Laminar Business Systems</div>
<div style="font-size:24px;font-weight:700;letter-spacing:-.02em;color:#0D1626;margin-bottom:4px">${_escExport(_playbook.name)}</div>
<div style="font-size:18px;font-weight:600;color:#1A5FDB;margin-bottom:6px">${_escExport(project.clientName)}</div>
<div style="font-size:12px;color:#5A6A85;margin-bottom:24px">Prepared ${_escExport(dateDisplay)}</div>
<div style="background:#fff;border:1px solid #DCE3EE;border-radius:8px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(13,22,38,.07)">
  <div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5A6A85;margin-bottom:6px">Delivery Progress</div>
  <div style="font-size:15px;font-weight:700;color:#0D1626;margin-bottom:8px">${done} of ${total} tasks complete (${pct}%)</div>
  <div style="height:5px;background:#DCE3EE;border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#1A5FDB;border-radius:3px"></div></div>
  ${currentPhase ? `<div style="font-size:12px;color:#5A6A85;margin-top:8px">Current phase: <strong style="color:#0D1626">${_escExport(currentPhase.tag)} — ${_escExport(currentPhase.title)}</strong></div>` : ''}
</div>
${clientActionsHTML}${phasesHTML}
<div style="text-align:center;margin-top:36px;font-size:11px;color:#5A6A85;border-top:1px solid #DCE3EE;padding-top:16px">
  Prepared by Laminar Business Systems &middot; ${_escExport(dateDisplay)}
</div>
</div></body></html>`;

  const win = window.open('', '_blank');
  if (win) { win.document.write(html); win.document.close(); }
}

// ── Shared export phases renderer ─────────────────────────────────────────────
// mode: 'internal' = show both notes + stage history; 'client' = client notes only, skip pending/na without notes

function _exportPhasesHTML(project, mode) {
  const SC = {
    'pending':       { bg: '#F1F5F9', fg: '#64748B', label: 'Pending'       },
    'in-scope':      { bg: '#EBF1FD', fg: '#1A5FDB', label: 'In Scope'      },
    'na':            { bg: '#F8FAFC', fg: '#94A3B8', label: 'N/A'           },
    'active':        { bg: '#FFF7ED', fg: '#C2710C', label: 'Active'        },
    'blocked':       { bg: '#FEF2F2', fg: '#DC2626', label: 'Blocked'       },
    'client-review': { bg: '#F5F3FF', fg: '#7C3AED', label: 'Client Review' },
    'complete':      { bg: '#F0FDF4', fg: '#16A34A', label: 'Complete'      },
    'delivered':     { bg: '#F0FDFA', fg: '#0D9488', label: 'Delivered'     },
  };

  return _playbook.phases.map(phase => {
    let pDone = 0, pTotal = 0;
    const itemsHTML = phase.tasks.map((task, idx) => {
      const key    = `${phase.id}-${idx}`;
      const ts     = getTask(project, key);
      const stage  = ts.stage || 'pending';
      const isNA   = stage === 'na';
      const isDone = DONE_STAGES.has(stage);
      const sc     = SC[stage] || SC['pending'];
      const intNote  = ts.note?.internal || '';
      const clNote   = ts.note?.client   || '';
      if (COUNTABLE_STAGES.has(stage)) { pTotal++; if (isDone) pDone++; }

      // Client mode: skip pending tasks with no client note; skip na tasks with no client note
      if (mode === 'client' && stage === 'pending') return '';
      if (mode === 'client' && isNA && !clNote) return '';

      const stagePill = `<span style="font-size:9px;font-weight:700;text-transform:uppercase;background:${sc.bg};color:${sc.fg};border-radius:10px;padding:2px 7px;margin-left:6px;white-space:nowrap">${_escExport(sc.label)}</span>`;
      const clientBadge = (!isNA && task.clientAction && mode === 'internal') ? `<span style="font-size:9px;font-weight:700;text-transform:uppercase;background:#EBF1FD;color:#1A5FDB;border:1px solid #C7D9F8;border-radius:4px;padding:1px 5px;letter-spacing:.07em;margin-left:6px">Client Action</span>` : '';

      const intNoteEl = (mode === 'internal' && intNote) ? `<div style="font-size:11.5px;color:#92700A;background:#FFFBEB;border:1px solid #FCD34D;border-radius:4px;padding:5px 9px;margin-top:6px;line-height:1.5">🔒 Internal: ${_escExport(intNote)}</div>` : '';
      const clNoteEl  = clNote ? `<div style="font-size:11.5px;color:#1A5FDB;background:#EBF1FD;border:1px solid #C7D9F8;border-radius:4px;padding:5px 9px;margin-top:6px;line-height:1.5">💬 ${_escExport(clNote)}</div>` : '';

      let logHTML = '';
      if (mode === 'internal' && (ts.log || []).length > 0) {
        const entries = ts.log.map(e => {
          const sc2 = SC[e.stage] || SC['pending'];
          const d   = new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          return `<span style="font-size:9px;font-weight:700;background:${sc2.bg};color:${sc2.fg};border-radius:10px;padding:1px 6px;white-space:nowrap">${_escExport(sc2.label)} · ${_escExport(d)}</span>`;
        }).join(' ');
        logHTML = `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center"><span style="font-size:9px;color:#5A6A85;margin-right:2px">History:</span>${entries}</div>`;
      }

      const chkBg  = isDone ? '#16A34A' : isNA ? '#F8FAFC' : '#fff';
      const chkBdr = isDone ? '#16A34A' : '#DCE3EE';
      const chk = `<div style="width:15px;height:15px;min-width:15px;border:1.5px solid ${chkBdr};border-radius:4px;background:${chkBg};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700;margin-top:2px">${isDone ? '✓' : ''}</div>`;

      return `<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 16px;border-bottom:1px solid #DCE3EE;${isNA ? 'opacity:.5' : ''}">
        ${chk}
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:${isNA ? '#5A6A85' : '#0D1626'};${isDone ? 'text-decoration:line-through;color:#5A6A85' : ''};display:flex;flex-wrap:wrap;align-items:center;gap:2px">${_escExport(task.label)}${stagePill}${clientBadge}</div>
          ${intNoteEl}${clNoteEl}${logHTML}
        </div>
      </div>`;
    }).join('');

    if (mode === 'client' && !itemsHTML.trim()) return '';

    return `<div style="background:#fff;border:1px solid #DCE3EE;border-radius:8px;margin-bottom:12px;overflow:hidden;box-shadow:0 1px 3px rgba(13,22,38,.07)">
      <div style="display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-bottom:1px solid #DCE3EE;background:#F8FAFC">
        <span style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:4px;color:#fff;background:${phase.color};white-space:nowrap;flex-shrink:0;margin-top:2px">${_escExport(phase.tag)}</span>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:600;color:#0D1626">${_escExport(phase.title)}</div>
          ${phase.objective ? `<div style="font-size:11px;color:#5A6A85;margin-top:2px;font-style:italic;line-height:1.4">${_escExport(phase.objective)}</div>` : ''}
        </div>
        <span style="font-size:11px;color:#5A6A85;white-space:nowrap;flex-shrink:0;margin-top:3px">${pDone}/${pTotal}</span>
      </div>
      ${itemsHTML}
    </div>`;
  }).join('');
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _currentPhase(project) {
  for (const phase of _playbook.phases) {
    const hasActive = phase.tasks.some((_, idx) => {
      const key   = `${phase.id}-${idx}`;
      const ts    = getTask(project, key);
      const stage = ts.stage || 'pending';
      return COUNTABLE_STAGES.has(stage) && !DONE_STAGES.has(stage);
    });
    if (hasActive) return phase;
  }
  return null;
}

function _empty(msg) {
  return `<div class="empty-state"><div class="empty-desc">${escHtml(msg)}</div></div>`;
}

function _escExport(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
