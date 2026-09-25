import { type MetricEvidence, type RouterRequest, type RouterResult } from './control';
import { routerRequestErrors } from './control-request';
import { explicitTimestamp, requireCondition } from './validation';

const INJECTION = /(ignore\s+(all|previous)|system\s+prompt|export\s+(all|full)|手机号|token|验证码|send\s+externally|shell|sql)/i;

export function validateRouterRequest(input: unknown): string[] {
  return routerRequestErrors(input);
}

export function runDeterministicRouter(input: RouterRequest, metrics: MetricEvidence[], ownerUserId: string, asOf: string): RouterResult {
  const errors = validateRouterRequest(input);
  // Preserve the existing blocked result for an otherwise-valid injected prompt.
  requireCondition(!errors.length || (errors.length === 1 && errors[0] === 'untrusted_instruction_blocked'), errors[0] || 'router_contract_invalid', 400);
  requireCondition(explicitTimestamp(asOf), 'as_of_invalid', 400);
  const limits = { maxSteps: Math.min(input.maxSteps || 6, 6), maxRetries: Math.min(input.maxRetries ?? 2, 2), deadlineSeconds: Math.min(input.deadlineSeconds || 180, 180), budgetMinor: input.budgetMinor ?? 0 };
  const refs = metrics.map(metric => metric.id);
  if (INJECTION.test(input.prompt || '')) return { skill: input.skill, status: 'blocked', observations: [], hypotheses: [], proposedActions: [], metricEvidence: [], limits };
  const incomplete = !metrics.length || metrics.some((metric) => metric.quality !== 'verified');
  const observations = metrics.filter((metric) => metric.value !== null).map((metric) => ({ text: `${metric.metricKey}=${metric.value}`, sourceRefs: [metric.id] }));
  const hypotheses = incomplete ? [{ text: '数据截止或完整性尚未确认，以下仅为待验证假设。', evidenceRefs: refs }] : [{ text: '指标变化需要按来源和时间窗进一步验证，当前不推断因果。', evidenceRefs: refs }];
  const proposedActions = input.skill === 'growth_analyst' || input.skill === 'crm_planner' ? [{ title: '复核白名单指标并记录下一步实验', ownerUserId, dueAt: new Date(Date.parse(asOf) + 3 * 86_400_000).toISOString(), budgetMinor: 0, guardrails: ['先确认 complete_through', '不得导出联系人', '未经审批不发送'], evidenceRefs: refs }] : [];
  return { skill: input.skill, status: incomplete ? 'needs_input' : 'completed', observations, hypotheses, proposedActions, metricEvidence: metrics, limits };
}
