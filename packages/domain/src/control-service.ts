import { createHash } from 'node:crypto';
import type { ActorContext, DatabaseState } from './types';
import { ALLOWED_METRICS, type MetricEvidence, type MetricQueryRequest, type RouterRequest, type RouterResult } from './control';
import { METRIC_FORMULA_VERSION } from './metric-engine';
import { calculateMetrics } from './metric-service';
import { activeDuring, explicitTimestamp, requireCondition } from './validation';
import { validateRouterRequest, runDeterministicRouter } from './control-runtime';
import { assertControlTools } from './control-request';
import { hasPermission, hasBrandPermission } from './auth';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aliases: Record<string, string> = { orders_count: 'qualified_order_count', revenue_minor: 'net_revenue_minor', aov_minor: 'average_order_value_minor', repeat_purchase_rate: 'repeat_30d_rate', mature_30d_repeat_rate: 'repeat_30d_rate' };

export function queryMetrics(state: DatabaseState, actor: ActorContext, queries: MetricQueryRequest[], defaultAsOf: string): MetricEvidence[] {
  requireCondition(explicitTimestamp(defaultAsOf), 'as_of_invalid', 400);
  requireCondition(queries.length <= 5, 'metric_query_limit', 400);
  return queries.map(query => {
    requireCondition(query && ALLOWED_METRICS.has(query.metricKey), 'metric_not_allowlisted', 400);
    const asOf = query.asOf || defaultAsOf;
    const { storeIds, bundle, freshness, sourceCoverage, sourceRefs, recordRefs, completeThrough } = calculateMetrics(state, actor, query.storeId, asOf);
    const key = aliases[query.metricKey] || query.metricKey;
    const metric = bundle.results.find(m => m.metric_key === key);
    const quality = freshness.quality;
    const value = quality !== 'missing' && typeof metric?.value === 'number' ? metric.value : null;
    const evidence = { metricKey: key, value, numerator: quality === 'missing' ? null : metric?.numerator ?? null, denominator: quality === 'missing' ? null : metric?.denominator ?? null, asOf, completeThrough, quality, sourceCoverage, sourceRefs, storeIds, formulaVersion: METRIC_FORMULA_VERSION, missingReason: freshness.missingReason, recordRefs } as const;
    return { ...evidence, id: 'metric_' + digest(evidence).slice(0, 24) };
  });
}

export interface ControlEvidence {
  request: RouterRequest;
  asOf: string;
  ownerUserId: string;
  tenantId: string;
  storeIds: string[];
  metrics: MetricEvidence[];
  records: Array<{id: string; kind: string; summary: string}>;
  needsInput: string[];
}

/** Capture only authorized evidence, never an entire database or contact list. */
export function prepareControlInput(state: DatabaseState, actor: ActorContext, input: RouterRequest, asOf: string): ControlEvidence {
  const errors = validateRouterRequest(input);
  requireCondition(!errors.length, errors[0] || 'router_contract_invalid', 400);
  requireCondition(!input.storeId || actor.storeIds.includes(input.storeId), 'not_found', 404);
  assertControlTools(input);
  requireCondition(hasPermission(actor, 'report:read'), 'control_read_forbidden', 403);
  if (['brand_guardian','content_producer'].includes(input.skill)) requireCondition(hasBrandPermission(actor, 'brand:read'), 'brand_read_forbidden', 403);
  if (input.skill === 'crm_planner') requireCondition(hasPermission(actor, 'outreach:read'), 'outreach_read_forbidden', 403);
  const storeIds = input.storeId ? [input.storeId] : actor.storeIds;
  const scopedActor = { ...actor, storeIds };
  const metrics = queryMetrics(state, scopedActor, input.metricQueries || [], asOf);
  const visible = (item: {tenantId:string;storeId?:string|null}) => item.tenantId === actor.tenantId && (!item.storeId || storeIds.includes(item.storeId));
  const revisions = state.brandRevisions.filter(r => r.status === 'approved' && r.tenantId === actor.tenantId && activeDuring(asOf, r.effectiveFrom, r.effectiveTo) && state.brandDocuments.some(d => d.id === r.documentId && visible(d)));
  const records: Array<{id:string;kind:string;summary:string}> = [];
  const needs: string[] = ['campus_coordinator', 'event_planner'].includes(input.skill) ? ['weather_unavailable', 'campus_calendar_unavailable'] : [];
  if (/天气|weather/i.test(input.prompt) && !needs.includes('weather_unavailable')) needs.push('weather_unavailable');
  switch (input.skill) {
    case 'brand_guardian':
      for (const fact of state.brandFacts.filter(f => f.tenantId === actor.tenantId && f.status === 'approved' && revisions.some(r => r.id === f.revisionId))) records.push({id:fact.id,kind:'brand_fact',summary:fact.key + ': ' + fact.value});
      if (!records.length) needs.push('approved_brand_facts');
      break;
    case 'content_producer':
      for (const brief of state.contentBriefs.filter(visible)) {
        const rev = state.contentRevisions.filter(r => r.briefId === brief.id).sort((a,b)=>b.revision-a.revision)[0];
        if (rev) records.push({id:rev.id,kind:'content_revision',summary:rev.status + '; channel=' + brief.channel});
      }
      if (!records.length) needs.push('approved_brief_and_content_generation');
      else needs.push('local_review_and_publication_approval');
      break;
    case 'campus_coordinator':
      // Partner records are tenant-wide; a store-limited account cannot inspect them.
      if (!state.stores.filter(s=>s.tenantId===actor.tenantId).every(s=>storeIds.includes(s.id))) needs.push('tenant_wide_partner_permission');
      else for (const p of state.partners.filter(p=>p.tenantId===actor.tenantId && p.verifiedAt && ['verified','agreed','active'].includes(p.stage))) records.push({id:p.id,kind:'verified_partner',summary:p.name + '; source=' + p.sourceUrl});
      if (!records.length) needs.push('verified_partner_sources');
      break;
    case 'event_planner':
      for (const event of state.events.filter(visible)) records.push({id:event.id,kind:'event',summary:event.name + '; confirmed_time=' + (event.startsAt || 'missing') + '; capacity=' + event.capacity});
      if (!records.length) needs.push('event_date_capacity_and_permissions');
      break;
    case 'crm_planner':
      for (const c of state.outreachCampaigns.filter(visible)) records.push({id:c.id,kind:'outreach',summary:c.status + '; channel=' + c.channel});
      needs.push('send_time_consent_and_policy_check');
      break;
    case 'customer_voice':
      for (const c of state.supportCases.filter(visible).filter(c=>!['closed','resolved'].includes(c.status))) records.push({id:c.id,kind:'support_case',summary:c.escalationLevel + '; status=' + c.status + '; sla=' + c.slaDueAt});
      needs.push('human_case_review');
      break;
    case 'growth_analyst':
      if (!metrics.length) needs.push('metric_query_required');
      break;
  }
  return structuredClone({ request: input, asOf, ownerUserId: actor.userId, tenantId: actor.tenantId, storeIds, metrics, records: records.slice(0,100), needsInput: needs });
}

/** Pure evaluation over a frozen evidence set. No network or database tools. */
export function evaluateControlInput(evidence: ControlEvidence): RouterResult {
  const { request: input, metrics, records, asOf, ownerUserId, needsInput } = evidence;
  const result = runDeterministicRouter(input, metrics, ownerUserId, asOf);
  result.sourceRecords = structuredClone(records);
  result.needsInput = [...needsInput];
  for (const record of records.slice(0,10)) result.observations.push({text:record.summary,sourceRefs:[record.id]});
  result.status = needsInput.length || metrics.some(m => m.quality !== 'verified') ? 'needs_input' : 'completed';
  validateControlOutput(result, evidence);
  return result;
}

/** Fail closed before persisting any future provider/skill output. Numbers and
 * evidence cannot be replaced by model-generated values or arbitrary refs. */
export function validateControlOutput(output: RouterResult, evidence: ControlEvidence): void {
  requireCondition(output && output.skill === evidence.request.skill && ['completed','needs_input','blocked'].includes(output.status), 'skill_output_invalid');
  requireCondition(digest(output.metricEvidence) === digest(evidence.metrics), 'metric_evidence_mismatch');
  requireCondition(digest(output.sourceRecords) === digest(evidence.records), 'source_evidence_mismatch');
  requireCondition(Array.isArray(output.needsInput) && output.needsInput.every(v => typeof v === 'string') && output.needsInput.length <= 100, 'skill_output_invalid');
  const allowed = new Set([...evidence.metrics.map(m=>m.id), ...evidence.records.map(r=>r.id)]);
  for (const [items,key] of [[output.observations,'sourceRefs'],[output.hypotheses,'evidenceRefs'],[output.proposedActions,'evidenceRefs']] as const) {
    requireCondition(Array.isArray(items) && items.length <= 100, 'skill_output_invalid');
    for (const item of items) {
      requireCondition(item && typeof item === 'object', 'skill_output_invalid');
      const refs = (item as unknown as Record<string, unknown>)[key];
      requireCondition(Array.isArray(refs) && refs.every(ref => typeof ref === 'string' && allowed.has(ref)), 'source_reference_invalid');
      if ('text' in item) {
        const text = (item as unknown as { text?: unknown }).text;
        requireCondition(typeof text === 'string' && text.length <= 16000, 'skill_output_invalid');
      }
      if (key === 'sourceRefs') {
        const metricRefs = (refs as string[]).map((ref) => evidence.metrics.find((metric) => metric.id === ref)).filter(Boolean);
        // A model may describe a record in prose, but it may not invent a
        // number next to a legitimate metric reference. Metric observations
        // are rendered from the frozen snapshot by the program instead.
        if (metricRefs.length) {
          requireCondition(metricRefs.length === 1 && (refs as string[]).length === 1, 'metric_observation_shape_invalid');
          const metric = metricRefs[0]!;
          requireCondition((item as unknown as { text?: unknown }).text === `${metric.metricKey}=${metric.value}`, 'metric_observation_not_rendered');
        }
      }
    }
  }
  requireCondition(output.proposedActions.length <= 3, 'action_limit_exceeded');
  for (const action of output.proposedActions) requireCondition(action.ownerUserId === evidence.ownerUserId && action.budgetMinor === 0 && explicitTimestamp(action.dueAt) && typeof action.title === 'string' && Array.isArray(action.guardrails) && action.guardrails.every(v=>typeof v==='string'), 'action_output_invalid');
}

export function buildControlProviderPrompt(evidence: ControlEvidence): string {
  const request = { ...evidence.request, prompt: evidence.request.prompt.slice(0, 4000) };
  const locked = {
    skill: evidence.request.skill, as_of: evidence.asOf, owner_user_id: evidence.ownerUserId, tenant_scope: evidence.tenantId,
    store_ids: evidence.storeIds, budget_minor: 0, max_steps: evidence.request.maxSteps ?? 6, max_retries: evidence.request.maxRetries ?? 2,
    deadline_seconds: evidence.request.deadlineSeconds ?? 180, metric_evidence: evidence.metrics, source_records: evidence.records,
    required_needs_input: evidence.needsInput, allowed_reference_ids: [...evidence.metrics.map((metric) => metric.id), ...evidence.records.map((record) => record.id)]
  };
  return [
    '只输出 RouterResult JSON，不要 Markdown 或解释文字。',
    '输出必须是合法 JSON 对象；不要代码围栏、注释、NaN、尾逗号或对象外文字。不得输出 locked 或 allowed_reference_ids 顶层字段。',
    'locked 区块是服务端事实，只能用于生成引用；metricEvidence、sourceRecords、skill、limits 必须原样回传。',
    '观察、假设和 proposedActions 的 sourceRefs/evidenceRefs 只能引用 allowed_reference_ids；最多 3 个建议。每个建议必须完整包含 title、ownerUserId、dueAt、budgetMinor、guardrails、evidenceRefs 六个字段；ownerUserId 必须是 locked.owner_user_id，budgetMinor 必须为 0。',
    '如果 required_needs_input 非空，status 必须是 needs_input；不能执行发送、支付、导出、SQL、shell 或任何外部动作。',
    '<locked>', JSON.stringify(locked, null, 2), '</locked>',
    '<request_data>', JSON.stringify(request, null, 2), '</request_data>',
    '<json_skeleton>', JSON.stringify({ skill: evidence.request.skill, status: evidence.needsInput.length ? 'needs_input' : 'completed', observations: [], hypotheses: [], proposedActions: [], metricEvidence: evidence.metrics, sourceRecords: evidence.records, needsInput: evidence.needsInput, limits: { maxSteps: evidence.request.maxSteps ?? 6, maxRetries: evidence.request.maxRetries ?? 2, deadlineSeconds: evidence.request.deadlineSeconds ?? 180, budgetMinor: 0 } }, null, 2), '</json_skeleton>'
  ].join('\n');
}

export function normalizeControlProviderResult(value: unknown): RouterResult {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    skill: raw.skill,
    status: raw.status,
    observations: raw.observations,
    hypotheses: raw.hypotheses,
    proposedActions: raw.proposedActions,
    metricEvidence: raw.metricEvidence,
    sourceRecords: raw.sourceRecords,
    needsInput: raw.needsInput,
    limits: raw.limits
  } as unknown as RouterResult;
}

export function runControl(state: DatabaseState, actor: ActorContext, input: RouterRequest, asOf: string): RouterResult {
  return evaluateControlInput(prepareControlInput(state, actor, input, asOf));
}

export function controlDataHash(metrics: MetricEvidence[], sourceRefs: string[]): string { return digest({metrics,sourceRefs}); }
