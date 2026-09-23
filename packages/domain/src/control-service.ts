import { createHash } from 'node:crypto';
import type { ActorContext, DatabaseState } from './types';
import { ALLOWED_METRICS, type MetricEvidence, type MetricQueryRequest, type RouterRequest, type RouterResult } from './control';
import { METRIC_FORMULA_VERSION } from './metric-engine';
import { calculateMetrics } from './metric-service';
import { activeDuring, explicitTimestamp, requireCondition } from './validation';
import { validateRouterRequest, runDeterministicRouter } from './control-runtime';

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

export function runControl(state: DatabaseState, actor: ActorContext, input: RouterRequest, asOf: string): RouterResult {
  const errors = validateRouterRequest(input);
  requireCondition(!errors.length, errors[0] || 'router_contract_invalid', 400);
  requireCondition(!input.storeId || actor.storeIds.includes(input.storeId), 'not_found', 404);
  const storeIds = input.storeId ? [input.storeId] : actor.storeIds;
  const scopedActor = { ...actor, storeIds };
  const metrics = queryMetrics(state, scopedActor, input.metricQueries || [], asOf);
  const result = runDeterministicRouter(input, metrics, actor.userId, asOf);
  const visible = (item: {tenantId:string;storeId?:string|null}) => item.tenantId === actor.tenantId && (!item.storeId || storeIds.includes(item.storeId));
  const revisions = state.brandRevisions.filter(r => r.status === 'approved' && r.tenantId === actor.tenantId && activeDuring(asOf, r.effectiveFrom, r.effectiveTo) && state.brandDocuments.some(d => d.id === r.documentId && visible(d)));
  const records: Array<{id:string;kind:string;summary:string}> = [];
  const needs: string[] = ['weather_unavailable', 'campus_calendar_unavailable'];
  switch (input.skill) {
    case 'brand_guardian':
      for (const fact of state.brandFacts.filter(f => f.status === 'approved' && revisions.some(r => r.id === f.revisionId))) records.push({id:fact.id,kind:'brand_fact',summary:fact.key + ': ' + fact.value});
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
  result.sourceRecords = records.slice(0, 100);
  result.needsInput = needs;
  for (const record of records.slice(0, 10)) result.observations.push({text:record.summary,sourceRefs:[record.id]});
  // Weather and campus calendar are deliberately unavailable without
  // configured sources; never report a completed run while those inputs are
  // absent, even when other records are present.
  if (needs.length || metrics.some(m=>m.quality!=='verified')) result.status='needs_input';
  // Neither a source excerpt nor the prompt can select new tools or approve writes.
  return result;
}

export function controlDataHash(metrics: MetricEvidence[], sourceRefs: string[]): string { return digest({metrics,sourceRefs}); }
