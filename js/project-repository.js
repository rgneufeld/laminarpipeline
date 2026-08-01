import { supabase } from './supabase-client.js';
import { stageFromDatabase, stageToDatabase } from './stages.js';

function one(value) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function loadProjectWorkspace(projectId) {
  const [projectResult, taskResult, noteResult] = await Promise.all([
    supabase
      .from('projects')
      .select('id,organisation_id,name,client_name,status,updated_at,playbook_versions(id,version_number,playbooks(name,code),definition)')
      .eq('id', projectId)
      .maybeSingle(),
    supabase
      .from('project_tasks')
      .select('id,project_id,stable_key,title,stage,sort_rank,blocked_reason,metadata,owner_id,due_on,priority,entered_stage_at,playbook_phases(id,position,label,title,objective,color),playbook_task_templates(guidance,client_action,required_evidence)')
      .eq('project_id', projectId)
      .order('sort_rank', { ascending: true }),
    supabase
      .from('task_notes')
      .select('id,task_id,visibility,body,updated_at')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false }),
  ]);

  const error = projectResult.error || taskResult.error || noteResult.error;
  if (error) throw new Error(error.message);
  if (!projectResult.data) return null;

  const notesByTask = new Map();
  for (const note of noteResult.data || []) {
    if (!notesByTask.has(note.task_id)) notesByTask.set(note.task_id, {});
    const taskNotes = notesByTask.get(note.task_id);
    if (taskNotes[note.visibility] === undefined) taskNotes[note.visibility] = note.body;
  }

  return {
    project: projectResult.data,
    version: one(projectResult.data.playbook_versions),
    tasks: (taskResult.data || []).map(task => ({
      ...task,
      uiStage: stageFromDatabase(task.stage),
      phase: one(task.playbook_phases),
      template: one(task.playbook_task_templates),
      notes: notesByTask.get(task.id) || { internal: '', client: '' },
    })),
  };
}

export async function loadProjectSections(projectId) {
  const [qualificationResult, assetsResult, deliverablesResult, trainingResult, cyclesResult, auditResult] = await Promise.all([
    supabase.from('project_qualification_items').select('id,stable_key,complete,completed_at').eq('project_id', projectId),
    supabase.from('project_asset_items').select('id,stable_key,status,internal_note,metadata,updated_at').eq('project_id', projectId).order('stable_key'),
    supabase.from('deliverables').select('id,stable_key,title,status,client_visible,approval_requested_at,approved_at,metadata').eq('project_id', projectId).order('title'),
    supabase.from('training_records').select('id,stable_key,status,signed_off_at,metadata').eq('project_id', projectId).order('stable_key'),
    supabase.from('operating_cycles').select('id,period,status,locked_at,metadata').eq('project_id', projectId).order('period', { ascending: false }),
    supabase.from('audit_events').select('id,event_type,entity_type,occurred_at,payload').eq('project_id', projectId).order('occurred_at', { ascending: false }).limit(20),
  ]);
  const error = qualificationResult.error || assetsResult.error || deliverablesResult.error || trainingResult.error || cyclesResult.error || auditResult.error;
  if (error) throw new Error(error.message);
  const cycleIds = new Set((cyclesResult.data || []).map(cycle => cycle.id));
  const [workItemsResult, timeEntriesResult] = cycleIds.size ? await Promise.all([
    supabase.from('cycle_work_items').select('id,cycle_id,title,status,estimated_hours,legacy_id,metadata').in('cycle_id', [...cycleIds]),
    supabase.from('cycle_time_entries').select('id,cycle_id,occurred_on,hours,category,note,legacy_id,metadata').in('cycle_id', [...cycleIds]),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (workItemsResult.error || timeEntriesResult.error) throw new Error(workItemsResult.error?.message || timeEntriesResult.error?.message);
  return {
    qualification: qualificationResult.data || [],
    assets: assetsResult.data || [],
    deliverables: deliverablesResult.data || [],
    training: trainingResult.data || [],
    cycles: cyclesResult.data || [],
    workItems: (workItemsResult.data || []).filter(item => cycleIds.has(item.cycle_id)),
    timeEntries: (timeEntriesResult.data || []).filter(entry => cycleIds.has(entry.cycle_id)),
    audit: auditResult.data || [],
  };
}

export async function transitionTask({ taskId, toStage, blockedReason = null, clientNote = null }) {
  const { data, error } = await supabase.rpc('transition_project_task', {
    p_task: taskId,
    p_to: stageToDatabase(toStage),
    p_blocked_reason: blockedReason,
    p_client_note: clientNote,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function saveTaskNote({ taskId, visibility, body }) {
  const { data, error } = await supabase.rpc('upsert_task_note', {
    p_task: taskId,
    p_visibility: visibility,
    p_body: body,
  });
  if (error) throw new Error(error.message);
  return data;
}

async function callMutation(name, args) {
  const { error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
}

export const updateAssetItem = ({ itemId, status, internalNote }) => callMutation('update_project_asset_item', { p_item: itemId, p_status: status, p_internal_note: internalNote });
export const updateDeliverable = ({ deliverableId, status, clientVisible }) => callMutation('update_project_deliverable', { p_deliverable: deliverableId, p_status: status, p_client_visible: clientVisible });
export const updateQualification = ({ itemId, complete }) => callMutation('update_project_qualification', { p_item: itemId, p_complete: complete });
export const updateTraining = ({ recordId, status }) => callMutation('update_training_record', { p_record: recordId, p_status: status });
