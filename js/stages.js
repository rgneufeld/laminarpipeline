// Stage definitions, metadata, and transition validation for the Laminar Pipeline task model.

export const STAGE = {
  PENDING:   'pending',
  IN_SCOPE:  'in-scope',
  NA:        'na',
  ACTIVE:    'active',
  BLOCKED:   'blocked',
  REVIEW:    'client-review',
  COMPLETE:  'complete',
  DELIVERED: 'delivered',
};

// Display labels and CSS token references for each stage.
export const STAGE_META = {
  'pending':       { label: 'Pending',       colorVar: '--stage-pending',   bgVar: '--stage-pending-bg'   },
  'in-scope':      { label: 'In Scope',      colorVar: '--stage-inscope',   bgVar: '--stage-inscope-bg'   },
  'na':            { label: 'N/A',           colorVar: '--stage-na',        bgVar: '--stage-na-bg'        },
  'active':        { label: 'Active',        colorVar: '--stage-active',    bgVar: '--stage-active-bg'    },
  'blocked':       { label: 'Blocked',       colorVar: '--stage-blocked',   bgVar: '--stage-blocked-bg'   },
  'client-review': { label: 'Client Review', colorVar: '--stage-review',    bgVar: '--stage-review-bg'    },
  'complete':      { label: 'Complete',      colorVar: '--stage-complete',  bgVar: '--stage-complete-bg'  },
  'delivered':     { label: 'Delivered',     colorVar: '--stage-delivered', bgVar: '--stage-delivered-bg' },
};

// Valid transitions per stage.
// 'blocked' additionally allows → blockedFrom value (checked dynamically).
const _TRANSITIONS = {
  'pending':       ['in-scope', 'na'],
  'in-scope':      ['pending', 'active', 'na', 'blocked'],
  'na':            ['in-scope'],
  'active':        ['client-review', 'complete', 'blocked', 'in-scope', 'na'],
  'blocked':       ['na'],
  'client-review': ['complete', 'active', 'blocked'],
  'complete':      ['delivered', 'active', 'blocked'],
  'delivered':     ['complete'],
};

export function isValidTransition(fromStage, toStage, blockedFrom = null) {
  if (fromStage === toStage) return false;
  if ((_TRANSITIONS[fromStage] || []).includes(toStage)) return true;
  // Unblock: blocked → blockedFrom is always valid
  if (fromStage === 'blocked' && blockedFrom && toStage === blockedFrom) return true;
  return false;
}

// Returns ordered list of valid destination stages (unblock first if applicable).
export function getValidTransitions(fromStage, blockedFrom = null) {
  const base = (_TRANSITIONS[fromStage] || []).slice();
  if (fromStage === 'blocked' && blockedFrom && !base.includes(blockedFrom)) {
    base.unshift(blockedFrom);
  }
  return base;
}

// Returns null if the deliver transition is valid, or an error string if not.
export function validateDeliver(task) {
  if (task.stage === 'na') return 'Cannot deliver a task marked N/A.';
  const hasComplete = (task.log || []).some(e => e.stage === 'complete');
  if (!hasComplete) return 'Task must reach Complete before it can be Delivered.';
  return null;
}

// True when a transition crosses the scope boundary and requires a client note.
export function isRescope(fromStage, toStage) {
  if (toStage === 'na') return true;
  if (toStage === 'in-scope' && fromStage === 'na') return true;
  return false;
}

// Stages where the block button should not be shown.
export const BLOCK_UNAVAILABLE = new Set(['pending', 'na', 'delivered']);

// Stages that count toward delivery progress.
export const COUNTABLE_STAGES = new Set(['in-scope', 'active', 'blocked', 'client-review', 'complete', 'delivered']);

// Stages considered done for progress purposes.
export const DONE_STAGES = new Set(['complete', 'delivered']);

// Supabase stores enum values with underscores while the established Laminar UI
// uses readable hyphenated values. Keep the translation here so every browser
// surface shares one stage model instead of maintaining a second transition map.
export function stageFromDatabase(stage) {
  return String(stage || 'pending').replaceAll('_', '-');
}

export function stageToDatabase(stage) {
  return String(stage || 'pending').replaceAll('-', '_');
}
