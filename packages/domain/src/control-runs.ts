import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext, DatabaseState } from './types';
import type { RouterRequest, RouterResult, SkillName } from './control';
import { prepareControlInput, evaluateControlInput, validateControlOutput, type ControlEvidence } from './control-service';
import { hasPermission } from './auth';
import { SKILL_TOOL } from './control-request';
import { DomainError, explicitTimestamp, requireCondition } from './validation';

export const CONTROL_PLANS = {
  growth: ['brand_guardian', 'growth_analyst', 'crm_planner'],
  content: ['brand_guardian', 'content_producer'],
  campus: ['campus_coordinator', 'event_planner'],
  voice: ['customer_voice', 'growth_analyst']
} as const;
type PlanName = keyof typeof CONTROL_PLANS;
type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ControlProviderMode = 'deterministic_offline' | 'codebuddy_cli';
export interface ControlRun {
  schemaVersion: 1;
  execution?: 'manual' | 'background';
  inputSnapshot?: ControlEvidence[];
  inputHash?: string;
  id: string; tenantId: string; storeId: string; createdBy: string; requestKey: string; requestHash: string;
  plan: PlanName; prompt: string; status: RunStatus; version: number;
  createdAt: string; updatedAt: string; deadlineAt: string; asOf: string;
  budgetMinor: number; actualCostMinor: number | null; maxRetries: number;
  mode: ControlProviderMode; externalWrites: false;
  conclusion: 'not_evaluated' | 'needs_input' | 'ready_for_human_review';
  nodes: Array<{ skill: SkillName; status: 'queued' | 'running' | 'completed' | 'failed'; attempts: number; result: RouterResult | null; error: string | null; attemptId?: string; provider?: string; model?: string; checks?: Record<string, unknown> }>;
  events: Array<{ at: string; type: string; node: number | null }>;
}
export interface ControlRunInput { plan: PlanName; prompt: string; storeId: string; requestKey: string; budgetMinor: number; maxRetries: number; deadlineSeconds: number; execution: 'manual' | 'background' }
export interface LiveControlClaim { runId: string; nodeIndex: number; attemptId: string; expectedVersion: number; actor: ActorContext; evidence: ControlEvidence; }
export interface LiveControlOutcome {
  ok: boolean;
  result?: RouterResult;
  errorCode?: string;
  message?: string;
  provider?: string;
  model?: string;
  checks?: Record<string, unknown>;
  elapsedMs?: number;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function parseInput(body: unknown): ControlRunInput {
  requireCondition(object(body), 'run_input_invalid', 400);
  requireCondition(body.execution === undefined || ['manual','background'].includes(String(body.execution)), 'execution_mode_invalid', 400);
  requireCondition(typeof body.plan === 'string' && Object.hasOwn(CONTROL_PLANS, body.plan), 'plan_not_allowlisted', 400);
  requireCondition(typeof body.prompt === 'string' && body.prompt.trim().length > 0 && body.prompt.length <= 4000, 'prompt_invalid', 400);
  requireCondition(typeof body.store_id === 'string' && body.store_id.length > 0 && body.store_id.length <= 160, 'store_id_required', 400);
  requireCondition(typeof body.request_key === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(body.request_key), 'request_key_invalid', 400);
  requireCondition(integer(body.budget_minor ?? 0, 0, 100000), 'budget_invalid', 400);
  requireCondition(integer(body.max_retries ?? 1, 0, 2), 'max_retries_exceeded', 400);
  requireCondition(integer(body.deadline_seconds ?? 180, 1, 180), 'deadline_exceeded', 400);
  return { execution: body.execution === 'background' ? 'background' : 'manual', plan: body.plan as PlanName, prompt: body.prompt.trim(), storeId: body.store_id, requestKey: body.request_key,
    budgetMinor: (body.budget_minor ?? 0) as number, maxRetries: (body.max_retries ?? 1) as number, deadlineSeconds: (body.deadline_seconds ?? 180) as number };
}
function allowed(actor: ActorContext, run: ControlRun): boolean {
  // Private work queues avoid sharing saved prompts implicitly across users.
  return run.tenantId === actor.tenantId && run.createdBy === actor.userId && actor.storeIds.includes(run.storeId);
}
function authorize(state: DatabaseState, actor: ActorContext, storeId: string): void {
  requireCondition(hasPermission(actor, 'report:read'), 'control_read_forbidden', 403);
  requireCondition(actor.storeIds.includes(storeId) && state.stores.some(s => s.id === storeId && s.tenantId === actor.tenantId && s.status === 'active'), 'not_found', 404);
}
export function checkRun(run: ControlRun): void {
  if (run.inputSnapshot) requireCondition(Array.isArray(run.inputSnapshot) && hash(run.inputSnapshot) === run.inputHash, 'input_snapshot_corrupt');
  requireCondition(run && run.schemaVersion === 1 && Object.hasOwn(CONTROL_PLANS, run.plan), 'stored_run_invalid');
  requireCondition(['queued', 'running', 'completed', 'failed', 'cancelled'].includes(run.status) && integer(run.version, 1, Number.MAX_SAFE_INTEGER), 'stored_run_invalid');
  requireCondition(integer(run.maxRetries, 0, 2) && integer(run.budgetMinor, 0, 100000) && (run.actualCostMinor === null || integer(run.actualCostMinor, 0, 100000)) && run.externalWrites === false && ['deterministic_offline', 'codebuddy_cli'].includes(run.mode), 'stored_run_invalid');
  if (run.mode === 'deterministic_offline') requireCondition(run.actualCostMinor === 0, 'stored_run_invalid');
  requireCondition(explicitTimestamp(run.asOf) && explicitTimestamp(run.deadlineAt) && explicitTimestamp(run.createdAt) && explicitTimestamp(run.updatedAt), 'stored_run_invalid');
  requireCondition(Array.isArray(run.nodes) && run.nodes.length === CONTROL_PLANS[run.plan].length && Array.isArray(run.events), 'stored_run_invalid');
  let incomplete = false;
  let failed = 0;
  for (const [index, node] of run.nodes.entries()) {
    requireCondition(node.skill === CONTROL_PLANS[run.plan][index] && ['queued', 'running', 'completed', 'failed'].includes(node.status) && integer(node.attempts, 0, run.maxRetries + 1), 'stored_run_invalid');
    if (node.status === 'completed') {
      requireCondition(!incomplete && node.attempts > 0 && node.result && node.result.skill === node.skill && ['completed', 'needs_input'].includes(node.result.status) && node.error === null, 'stored_run_invalid');
    } else if (node.status === 'running') {
      incomplete = true;
      requireCondition(node.result === null && node.attempts > 0 && typeof node.attemptId === 'string' && node.attemptId.length > 0, 'stored_run_invalid');
    } else {
      incomplete = true;
      requireCondition(node.result === null, 'stored_run_invalid');
      if (node.status === 'failed') { failed += 1; requireCondition(failed === 1 && node.attempts > 0 && typeof node.error === 'string', 'stored_run_invalid'); }
    }
  }
  requireCondition((run.status !== 'completed' || !incomplete) && (run.status === 'failed' ? failed === 1 : failed === 0 || run.status === 'cancelled'), 'stored_run_invalid');
}
function event(state: DatabaseState, actor: ActorContext, run: ControlRun, type: string, now: string, node: number | null): void {
  run.events.push({ at: now, type, node });
  run.updatedAt = now;
  state.auditEvents.push({ id: randomUUID(), tenantId: actor.tenantId, storeId: run.storeId, actorUserId: actor.userId,
    action: 'control_run.' + type, resourceType: 'control_run', resourceId: run.id, metadata: { version: run.version, node, external_writes: false }, createdAt: now });
}
export function listControlRuns(state: DatabaseState, actor: ActorContext): ControlRun[] {
  requireCondition(hasPermission(actor, 'report:read'), 'control_read_forbidden', 403);
  requireCondition(state.controlRuns === undefined || Array.isArray(state.controlRuns), 'stored_runs_invalid');
  return (state.controlRuns || []).filter(r => allowed(actor, r)).map(r => { checkRun(r); return structuredClone(r); }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

/** Call only inside repository.mutate: one atomic checkpoint per command.
 * This runner invokes synchronous, read-only offline handlers, never a model or
 * delivery adapter. Both HTTP step-debugging and the durable read-only worker use it.
 */
export function commandControlRun(state: DatabaseState, actor: ActorContext, command: 'create' | 'advance' | 'retry' | 'cancel', id: string | null, body: unknown, now: string, evaluate: (input: ControlEvidence) => RouterResult = evaluateControlInput, providerMode: ControlProviderMode = 'deterministic_offline'): ControlRun {
  requireCondition(explicitTimestamp(now), 'as_of_invalid', 400);
  requireCondition(state.controlRuns === undefined || Array.isArray(state.controlRuns), 'stored_runs_invalid');
  state.controlRuns ??= [];
  if (command === 'create') {
    const input = parseInput(body);
    authorize(state, actor, input.storeId);
    const requestHash = hash(input);
    const existing = state.controlRuns.find(r => r.tenantId === actor.tenantId && r.createdBy === actor.userId && r.requestKey === input.requestKey);
    if (existing) { checkRun(existing); requireCondition(existing.requestHash === requestHash, 'idempotency_key_conflict'); return structuredClone(existing); }
    requireCondition(state.controlRuns.filter(r => allowed(actor, r) && ['queued', 'running'].includes(r.status)).length < 10, 'active_run_limit');
    const run: ControlRun = { schemaVersion: 1, id: randomUUID(), tenantId: actor.tenantId, storeId: input.storeId, createdBy: actor.userId,
      requestKey: input.requestKey, requestHash, plan: input.plan, prompt: input.prompt, status: 'queued', version: 1,
      createdAt: now, updatedAt: now, asOf: now, deadlineAt: new Date(Date.parse(now) + input.deadlineSeconds * 1000).toISOString(),
      execution: input.execution, inputSnapshot: CONTROL_PLANS[input.plan].map(skill => prepareControlInput(state, actor, requestForSkill(skill, input.prompt, input.storeId, input.budgetMinor), now)),
      budgetMinor: input.budgetMinor, actualCostMinor: providerMode === 'deterministic_offline' ? 0 : null, maxRetries: input.maxRetries, mode: providerMode, externalWrites: false,
      conclusion: 'not_evaluated', nodes: CONTROL_PLANS[input.plan].map(skill => ({ skill, status: 'queued', attempts: 0, result: null, error: null })), events: [] };
    run.inputHash = hash(run.inputSnapshot);
    state.controlRuns.push(run); event(state, actor, run, 'created', now, null); return structuredClone(run);
  }
  const run = state.controlRuns.find(r => r.id === id && allowed(actor, r));
  requireCondition(run, 'not_found', 404); authorize(state, actor, run.storeId); checkRun(run);
  requireCondition(object(body) && integer(body.expected_version, 1, Number.MAX_SAFE_INTEGER), 'expected_version_required', 400);
  requireCondition(body.expected_version === run.version, 'run_version_conflict');
  requireCondition(!['completed', 'cancelled'].includes(run.status), 'run_terminal');
  if (command === 'cancel') { run.status = 'cancelled'; run.version++; event(state, actor, run, 'cancelled', now, null); return structuredClone(run); }
  if (command === 'retry') {
    requireCondition(run.status === 'failed', 'run_not_failed');
    const index = run.nodes.findIndex(n => n.status === 'failed'); const node = run.nodes[index];
    requireCondition(node && node.attempts <= run.maxRetries && ['analysis_failed', 'timeout', 'process_failed', 'external_blocked'].includes(node.error || ''), 'retry_not_allowed');
    requireCondition(Date.parse(now) < Date.parse(run.deadlineAt), 'deadline_exceeded');
    node.status = 'queued'; node.error = null; node.attemptId = undefined; run.status = 'queued'; run.version++;
    event(state, actor, run, 'retry_queued', now, index); return structuredClone(run);
  }
  requireCondition(run.mode === 'deterministic_offline', 'live_run_requires_worker', 409);
  requireCondition(command === 'advance' && ['queued', 'running'].includes(run.status), 'run_not_runnable');
  const index = run.nodes.findIndex(n => n.status !== 'completed'); const node = run.nodes[index];
  requireCondition(node && node.status === 'queued' && node.attempts <= run.maxRetries, 'run_not_runnable');
  node.attempts++; run.version++;
  try {
    requireCondition(Date.parse(now) < Date.parse(run.deadlineAt), 'deadline_exceeded');
    requireCondition(run.inputSnapshot?.[index], 'legacy_snapshot_missing');
    const frozen = structuredClone(run.inputSnapshot[index]);
    requireCondition(frozen.tenantId === actor.tenantId && frozen.ownerUserId === actor.userId && frozen.storeIds.every(id => actor.storeIds.includes(id)), 'snapshot_scope_denied');
    const result = evaluate(frozen);
    validateControlOutput(result, run.inputSnapshot[index]);
    requireCondition(result.status !== 'blocked', 'analysis_blocked');
    node.result = result; node.status = 'completed'; node.error = null;
    run.status = run.nodes.every(n => n.status === 'completed') ? 'completed' : 'running';
    if (run.status === 'completed') run.conclusion = run.nodes.some(n => n.result?.status === 'needs_input') ? 'needs_input' : 'ready_for_human_review';
    event(state, actor, run, 'node_completed', now, index);
  } catch (error) {
    node.result = null; node.status = 'failed'; node.error = error instanceof DomainError ? error.code : (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'analysis_failed'); run.status = 'failed';
    event(state, actor, run, 'node_failed', now, index);
  }
  checkRun(run); return structuredClone(run);
}

function requestForSkill(skill: SkillName, prompt: string, storeId: string, budgetMinor: number): RouterRequest {
  const queries = ['growth_analyst','crm_planner'].includes(skill) ? [{metricKey:'qualified_order_count'},{metricKey:'net_revenue_minor'},{metricKey:'identity_coverage'}] : [];
  return { skill, prompt, storeId, metricQueries: queries, allowedTools: [...new Set([SKILL_TOOL[skill], ...(queries.length ? ['metric_query'] : [])])], budgetMinor, maxSteps: 6, maxRetries: 0, deadlineSeconds: 180 };
}

/** Re-authorize from current memberships for each durable worker checkpoint.
 * Synchronous read-only nodes commit atomically under repository.mutate. A
 * process crash before commit is safe to replay; no external action occurs. */
export function advanceBackgroundRuns(state: DatabaseState, now: string, limit = 10): number {
  requireCondition(explicitTimestamp(now) && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'worker_input_invalid');
  let advanced = 0;
  const eligible = (state.controlRuns || []).filter(r=>r.execution==='background' && r.mode === 'deterministic_offline' && ['queued','running'].includes(r.status)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).slice(0,limit);
  for (const run of eligible) {
    const membership = state.memberships.find(m=>m.userId===run.createdBy && m.tenantId===run.tenantId && !m.revokedAt);
    const actor: ActorContext = {userId:run.createdBy, tenantId:run.tenantId, role:membership?.role || 'CASHIER', storeIds:membership?.storeIds || [], sessionId:'background-control'};
    const active = state.users.some(u=>u.id===actor.userId && u.status==='active') && state.tenants.some(t=>t.id===actor.tenantId && t.status==='active') && state.stores.some(s=>s.id===run.storeId && s.status==='active' && s.tenantId===run.tenantId);
    if (!membership || !active || !hasPermission(actor,'report:read') || !actor.storeIds.includes(run.storeId)) {
      run.status='cancelled'; run.version++;
      event(state,actor,run,'authorization_revoked',now,null); advanced++; continue;
    }
    commandControlRun(state, actor, 'advance', run.id, {expected_version:run.version}, now);
    advanced++;
  }
  return advanced;
}

/** Claim one CodeBuddy node under the file lock. The returned evidence is a
 * frozen copy; the provider is called only after this function returns. */
export function claimLiveBackgroundRun(state: DatabaseState, now: string, limit = 1): LiveControlClaim | null {
  requireCondition(explicitTimestamp(now) && Number.isSafeInteger(limit) && limit > 0 && limit <= 10, 'worker_input_invalid');
  const eligible = (state.controlRuns || []).filter(r => r.execution === 'background' && r.mode === 'codebuddy_cli' && ['queued', 'running'].includes(r.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const run of eligible.slice(0, limit)) {
    checkRun(run);
    const membership = state.memberships.find(m => m.userId === run.createdBy && m.tenantId === run.tenantId && !m.revokedAt);
    const actor: ActorContext = { userId: run.createdBy, tenantId: run.tenantId, role: membership?.role || 'CASHIER', storeIds: membership?.storeIds || [], sessionId: 'background-control' };
    if (Date.parse(now) >= Date.parse(run.deadlineAt)) {
      const expiredIndex = run.nodes.findIndex(node => ['queued', 'running'].includes(node.status));
      if (expiredIndex >= 0) {
        const expiredNode = run.nodes[expiredIndex];
        expiredNode.status = 'failed'; expiredNode.result = null; expiredNode.error = 'deadline_exceeded'; expiredNode.attempts = Math.max(expiredNode.attempts, 1); expiredNode.attemptId = undefined;
        run.status = 'failed'; run.version++;
        event(state, actor, run, 'deadline_exceeded', now, expiredIndex);
        checkRun(run);
      }
      continue;
    }
    const active = Boolean(membership) && state.users.some(u => u.id === actor.userId && u.status === 'active') && state.tenants.some(t => t.id === actor.tenantId && t.status === 'active') && state.stores.some(s => s.id === run.storeId && s.status === 'active' && s.tenantId === run.tenantId);
    if (!active || !hasPermission(actor, 'report:read') || !actor.storeIds.includes(run.storeId)) { run.status = 'cancelled'; run.version++; event(state, actor, run, 'authorization_revoked', now, null); continue; }
    const staleIndex = run.nodes.findIndex(node => node.status === 'running' && Date.parse(now) - Date.parse(run.updatedAt) >= 30_000);
    if (staleIndex >= 0) {
      const staleNode = run.nodes[staleIndex];
      staleNode.status = 'queued'; staleNode.attemptId = undefined; staleNode.error = null; run.version++;
      event(state, actor, run, 'provider_attempt_recovered', now, staleIndex);
    }
    const index = run.nodes.findIndex(node => node.status === 'queued');
    if (index < 0) continue;
    const node = run.nodes[index];
    if (node.attempts > run.maxRetries) {
      node.status = 'failed'; node.error = 'timeout'; node.attemptId = undefined; run.status = 'failed'; run.version++;
      event(state, actor, run, 'node_failed', now, index); checkRun(run); continue;
    }
    const request = run.inputSnapshot?.[index]?.request;
    const evidence = run.inputSnapshot?.[index];
    requireCondition(request && evidence, 'legacy_snapshot_missing');
    const attemptId = randomUUID();
    node.attempts += 1; node.status = 'running'; node.result = null; node.error = null; node.attemptId = attemptId; node.provider = 'codebuddy_cli';
    run.status = 'running'; run.version++;
    event(state, actor, run, 'node_claimed', now, index);
    checkRun(run);
    return { runId: run.id, nodeIndex: index, attemptId, expectedVersion: run.version, actor, evidence: structuredClone(evidence) };
  }
  return null;
}

/** Commit a provider result only when the same node lease is still current.
 * A late result after cancel/revoke is discarded and never becomes a success. */
export function commitLiveBackgroundRun(state: DatabaseState, claim: LiveControlClaim, outcome: LiveControlOutcome, now: string): ControlRun | null {
  requireCondition(explicitTimestamp(now), 'as_of_invalid', 400);
  const run = state.controlRuns?.find(item => item.id === claim.runId);
  if (!run || run.mode !== 'codebuddy_cli') return null;
  const node = run.nodes[claim.nodeIndex];
  if (!node || node.status !== 'running' || node.attemptId !== claim.attemptId || run.status === 'cancelled') {
    if (run.status === 'cancelled') event(state, claim.actor, run, 'provider_result_discarded', now, claim.nodeIndex);
    return structuredClone(run);
  }
  const membership = state.memberships.find(m => m.userId === run.createdBy && m.tenantId === run.tenantId && !m.revokedAt);
  const active = Boolean(membership) && state.users.some(u => u.id === run.createdBy && u.status === 'active') && state.tenants.some(t => t.id === run.tenantId && t.status === 'active') && state.stores.some(s => s.id === run.storeId && s.status === 'active' && s.tenantId === run.tenantId);
  if (!active || !membership?.storeIds.includes(run.storeId)) { node.status = 'failed'; node.error = 'authorization_revoked'; node.attemptId = undefined; run.status = 'cancelled'; run.version++; event(state, claim.actor, run, 'authorization_revoked', now, claim.nodeIndex); checkRun(run); return structuredClone(run); }
  if (Date.parse(now) >= Date.parse(run.deadlineAt)) {
    node.status = 'failed'; node.error = 'deadline_exceeded'; node.attemptId = undefined; run.status = 'failed'; run.version++;
    event(state, claim.actor, run, 'deadline_exceeded', now, claim.nodeIndex); checkRun(run); return structuredClone(run);
  }
  node.provider = outcome.provider || 'codebuddy_cli'; node.model = outcome.model; node.checks = outcome.checks;
  run.actualCostMinor = null;
  if (!outcome.ok || !outcome.result) {
    node.status = 'failed'; node.error = outcome.errorCode || 'external_blocked'; node.attemptId = undefined; run.status = 'failed'; run.version++; event(state, claim.actor, run, 'node_failed', now, claim.nodeIndex); checkRun(run); return structuredClone(run);
  }
  try {
    validateControlOutput(outcome.result, claim.evidence);
    requireCondition(outcome.result.status !== 'blocked', 'analysis_blocked');
    node.result = structuredClone(outcome.result); node.status = 'completed'; node.error = null; node.attemptId = undefined; run.version++;
    run.status = run.nodes.every(item => item.status === 'completed') ? 'completed' : 'running';
    if (run.status === 'completed') run.conclusion = run.nodes.some(item => item.result?.status === 'needs_input') ? 'needs_input' : 'ready_for_human_review';
    event(state, claim.actor, run, 'node_completed', now, claim.nodeIndex);
  } catch (error) {
    node.status = 'failed'; node.error = error instanceof DomainError ? error.code : (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'ai_output_invalid'); node.attemptId = undefined; run.status = 'failed'; run.version++; event(state, claim.actor, run, 'node_failed', now, claim.nodeIndex);
  }
  checkRun(run); return structuredClone(run);
}
