/**
 * Operating Cycles — rendering and interaction for retainer playbooks.
 * Rendered into the Cycles tab. Uses event delegation; listeners attach once.
 */

import { escHtml, autoResize } from './ui.js';
import {
  getCycles, getCycle, createCycle, mutateCycle, closeCycle, reopenCycle, generateId,
} from './storage.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _container         = null;
let _projectId         = null;
let _onUpdate          = null;
let _activeCycleId     = null;
let _newMonthOpen      = false;
let _expandedWorkItems = new Set();
let _showArchivedWork  = false;
let _editingCapacity   = false;

// ── Constants ─────────────────────────────────────────────────────────────────

const CYCLE_STATUSES = [
  { value: 'draft',             label: '📋 Draft' },
  { value: 'awaiting-approval', label: '🔷 Awaiting Approval' },
  { value: 'active',            label: '🟡 Active' },
  { value: 'blocked',           label: '🔴 Blocked' },
  { value: 'review-due',        label: '🔵 Review Due' },
  { value: 'awaiting-ack',      label: '🟣 Awaiting Acknowledgement' },
  { value: 'closed',            label: '✅ Closed' },
];

const WORK_STATUSES = [
  { value: 'planned',     label: 'Planned' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'blocked',     label: 'Blocked' },
  { value: 'complete',    label: 'Complete' },
  { value: 'deferred',    label: 'Deferred' },
  { value: 'cancelled',   label: 'Cancelled' },
];

const DEFER_DISPOSITIONS = [
  { value: 'carry-forward',  label: 'Carry Forward' },
  { value: 'defer',          label: 'Defer to Roadmap' },
  { value: 'cancel',         label: 'Cancel' },
  { value: 'separate-scope', label: 'Separate Scope' },
];

const TIME_CATEGORIES = [
  { value: 'meeting',        label: 'Meeting' },
  { value: 'implementation', label: 'Implementation' },
  { value: 'reporting',      label: 'Reporting' },
  { value: 'analysis',       label: 'Analysis' },
  { value: 'coordination',   label: 'Coordination' },
  { value: 'admin',          label: 'Administration' },
];

const BILLING_CATEGORIES = [
  { value: 'included',       label: 'Included' },
  { value: 'additional',     label: 'Additional' },
  { value: 'separate-scope', label: 'Separate Scope' },
  { value: 'non-billable',   label: 'Non-Billable' },
];

const OWNERS = [
  { value: 'laminar', label: 'Laminar' },
  { value: 'client',  label: 'Client' },
  { value: 'shared',  label: 'Shared' },
];

const ITEM_STATUSES = [
  { value: 'pending',  label: 'Pending' },
  { value: 'complete', label: 'Complete' },
  { value: 'overdue',  label: 'Overdue' },
];

const BLOCKER_STATUSES = [
  { value: 'open',     label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
];

const DEL_STATUSES = [
  { value: 'pending',  label: '⬜ Pending' },
  { value: 'complete', label: '✅ Complete' },
  { value: 'na',       label: '— N/A' },
];

const ACK_STATUSES = [
  { value: 'pending',       label: '⬜ Pending' },
  { value: 'sent-awaiting', label: '📤 Sent — Awaiting' },
  { value: 'received',      label: '✅ Received' },
  { value: 'waived',        label: '— Waived' },
  { value: 'disputed',      label: '⚠ Disputed' },
];

// ── Public API ────────────────────────────────────────────────────────────────

export function renderCycles(container, _playbook, projectId, onUpdate) {
  _container = container;
  _projectId = projectId;
  _onUpdate  = onUpdate;
  _render();
  _attachEvents();
}

export function resetCycles() {
  _activeCycleId     = null;
  _newMonthOpen      = false;
  _expandedWorkItems = new Set();
  _showArchivedWork  = false;
  _editingCapacity   = false;
}

// ── Core render ───────────────────────────────────────────────────────────────

function _render() {
  const cycles = getCycles(_projectId);

  if (!_activeCycleId || !cycles.find(c => c.id === _activeCycleId)) {
    const best = cycles.find(c => ['active','awaiting-approval','review-due','awaiting-ack'].includes(c.status))
               || cycles.find(c => c.status === 'draft')
               || cycles[cycles.length - 1];
    _activeCycleId = best?.id || null;
  }

  if (cycles.length === 0) {
    _container.innerHTML = `
      <div class="cycle-toolbar">
        <div class="cycle-toolbar-left"><span class="cycle-period-empty">No cycles yet</span></div>
        <div class="cycle-toolbar-right">${_newMonthHTML(cycles)}</div>
      </div>
      <div class="empty-state">
        <div class="empty-title">No operating cycles</div>
        <div class="empty-desc">Create the first monthly cycle to begin tracking work, capacity, and deliverables.</div>
      </div>`;
    return;
  }

  const cycle  = getCycle(_projectId, _activeCycleId);
  if (!cycle) return;

  const cap    = _calcCapacity(cycle);
  const locked = cycle.locked;

  _container.innerHTML = `
    <div class="cycle-toolbar">
      <div class="cycle-toolbar-left">
        <select class="app-select" data-action="cycle-select" style="min-width:220px">
          ${cycles.map(c => `<option value="${c.id}" ${c.id === _activeCycleId ? 'selected':''}>${_fmtPeriod(c.period)} — ${_statusShort(c.status)}</option>`).join('')}
        </select>
      </div>
      <div class="cycle-toolbar-right">${_newMonthHTML(cycles)}</div>
    </div>

    <div class="cycle-header-card">
      <div class="cycle-header-top">
        <div class="cycle-header-period">${_fmtPeriod(cycle.period)}</div>
        <div class="cycle-header-controls">
          <select class="app-select cycle-status-select" data-action="cycle-status-change"${locked ? ' disabled':''}>
            ${CYCLE_STATUSES.map(s => `<option value="${s.value}" ${s.value===cycle.status?'selected':''}>${s.label}</option>`).join('')}
          </select>
          ${locked ? `<button class="btn btn-ghost btn-sm" data-action="cycle-reopen">Reopen</button>` : ''}
        </div>
      </div>
      <div class="cycle-cap-bar-wrap"><div class="cycle-cap-fill${cap.over?' cycle-cap-over':''}" id="cycle-cap-fill" style="width:${cap.pct}%"></div></div>
      ${_editingCapacity ? _capEditHTML(cycle) : _capSummaryHTML(cap, locked)}
      ${locked ? `<div class="cycle-locked-banner">🔒 Closed ${_fmtDate(cycle.closedAt)}</div>` : ''}
    </div>

    ${_section('plan',         'Plan',         _planBody(cycle))}
    ${_section('work',         'Work',         _workBody(cycle))}
    ${_section('governance',   'Governance',   _govBody(cycle))}
    ${_section('deliverables', 'Deliverables', _delsBody(cycle))}
    ${_section('timelog',      'Time Log',     _timeBody(cycle))}
    ${_section('close',        'Close',        _closeBody(cycle, cap))}
  `;

  _container.querySelectorAll('textarea').forEach(autoResize);
}

function _newMonthHTML(cycles) {
  if (_newMonthOpen) {
    const suggested = _suggestNext(cycles);
    const maxMonth  = _maxPeriod();
    return `<div class="cycle-new-panel">
      <input class="app-input" type="month" value="${suggested}" max="${maxMonth}" data-action="cycle-new-period" style="width:160px">
      <button class="btn btn-primary btn-sm" data-action="cycle-new-confirm">Create</button>
      <button class="btn btn-ghost btn-sm"   data-action="cycle-new-cancel">Cancel</button>
    </div>`;
  }
  return `<button class="btn btn-primary btn-sm" data-action="cycle-new">+ New Month</button>`;
}

function _section(id, title, body) {
  return `<div class="cycle-section" id="cycle-sec-${id}">
    <div class="cycle-sec-hdr" data-action="cycle-sec-toggle" data-sec="${id}">
      <span class="cycle-sec-title">${title}</span>
      <svg class="phase-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6l4 4 4-4"/></svg>
    </div>
    <div class="cycle-sec-body">${body}</div>
  </div>`;
}

// ── Capacity display ──────────────────────────────────────────────────────────

function _capSummaryHTML(cap, locked) {
  const sepNote = cap.separateScopeHrs > 0
    ? `<span class="cap-side-note">+ ${cap.separateScopeHrs}h separate scope (tracked separately)</span>` : '';
  const nbNote  = cap.nonBillableHrs > 0
    ? `<span class="cap-side-note">${cap.nonBillableHrs}h non-billable</span>` : '';
  return `<div class="cap-summary" id="cap-summary">
    <div class="cap-stats-row">
      <div class="cap-stat">
        <div class="cap-stat-label">Used</div>
        <div class="cap-stat-value${cap.over ? ' cap-over' : ''}">${cap.retainerUsed}h</div>
      </div>
      <div class="cap-stat-div"></div>
      <div class="cap-stat">
        <div class="cap-stat-label">Available</div>
        <div class="cap-stat-value">${cap.available}h</div>
      </div>
      <div class="cap-stat-div"></div>
      <div class="cap-stat">
        <div class="cap-stat-label">Included</div>
        <div class="cap-stat-value">${cap.includedCap}h</div>
      </div>
      <div class="cap-stat-div"></div>
      <div class="cap-stat">
        <div class="cap-stat-label">Additional Approved</div>
        <div class="cap-stat-value">${cap.additionalCap}h</div>
      </div>
      ${!locked ? `<button class="cap-edit-btn" data-action="cap-edit">Edit capacity</button>` : ''}
    </div>
    ${sepNote || nbNote ? `<div class="cap-notes-row">${sepNote}${nbNote ? ' &nbsp;·&nbsp; ' + nbNote : ''}</div>` : ''}
  </div>`;
}

function _capEditHTML(cycle) {
  return `<div class="cap-edit-form" id="cap-summary">
    <div class="cap-edit-row">
      <label class="cap-edit-label">Included hours</label>
      <input class="cycle-cap-input" type="number" min="1" step="1" value="${cycle.capacity.includedHours||20}" data-action="cap-included">
      <span class="cap-edit-sep"></span>
      <label class="cap-edit-label">Additional approved</label>
      <input class="cycle-cap-input" type="number" min="0" step="0.5" value="${cycle.capacity.approvedAdditionalHours||0}" data-action="cap-additional">
    </div>
    <div class="cap-formula">Available = Included + Additional Approved − Retainer time logged</div>
    <div class="cap-edit-actions">
      <button class="btn btn-primary btn-sm" data-action="cap-save">Save</button>
      <button class="btn btn-ghost btn-sm"   data-action="cap-cancel">Cancel</button>
    </div>
  </div>`;
}

// ── Plan section ──────────────────────────────────────────────────────────────

function _planBody(cycle) {
  const locked = cycle.locked;
  const priorities  = cycle.plan.priorities || [];
  const clientResps = cycle.plan.clientResponsibilities || [];

  return `
    <div class="cycle-field">
      <label class="cycle-label">Primary Objective</label>
      <textarea class="note-textarea" data-action="plan-objective" rows="2" placeholder="Main goal for this month…"${locked?' disabled':''}>${escHtml(cycle.plan.primaryObjective||'')}</textarea>
    </div>
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Priorities</span>
        ${!locked?`<button class="cycle-add-btn" data-action="plan-priority-add">+ Add</button>`:''}
      </div>
      <div class="cycle-list" id="cy-priorities">
        ${priorities.length===0?`<div class="cycle-empty-list">No priorities added</div>`:''}
        ${priorities.map((p,i)=>`
          <div class="cycle-row" data-idx="${i}">
            <input class="cycle-text-input" type="text" value="${escHtml(p.label)}" placeholder="Priority description…" data-action="plan-priority-label" data-idx="${i}"${locked?' disabled':''}>
            <input class="cycle-hrs-input" type="number" min="0" step="0.5" value="${p.estimatedHours||''}" placeholder="h" data-action="plan-priority-hours" data-idx="${i}" title="Estimated hours"${locked?' disabled':''}>
            ${!locked?`<button class="cycle-del-btn" data-action="plan-priority-del" data-idx="${i}">×</button>`:''}
          </div>`).join('')}
      </div>
    </div>
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Client Responsibilities</span>
        ${!locked?`<button class="cycle-add-btn" data-action="plan-client-add">+ Add</button>`:''}
      </div>
      <div class="cycle-list">
        ${clientResps.length===0?`<div class="cycle-empty-list">No client responsibilities</div>`:''}
        ${clientResps.map((r,i)=>`
          <div class="cycle-row" data-idx="${i}">
            <input class="cycle-text-input" type="text" value="${escHtml(r.label)}" placeholder="What the client needs to do or provide…" data-action="plan-client-label" data-idx="${i}"${locked?' disabled':''}>
            ${_miniSelect('plan-client-status', i, ITEM_STATUSES, r.status, locked)}
            ${!locked?`<button class="cycle-del-btn" data-action="plan-client-del" data-idx="${i}">×</button>`:''}
          </div>`).join('')}
      </div>
    </div>`;
}

// ── Work section ──────────────────────────────────────────────────────────────

function _workBody(cycle) {
  const locked   = cycle.locked;
  const allWork  = cycle.work || [];
  const active   = allWork.filter(w => !w.archived);
  const archived = allWork.filter(w => w.archived);
  const priorities = cycle.plan.priorities || [];

  // Group active items by priority
  const priorityGroups = priorities
    .map(p => ({ priority: p, items: active.filter(w => w.priorityId === p.id) }))
    .filter(g => g.items.length > 0);

  const unlinked = active.filter(w => !w.priorityId || !priorities.find(p => p.id === w.priorityId));

  let html = '';
  if (!locked) html += `<button class="cycle-add-btn" data-action="work-add" style="margin-bottom:14px">+ Add Work Item</button>`;
  if (active.length === 0 && archived.length === 0) html += '<div class="cycle-empty-list">No work items yet</div>';

  priorityGroups.forEach(g => {
    const actual  = _round(g.items.reduce((s, w) => s + _calcActualHours(cycle, w.id), 0));
    const planned = _round(g.items.reduce((s, w) => s + (parseFloat(w.plannedHours)||0), 0));
    html += `<div class="wi-priority-group">
      <div class="wi-priority-group-hdr">
        <span class="wi-priority-label">${escHtml(g.priority.label)}</span>
        <span class="wi-priority-hours">${actual}h actual · ${planned}h planned</span>
      </div>
      ${g.items.map(w => _workCard(w, cycle, priorities, false, locked)).join('')}
    </div>`;
  });

  if (unlinked.length > 0) {
    html += `<div class="wi-priority-group">
      <div class="wi-priority-group-hdr">
        <span class="wi-priority-label wi-label--unlinked">⚠ Unlinked</span>
        <span class="wi-priority-hint">Assign to a priority or mark as separate scope</span>
      </div>
      ${unlinked.map(w => _workCard(w, cycle, priorities, false, locked)).join('')}
    </div>`;
  }

  if (archived.length > 0) {
    html += `<div class="wi-archived-section">
      <button class="wi-archived-toggle" data-action="work-toggle-archived">
        ${_showArchivedWork ? '▾' : '▸'} ${archived.length} archived item${archived.length !== 1 ? 's' : ''}
      </button>
      ${_showArchivedWork ? archived.map(w => _workCard(w, cycle, priorities, true, locked)).join('') : ''}
    </div>`;
  }

  return html;
}

function _workCard(w, cycle, priorities, isArchived, locked) {
  const expanded = _expandedWorkItems.has(w.id);
  const actual   = _calcActualHours(cycle, w.id);
  return `<div class="wi-card wi-status--${w.status}${isArchived ? ' wi-archived' : ''}" data-wid="${w.id}">
    <div class="wi-card-hdr" data-action="wi-toggle" data-wid="${w.id}">
      <div class="wi-card-hdr-left">
        ${_miniSelect('wi-status', null, WORK_STATUSES, w.status, locked || isArchived, `data-wid="${w.id}"`)}
        <span class="wi-title">${w.title ? escHtml(w.title) : '<em style="color:var(--muted)">Untitled</em>'}</span>
        ${w.separateScope ? '<span class="wi-badge wi-badge--scope">Separate Scope</span>' : ''}
        ${w.roadmapRef    ? `<span class="wi-badge wi-badge--ref">${escHtml(w.roadmapRef)}</span>` : ''}
      </div>
      <div class="wi-card-hdr-right">
        <span class="wi-hours-pill">Plan ${w.plannedHours||0}h · Actual ${actual}h</span>
        <svg class="wi-chevron${expanded?' wi-open':''}" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6l4 4 4-4"/></svg>
      </div>
    </div>
    ${expanded ? _workCardBody(w, cycle, priorities, actual, locked, isArchived) : ''}
  </div>`;
}

function _workCardBody(w, cycle, priorities, actual, locked, isArchived) {
  const dis       = locked || isArchived;
  const hasEntries = (cycle.capacity.timeEntries || []).some(e => e.workItemId === w.id);

  return `<div class="wi-card-body">
    <div class="wi-field-grid">
      <div class="wi-field">
        <label class="wi-field-label">Title</label>
        <input class="cycle-text-input" type="text" value="${escHtml(w.title||'')}" placeholder="Work item title…" data-action="wi-title" data-wid="${w.id}"${dis?' disabled':''}>
      </div>
      <div class="wi-field">
        <label class="wi-field-label">Priority</label>
        <select class="cycle-mini-sel wi-field-sel" data-action="wi-priority" data-wid="${w.id}"${dis?' disabled':''}>
          <option value="">— Unlinked —</option>
          ${priorities.map(p=>`<option value="${p.id}" ${p.id===w.priorityId?'selected':''}>${escHtml(p.label)}</option>`).join('')}
        </select>
      </div>
      <div class="wi-field">
        <label class="wi-field-label">Roadmap Ref</label>
        <input class="cycle-text-input" type="text" value="${escHtml(w.roadmapRef||'')}" placeholder="e.g. CRM-03" data-action="wi-roadmap-ref" data-wid="${w.id}"${dis?' disabled':''}>
      </div>
      <div class="wi-field">
        <label class="wi-field-label">Owner</label>
        <select class="cycle-mini-sel wi-field-sel" data-action="wi-owner" data-wid="${w.id}"${dis?' disabled':''}>
          ${OWNERS.map(o=>`<option value="${o.value}" ${o.value===(w.owner||'laminar')?'selected':''}>${o.label}</option>`).join('')}
        </select>
      </div>
      <div class="wi-field">
        <label class="wi-field-label">Planned Hours</label>
        <input class="cycle-hrs-input" type="number" min="0" step="0.5" value="${w.plannedHours||''}" placeholder="h" data-action="wi-planned-hours" data-wid="${w.id}"${dis?' disabled':''}>
      </div>
      <div class="wi-field">
        <label class="wi-field-label">Actual Hours</label>
        <span class="wi-actual-hrs">${actual}h <span class="wi-actual-hint">from time log</span></span>
      </div>
      <div class="wi-field">
        <label class="wi-field-label">Due Date</label>
        <input class="app-input" type="date" value="${w.dueDate||''}" data-action="wi-due-date" data-wid="${w.id}"${dis?' disabled':''}>
      </div>
      <div class="wi-field wi-field--check">
        <label class="wi-field-label">Separate Scope</label>
        <label class="wi-check-label"><input type="checkbox" data-action="wi-separate-scope" data-wid="${w.id}" ${w.separateScope?'checked':''}${dis?' disabled':''}> Exclude from retainer capacity</label>
      </div>
    </div>
    <div class="wi-ta-fields">
      <div class="wi-ta-field">
        <label class="wi-field-label">Description</label>
        <textarea class="note-textarea" data-action="wi-description" data-wid="${w.id}" placeholder="What is this work item?" rows="2"${dis?' disabled':''}>${escHtml(w.description||'')}</textarea>
      </div>
      <div class="wi-ta-field">
        <label class="wi-field-label">Target Outcome</label>
        <textarea class="note-textarea" data-action="wi-target-outcome" data-wid="${w.id}" placeholder="What does success look like?" rows="2"${dis?' disabled':''}>${escHtml(w.targetOutcome||'')}</textarea>
      </div>
      <div class="wi-ta-field">
        <label class="wi-field-label">Dependency / Blocker</label>
        <textarea class="note-textarea" data-action="wi-dependency" data-wid="${w.id}" placeholder="Any blockers or dependencies?" rows="1"${dis?' disabled':''}>${escHtml(w.dependency||'')}</textarea>
      </div>
      <div class="wi-ta-field">
        <label class="wi-field-label">Evidence / Result</label>
        <textarea class="note-textarea" data-action="wi-evidence" data-wid="${w.id}" placeholder="What was achieved or produced?" rows="1"${dis?' disabled':''}>${escHtml(w.evidence||'')}</textarea>
      </div>
    </div>
    ${!dis ? `<div class="wi-card-footer">
      ${!isArchived ? `<button class="btn btn-ghost btn-sm" data-action="wi-archive" data-wid="${w.id}">Archive</button>` : `<button class="btn btn-ghost btn-sm" data-action="wi-unarchive" data-wid="${w.id}">Unarchive</button>`}
      ${!isArchived && !hasEntries ? `<button class="btn btn-danger btn-sm" data-action="wi-delete" data-wid="${w.id}">Delete</button>` : ''}
    </div>` : ''}
  </div>`;
}

// ── Governance section ────────────────────────────────────────────────────────

function _govBody(cycle) {
  const locked = cycle.locked;
  const { decisions, blockers, clientActions } = cycle.governance;

  return `
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Decisions</span>
        ${!locked?`<button class="cycle-add-btn" data-action="gov-decision-add">+ Add</button>`:''}
      </div>
      <div class="cycle-list">
        ${decisions.length===0?`<div class="cycle-empty-list">No decisions recorded</div>`:''}
        ${decisions.map((d,i)=>`
          <div class="cycle-row" data-idx="${i}">
            <input class="cycle-text-input" type="text" value="${escHtml(d.text)}" placeholder="Decision made…" data-action="gov-decision-text" data-idx="${i}"${locked?' disabled':''}>
            <span class="cycle-date-chip">${d.date?_fmtDate(d.date):''}</span>
            ${!locked?`<button class="cycle-del-btn" data-action="gov-decision-del" data-idx="${i}">×</button>`:''}
          </div>`).join('')}
      </div>
    </div>
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Blockers</span>
        ${!locked?`<button class="cycle-add-btn" data-action="gov-blocker-add">+ Add</button>`:''}
      </div>
      <div class="cycle-list">
        ${blockers.length===0?`<div class="cycle-empty-list">No blockers recorded</div>`:''}
        ${blockers.map((b,i)=>`
          <div class="cycle-row" data-idx="${i}">
            <input class="cycle-text-input" type="text" value="${escHtml(b.text)}" placeholder="Blocker description…" data-action="gov-blocker-text" data-idx="${i}"${locked?' disabled':''}>
            ${_miniSelect('gov-blocker-status', i, BLOCKER_STATUSES, b.status, locked)}
            ${!locked?`<button class="cycle-del-btn" data-action="gov-blocker-del" data-idx="${i}">×</button>`:''}
          </div>`).join('')}
      </div>
    </div>
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Client Actions</span>
        ${!locked?`<button class="cycle-add-btn" data-action="gov-client-add">+ Add</button>`:''}
      </div>
      <div class="cycle-list">
        ${clientActions.length===0?`<div class="cycle-empty-list">No client actions recorded</div>`:''}
        ${clientActions.map((a,i)=>`
          <div class="cycle-row" data-idx="${i}">
            <input class="cycle-text-input" type="text" value="${escHtml(a.text)}" placeholder="What is the client responsible for?" data-action="gov-client-text" data-idx="${i}"${locked?' disabled':''}>
            ${_miniSelect('gov-client-status', i, ITEM_STATUSES, a.status, locked)}
            ${!locked?`<button class="cycle-del-btn" data-action="gov-client-del" data-idx="${i}">×</button>`:''}
          </div>`).join('')}
      </div>
    </div>`;
}

// ── Deliverables section ──────────────────────────────────────────────────────

function _delsBody(cycle) {
  const locked = cycle.locked;
  const DEFS = [
    { key: 'operatingReview', name: 'Operating Review Notes',      required: true  },
    { key: 'roadmapUpdate',   name: 'Roadmap & Work Queue Update', required: true  },
    { key: 'capacityReport',  name: 'Monthly Capacity Report',     required: true  },
    { key: 'kpiReview',       name: 'KPI Dashboard Review',        required: false },
  ];

  return `<div class="cycle-dels-list">
    ${DEFS.map(def => {
      const d    = cycle.deliverables[def.key] || { status:'pending', completedAt:'', notes:'' };
      const done = d.status === 'complete';
      return `<div class="cycle-del-row">
        <div class="cycle-del-hdr">
          <div class="cycle-del-name-wrap">
            <span class="cycle-del-name${done?' cycle-del-done':''}">${escHtml(def.name)}</span>
            ${def.required ? '<span class="del-required-badge">Required</span>' : '<span class="del-cond-badge">Conditional</span>'}
          </div>
          <div class="cycle-del-controls">
            ${done && d.completedAt ? `<span class="cycle-date-chip">${_fmtDate(d.completedAt)}</span>` : ''}
            ${_miniSelect('del-status', null, DEL_STATUSES, d.status, locked, `data-key="${def.key}"`)}
          </div>
        </div>
        <textarea class="cycle-notes-ta" data-action="del-notes" data-key="${def.key}" placeholder="Notes, link, or reference…" rows="1"${locked?' disabled':''}>${escHtml(d.notes||'')}</textarea>
      </div>`;
    }).join('')}
  </div>`;
}

// ── Time log section ──────────────────────────────────────────────────────────

function _timeBody(cycle) {
  const locked  = cycle.locked;
  const entries = cycle.capacity.timeEntries || [];
  const today   = new Date().toISOString().slice(0, 10);
  const cap     = _calcCapacity(cycle);
  const workItems = (cycle.work || []).filter(w => !w.archived);

  return `<div class="cycle-field">
    ${!locked ? `<div class="cycle-time-add">
      <div class="time-add-row">
        <input class="app-input" type="date" value="${today}" data-action="time-date" style="width:136px">
        <select class="app-select" data-action="time-work-item" style="flex:1;min-width:160px">
          ${_workItemSelectOptions(cycle)}
        </select>
        <select class="app-select" data-action="time-billing" style="width:140px">
          ${BILLING_CATEGORIES.map(c=>`<option value="${c.value}">${c.label}</option>`).join('')}
        </select>
      </div>
      <div class="time-add-row">
        <select class="app-select" data-action="time-cat" style="width:148px">
          ${TIME_CATEGORIES.map(c=>`<option value="${c.value}">${c.label}</option>`).join('')}
        </select>
        <input class="cycle-hrs-input" type="number" min="0.5" max="20" step="0.5" placeholder="h" data-action="time-hours">
        <input class="app-input" type="text" placeholder="Description…" data-action="time-desc" style="flex:1">
        <button class="btn btn-primary btn-sm" data-action="time-add">Add</button>
      </div>
    </div>` : ''}
    <div class="cycle-time-list">
      ${entries.length===0 ? `<div class="cycle-empty-list">No time entries yet</div>` : ''}
      ${entries.map((e,i) => {
        const wi       = workItems.find(w => w.id === e.workItemId);
        const wiLabel  = wi ? escHtml(wi.title||'Untitled') : 'General';
        const billCat  = e.billingCategory || 'included';
        const billLabel = BILLING_CATEGORIES.find(b => b.value === billCat)?.label || 'Included';
        return `<div class="cycle-time-entry" data-idx="${i}">
          <span class="cycle-time-date">${_fmtDate(e.date)}</span>
          <span class="cycle-time-wi">${wiLabel}</span>
          <span class="cycle-time-bill cycle-bill--${billCat}">${billLabel}</span>
          <span class="cycle-time-cat">${TIME_CATEGORIES.find(c=>c.value===e.category)?.label||e.category||''}</span>
          <span class="cycle-time-hrs">${e.hours}h</span>
          <span class="cycle-time-desc">${escHtml(e.description||'')}</span>
          ${!locked?`<button class="cycle-del-btn" data-action="time-del" data-idx="${i}">×</button>`:''}
        </div>`;
      }).join('')}
    </div>
    ${entries.length > 0 ? `<div class="cycle-time-total">
      Retainer: <strong>${cap.retainerUsed}h</strong>
      ${cap.separateScopeHrs > 0 ? ` · Separate scope: <strong>${cap.separateScopeHrs}h</strong>` : ''}
      ${cap.nonBillableHrs   > 0 ? ` · Non-billable: <strong>${cap.nonBillableHrs}h</strong>`   : ''}
    </div>` : ''}
  </div>`;
}

function _workItemSelectOptions(cycle) {
  const priorities = cycle.plan.priorities || [];
  const workItems  = (cycle.work || []).filter(w => !w.archived);
  const regularWI  = workItems.filter(w => !w.separateScope);
  const scopeWI    = workItems.filter(w => w.separateScope);

  let html = '<option value="">General / Unallocated</option>';

  priorities.forEach(p => {
    const items = regularWI.filter(w => w.priorityId === p.id);
    if (items.length) {
      html += `<optgroup label="${escHtml(p.label)}">`;
      items.forEach(w => { html += `<option value="${w.id}">${escHtml(w.title||'Untitled')}</option>`; });
      html += '</optgroup>';
    }
  });

  const unlinked = regularWI.filter(w => !w.priorityId || !priorities.find(p => p.id === w.priorityId));
  if (unlinked.length) {
    html += '<optgroup label="Unlinked">';
    unlinked.forEach(w => { html += `<option value="${w.id}">${escHtml(w.title||'Untitled')}</option>`; });
    html += '</optgroup>';
  }

  if (scopeWI.length) {
    html += '<optgroup label="Separate Scope">';
    scopeWI.forEach(w => { html += `<option value="${w.id}">${escHtml(w.title||'Untitled')}</option>`; });
    html += '</optgroup>';
  }

  return html;
}

// ── Close section ─────────────────────────────────────────────────────────────

function _closeBody(cycle, cap) {
  const locked   = cycle.locked;
  const outcomes = cycle.closeout.outcomes || [];
  const deferred = cycle.closeout.deferredWork || [];
  const ack      = cycle.closeout.clientAcknowledgement || {};
  const delsOk   = _requiredDelsComplete(cycle);

  return `
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Outcomes</span>
        ${!locked?`<button class="cycle-add-btn" data-action="close-outcome-add">+ Add</button>`:''}
      </div>
      <div class="cycle-list">
        ${outcomes.length===0?`<div class="cycle-empty-list">No outcomes recorded</div>`:''}
        ${outcomes.map((o,i)=>`
          <div class="cycle-row" data-idx="${i}">
            <input class="cycle-text-input" type="text" value="${escHtml(o.text)}" placeholder="What was achieved…" data-action="close-outcome-text" data-idx="${i}"${locked?' disabled':''}>
            ${!locked?`<button class="cycle-del-btn" data-action="close-outcome-del" data-idx="${i}">×</button>`:''}
          </div>`).join('')}
      </div>
    </div>
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Deferred Work</span>
        ${!locked?`<button class="cycle-add-btn" data-action="close-deferred-add">+ Add</button>`:''}
      </div>
      <div class="cycle-list">
        ${deferred.length===0?`<div class="cycle-empty-list">Nothing deferred</div>`:''}
        ${deferred.map((d,i)=>`
          <div class="cycle-row" data-idx="${i}">
            <input class="cycle-text-input" type="text" value="${escHtml(d.text)}" placeholder="What was not completed…" data-action="close-deferred-text" data-idx="${i}"${locked?' disabled':''}>
            ${_miniSelect('close-deferred-disp', i, DEFER_DISPOSITIONS, d.disposition||'carry-forward', locked)}
            ${!locked?`<button class="cycle-del-btn" data-action="close-deferred-del" data-idx="${i}">×</button>`:''}
          </div>`).join('')}
      </div>
    </div>
    <div class="cycle-field">
      <label class="cycle-label">Next Month Recommendations</label>
      <textarea class="note-textarea" data-action="close-recommendations" rows="2" placeholder="What should be prioritised next month?"${locked?' disabled':''}>${escHtml(cycle.closeout.nextCycleRecommendations||'')}</textarea>
    </div>
    <div class="cycle-field">
      <div class="cycle-label-row">
        <span class="cycle-label">Client Acknowledgement</span>
        ${_miniSelect('close-ack-status', null, ACK_STATUSES, ack.status||'pending', locked)}
      </div>
      <textarea class="cycle-notes-ta" data-action="close-ack-notes" placeholder="Delivery reference, date sent, or notes…" rows="1"${locked?' disabled':''}>${escHtml(ack.notes||'')}</textarea>
    </div>
    ${!locked ? `<div class="cycle-close-bar">
      ${!delsOk ? `<span class="cycle-close-warn">Complete the 3 required deliverables before closing.</span>` : ''}
      <button class="btn btn-danger" data-action="cycle-close"${delsOk?'':' disabled'}>Close Cycle</button>
    </div>` : ''}`;
}

// ── Events ────────────────────────────────────────────────────────────────────

function _attachEvents() {
  if (_container.dataset.cycleListeners) return;
  _container.dataset.cycleListeners = '1';

  // ── change ──────────────────────────────────────────────────────────────────
  _container.addEventListener('change', e => {
    const el     = e.target;
    const action = el.dataset.action;
    if (!action) return;

    if (action === 'cycle-select') { _activeCycleId = el.value; _render(); return; }

    const cycle = getCycle(_projectId, _activeCycleId);
    if (!cycle) return;

    // Cycle-level selects
    if (action === 'cycle-status-change' && !cycle.locked) { _mut(c => { c.status = el.value; }); _render(); return; }
    if (cycle.locked) return;

    const i   = el.dataset.idx !== undefined ? +el.dataset.idx : null;
    const wid = el.dataset.wid;
    const key = el.dataset.key;

    // Work item selects
    if (wid) {
      if (action === 'wi-status')         { _mut(c => { const w=_wi(c,wid); if(w) w.status    = el.value; }); _rerender('work', _workBody); return; }
      if (action === 'wi-priority')        { _mut(c => { const w=_wi(c,wid); if(w) w.priorityId= el.value||null; }); _rerender('work', _workBody); return; }
      if (action === 'wi-owner')           { _mut(c => { const w=_wi(c,wid); if(w) w.owner     = el.value; }); return; }
      if (action === 'wi-separate-scope')  { _mut(c => { const w=_wi(c,wid); if(w) w.separateScope = el.checked; }); _rerender('work', _workBody); return; }
    }

    // Plan selects
    if (action === 'plan-client-status')   { _mut(c => { c.plan.clientResponsibilities[i].status = el.value; }); return; }

    // Governance selects
    if (action === 'gov-blocker-status')   { _mut(c => { c.governance.blockers[i].status     = el.value; }); return; }
    if (action === 'gov-client-status')    { _mut(c => { c.governance.clientActions[i].status = el.value; }); return; }

    // Deferred disposition
    if (action === 'close-deferred-disp') { _mut(c => { c.closeout.deferredWork[i].disposition = el.value; }); return; }

    // Acknowledgement
    if (action === 'close-ack-status') {
      _mut(c => {
        if (!c.closeout.clientAcknowledgement) c.closeout.clientAcknowledgement = {};
        c.closeout.clientAcknowledgement.status = el.value;
        if (el.value === 'received') c.closeout.clientAcknowledgement.receivedAt = new Date().toISOString();
      });
      return;
    }

    // Deliverable status
    if (action === 'del-status' && key) {
      _mut(c => {
        if (!c.deliverables[key]) c.deliverables[key] = {};
        c.deliverables[key].status = el.value;
        if (el.value === 'complete' && !c.deliverables[key].completedAt) {
          c.deliverables[key].completedAt = new Date().toISOString();
        } else if (el.value !== 'complete') {
          c.deliverables[key].completedAt = '';
        }
      });
      _rerender('deliverables', _delsBody);
      _rerenderClose();
      return;
    }

    // Capacity (edit form)
    if (action === 'cap-included')  { _mut(c => { c.capacity.includedHours             = parseFloat(el.value)||20; }); _rerenderCapSummary(); return; }
    if (action === 'cap-additional'){ _mut(c => { c.capacity.approvedAdditionalHours   = parseFloat(el.value)||0;  }); _rerenderCapSummary(); return; }
  });

  // ── input ───────────────────────────────────────────────────────────────────
  _container.addEventListener('input', e => {
    const el     = e.target;
    const action = el.dataset.action;
    if (!action) return;
    const cycle = getCycle(_projectId, _activeCycleId);
    if (!cycle || cycle.locked) return;
    const i   = el.dataset.idx !== undefined ? +el.dataset.idx : null;
    const wid = el.dataset.wid;
    const key = el.dataset.key;

    // Work item text fields
    if (wid) {
      if (action === 'wi-title')         { _mut(c => { const w=_wi(c,wid); if(w) w.title        = el.value; }); return; }
      if (action === 'wi-roadmap-ref')   { _mut(c => { const w=_wi(c,wid); if(w) w.roadmapRef   = el.value; }); return; }
      if (action === 'wi-planned-hours') { _mut(c => { const w=_wi(c,wid); if(w) w.plannedHours = parseFloat(el.value)||0; }); return; }
      if (action === 'wi-due-date')      { _mut(c => { const w=_wi(c,wid); if(w) w.dueDate       = el.value; }); return; }
      if (action === 'wi-description')   { _mut(c => { const w=_wi(c,wid); if(w) w.description   = el.value; }); autoResize(el); return; }
      if (action === 'wi-target-outcome'){ _mut(c => { const w=_wi(c,wid); if(w) w.targetOutcome = el.value; }); autoResize(el); return; }
      if (action === 'wi-dependency')    { _mut(c => { const w=_wi(c,wid); if(w) w.dependency    = el.value; }); autoResize(el); return; }
      if (action === 'wi-evidence')      { _mut(c => { const w=_wi(c,wid); if(w) w.evidence      = el.value; }); autoResize(el); return; }
    }

    // Plan text fields
    if (action === 'plan-objective')       { _mut(c => { c.plan.primaryObjective = el.value; }); autoResize(el); return; }
    if (action === 'plan-priority-label')  { _mut(c => { c.plan.priorities[i].label = el.value; }); return; }
    if (action === 'plan-priority-hours')  { _mut(c => { c.plan.priorities[i].estimatedHours = parseFloat(el.value)||0; }); return; }
    if (action === 'plan-client-label')    { _mut(c => { c.plan.clientResponsibilities[i].label = el.value; }); return; }

    // Governance text fields
    if (action === 'gov-decision-text')   { _mut(c => { c.governance.decisions[i].text     = el.value; }); return; }
    if (action === 'gov-blocker-text')    { _mut(c => { c.governance.blockers[i].text       = el.value; }); return; }
    if (action === 'gov-client-text')     { _mut(c => { c.governance.clientActions[i].text  = el.value; }); return; }

    // Deliverable notes
    if (action === 'del-notes' && key)    { _mut(c => { if(!c.deliverables[key]) c.deliverables[key]={}; c.deliverables[key].notes = el.value; }); autoResize(el); return; }

    // Close fields
    if (action === 'close-outcome-text')    { _mut(c => { c.closeout.outcomes[i].text = el.value; }); return; }
    if (action === 'close-deferred-text')   { _mut(c => { c.closeout.deferredWork[i].text = el.value; }); return; }
    if (action === 'close-recommendations') { _mut(c => { c.closeout.nextCycleRecommendations = el.value; }); autoResize(el); return; }
    if (action === 'close-ack-notes')       { _mut(c => { if(!c.closeout.clientAcknowledgement) c.closeout.clientAcknowledgement={}; c.closeout.clientAcknowledgement.notes = el.value; }); autoResize(el); return; }
  });

  // ── click ───────────────────────────────────────────────────────────────────
  _container.addEventListener('click', e => {
    const el     = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const i      = el.dataset.idx !== undefined ? +el.dataset.idx : null;
    const wid    = el.dataset.wid;

    // Section toggle
    if (action === 'cycle-sec-toggle') { el.closest('.cycle-section')?.classList.toggle('collapsed'); return; }

    // New month flow
    if (action === 'cycle-new')        { _newMonthOpen = true;  _render(); return; }
    if (action === 'cycle-new-cancel') { _newMonthOpen = false; _render(); return; }
    if (action === 'cycle-new-confirm') {
      const input  = _container.querySelector('[data-action="cycle-new-period"]');
      const period = input?.value;
      if (!period || !/^\d{4}-\d{2}$/.test(period)) { if (input) input.style.outline='2px solid var(--danger)'; return; }
      const newId = createCycle(_projectId, period);
      if (!newId) { if (input) { input.style.outline='2px solid var(--danger)'; input.title='A cycle for this period already exists'; } return; }
      _newMonthOpen  = false;
      _activeCycleId = newId;
      _render();
      return;
    }

    // Cycle reopen / close
    if (action === 'cycle-reopen') {
      const reason = prompt('Reason for reopening this cycle:');
      if (reason === null) return;
      reopenCycle(_projectId, _activeCycleId, (reason||'').trim() || 'No reason given');
      _render();
      return;
    }
    if (action === 'cycle-close') {
      const cycle = getCycle(_projectId, _activeCycleId);
      if (!cycle || !_requiredDelsComplete(cycle)) return;
      if (!confirm(`Close the ${_fmtPeriod(cycle.period)} cycle? This will lock the record.`)) return;
      closeCycle(_projectId, _activeCycleId);
      _render();
      return;
    }

    // Capacity edit controls
    if (action === 'cap-edit')   { _editingCapacity = true;  _render(); return; }
    if (action === 'cap-cancel') { _editingCapacity = false; _render(); return; }
    if (action === 'cap-save') {
      const inc = parseFloat(_container.querySelector('[data-action="cap-included"]')?.value)  || 20;
      const add = parseFloat(_container.querySelector('[data-action="cap-additional"]')?.value) || 0;
      _mut(c => { c.capacity.includedHours = inc; c.capacity.approvedAdditionalHours = add; });
      _editingCapacity = false;
      _render();
      return;
    }

    const cycle = getCycle(_projectId, _activeCycleId);
    if (!cycle || cycle.locked) return;

    // Work item actions
    if (action === 'wi-toggle') {
      const id = el.closest('[data-wid]')?.dataset.wid || wid;
      if (!id) return;
      if (_expandedWorkItems.has(id)) _expandedWorkItems.delete(id); else _expandedWorkItems.add(id);
      _rerender('work', _workBody);
      return;
    }
    if (action === 'work-toggle-archived') { _showArchivedWork = !_showArchivedWork; _rerender('work', _workBody); return; }
    if (action === 'work-add') {
      const newId = generateId();
      _mut(c => c.work.push({
        id: newId, title: '', priorityId: null, roadmapRef: '', description: '',
        owner: 'laminar', status: 'planned', plannedHours: 0,
        targetOutcome: '', dueDate: '', dependency: '', evidence: '',
        separateScope: false, archived: false, notes: '',
      }));
      _expandedWorkItems.add(newId);
      _rerender('work', _workBody);
      return;
    }
    if (action === 'wi-archive' && wid) {
      _mut(c => { const w=_wi(c,wid); if(w) w.archived = true; });
      _expandedWorkItems.delete(wid);
      _rerender('work', _workBody);
      return;
    }
    if (action === 'wi-unarchive' && wid) {
      _mut(c => { const w=_wi(c,wid); if(w) w.archived = false; });
      _rerender('work', _workBody);
      return;
    }
    if (action === 'wi-delete' && wid) {
      const hasEntries = (cycle.capacity.timeEntries||[]).some(e => e.workItemId === wid);
      if (hasEntries) return; // button is hidden when entries exist, guard anyway
      if (!confirm('Delete this work item?')) return;
      _mut(c => { c.work = c.work.filter(w => w.id !== wid); });
      _expandedWorkItems.delete(wid);
      _rerender('work', _workBody);
      return;
    }

    // Plan list actions
    if (action === 'plan-priority-add')  { _mut(c => c.plan.priorities.push({ id:generateId(), label:'', estimatedHours:0, notes:'' })); _rerender('plan', _planBody); _focusLast('#cy-priorities .cycle-text-input'); return; }
    if (action === 'plan-priority-del')  { _mut(c => c.plan.priorities.splice(i,1)); _rerender('plan', _planBody); return; }
    if (action === 'plan-client-add')    { _mut(c => c.plan.clientResponsibilities.push({ id:generateId(), label:'', status:'pending' })); _rerender('plan', _planBody); return; }
    if (action === 'plan-client-del')    { _mut(c => c.plan.clientResponsibilities.splice(i,1)); _rerender('plan', _planBody); return; }

    // Governance list actions
    if (action === 'gov-decision-add')   { _mut(c => c.governance.decisions.push({ id:generateId(), text:'', date:new Date().toISOString() })); _rerender('governance', _govBody); return; }
    if (action === 'gov-decision-del')   { _mut(c => c.governance.decisions.splice(i,1)); _rerender('governance', _govBody); return; }
    if (action === 'gov-blocker-add')    { _mut(c => c.governance.blockers.push({ id:generateId(), text:'', status:'open' })); _rerender('governance', _govBody); return; }
    if (action === 'gov-blocker-del')    { _mut(c => c.governance.blockers.splice(i,1)); _rerender('governance', _govBody); return; }
    if (action === 'gov-client-add')     { _mut(c => c.governance.clientActions.push({ id:generateId(), text:'', status:'pending' })); _rerender('governance', _govBody); return; }
    if (action === 'gov-client-del')     { _mut(c => c.governance.clientActions.splice(i,1)); _rerender('governance', _govBody); return; }

    // Close list actions
    if (action === 'close-outcome-add')   { _mut(c => c.closeout.outcomes.push({ id:generateId(), text:'' })); _rerenderClose(); return; }
    if (action === 'close-outcome-del')   { _mut(c => c.closeout.outcomes.splice(i,1)); _rerenderClose(); return; }
    if (action === 'close-deferred-add')  { _mut(c => c.closeout.deferredWork.push({ id:generateId(), text:'', disposition:'carry-forward' })); _rerenderClose(); return; }
    if (action === 'close-deferred-del')  { _mut(c => c.closeout.deferredWork.splice(i,1)); _rerenderClose(); return; }

    // Time log actions
    if (action === 'time-add') {
      const date     = _container.querySelector('[data-action="time-date"]')?.value;
      const workItemId = _container.querySelector('[data-action="time-work-item"]')?.value || null;
      const billing  = _container.querySelector('[data-action="time-billing"]')?.value || 'included';
      const cat      = _container.querySelector('[data-action="time-cat"]')?.value;
      const hrsEl    = _container.querySelector('[data-action="time-hours"]');
      const desc     = _container.querySelector('[data-action="time-desc"]')?.value || '';
      const hrs      = parseFloat(hrsEl?.value);
      if (!hrs || hrs <= 0) { if (hrsEl) { hrsEl.focus(); hrsEl.style.outline='2px solid var(--danger)'; } return; }
      _mut(c => {
        if (!c.capacity.timeEntries) c.capacity.timeEntries = [];
        c.capacity.timeEntries.push({ id:generateId(), date, category:cat, hours:hrs, description:desc, workItemId: workItemId||null, billingCategory: billing });
      });
      if (hrsEl) { hrsEl.value=''; hrsEl.style.outline=''; }
      const descEl = _container.querySelector('[data-action="time-desc"]');
      if (descEl) descEl.value = '';
      _rerender('timelog', _timeBody);
      _rerenderCapSummary();
      return;
    }
    if (action === 'time-del') {
      _mut(c => { c.capacity.timeEntries.splice(i,1); });
      _rerender('timelog', _timeBody);
      _rerenderCapSummary();
      return;
    }
  });

  _container.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.dataset.action === 'time-desc') {
      e.preventDefault();
      _container.querySelector('[data-action="time-add"]')?.click();
    }
  });
}

// ── Selective re-renders ──────────────────────────────────────────────────────

function _rerender(sectionId, bodyFn) {
  const cycle = getCycle(_projectId, _activeCycleId);
  if (!cycle) return;
  const body = _container.querySelector(`#cycle-sec-${sectionId} .cycle-sec-body`);
  if (!body) return;
  body.innerHTML = bodyFn(cycle);
  body.querySelectorAll('textarea').forEach(autoResize);
}

function _rerenderClose() {
  const cycle = getCycle(_projectId, _activeCycleId);
  if (!cycle) return;
  const cap  = _calcCapacity(cycle);
  const body = _container.querySelector('#cycle-sec-close .cycle-sec-body');
  if (!body) return;
  body.innerHTML = _closeBody(cycle, cap);
  body.querySelectorAll('textarea').forEach(autoResize);
}

function _rerenderCapSummary() {
  const cycle = getCycle(_projectId, _activeCycleId);
  if (!cycle) return;
  const cap = _calcCapacity(cycle);
  // Update bar
  const fill = document.getElementById('cycle-cap-fill');
  if (fill) { fill.style.width = cap.pct + '%'; fill.classList.toggle('cycle-cap-over', cap.over); }
  // Replace summary block (listeners are delegated so replacement is safe)
  const summary = document.getElementById('cap-summary');
  if (summary) {
    const div = document.createElement('div');
    div.innerHTML = _editingCapacity ? _capEditHTML(cycle) : _capSummaryHTML(cap, cycle.locked);
    summary.replaceWith(div.firstElementChild);
  }
  // Also refresh work section to update actual hours
  _rerender('work', _workBody);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _mut(fn) { mutateCycle(_projectId, _activeCycleId, fn); }

function _wi(cycle, wid) { return cycle.work.find(w => w.id === wid) || null; }

function _calcCapacity(cycle) {
  const entries    = cycle?.capacity?.timeEntries || [];
  const included   = entries.filter(e => (e.billingCategory||'included') === 'included').reduce((s,e)=>s+(parseFloat(e.hours)||0),0);
  const additional = entries.filter(e => e.billingCategory === 'additional').reduce((s,e)=>s+(parseFloat(e.hours)||0),0);
  const sepScope   = entries.filter(e => e.billingCategory === 'separate-scope').reduce((s,e)=>s+(parseFloat(e.hours)||0),0);
  const nonBill    = entries.filter(e => e.billingCategory === 'non-billable').reduce((s,e)=>s+(parseFloat(e.hours)||0),0);
  const incCap     = cycle?.capacity?.includedHours || 20;
  const addCap     = cycle?.capacity?.approvedAdditionalHours || 0;
  const totalCap   = incCap + addCap;
  const retainer   = _round(included + additional);
  const available  = _round(Math.max(0, totalCap - retainer));
  return {
    includedCap:     incCap,
    additionalCap:   addCap,
    totalCap,
    retainerUsed:    retainer,
    available,
    separateScopeHrs: _round(sepScope),
    nonBillableHrs:   _round(nonBill),
    pct:  totalCap > 0 ? Math.min(100, Math.round(retainer / totalCap * 100)) : 0,
    over: retainer > totalCap,
  };
}

function _calcActualHours(cycle, workItemId) {
  const entries = cycle?.capacity?.timeEntries || [];
  return _round(entries.filter(e => e.workItemId === workItemId).reduce((s,e)=>s+(parseFloat(e.hours)||0),0));
}

function _requiredDelsComplete(cycle) {
  return ['operatingReview','roadmapUpdate','capacityReport']
    .every(k => cycle.deliverables[k]?.status === 'complete');
}

function _round(n) { return Math.round(n * 10) / 10; }

function _miniSelect(action, idx, options, current, locked, extra='') {
  const idxAttr = idx !== null ? ` data-idx="${idx}"` : '';
  return `<select class="cycle-mini-sel" data-action="${action}"${idxAttr}${locked?' disabled':''}${extra?' '+extra:''}>
    ${options.map(o=>`<option value="${o.value}"${o.value===current?' selected':''}>${o.label}</option>`).join('')}
  </select>`;
}

function _focusLast(selector) {
  const els = _container.querySelectorAll(selector);
  if (els.length) els[els.length-1].focus();
}

function _fmtPeriod(period) {
  if (!period) return '';
  const [y, m] = period.split('-');
  return new Date(+y, +m-1, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });
}

function _fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function _statusShort(status) {
  const map = { 'draft':'Draft','awaiting-approval':'Awaiting Approval','active':'Active','blocked':'Blocked','review-due':'Review Due','awaiting-ack':'Awaiting Ack','closed':'Closed' };
  return map[status] || status;
}

function _suggestNext(cycles) {
  if (!cycles?.length) { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`; }
  const [y,m] = cycles[cycles.length-1].period.split('-').map(Number);
  const next  = new Date(y, m, 1);
  return `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}`;
}

function _maxPeriod() {
  const d = new Date(); d.setMonth(d.getMonth()+6);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
