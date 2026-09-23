import { ALLOWED_METRICS, SKILL_NAMES, type MetricEvidence, type RouterRequest, type RouterResult } from './control';

const INJECTION = /(ignore\s+(all|previous)|system\s+prompt|export\s+(all|full)|手机号|token|验证码|send\s+externally|shell|sql)/i;

export function validateRouterRequest(input: RouterRequest): string[] {
  const errors: string[] = [];
  if (!SKILL_NAMES.includes(input.skill)) errors.push('skill_not_allowlisted');
  if (typeof input.prompt !== 'string' || input.prompt.length > 4000) errors.push('prompt_invalid');
  if (INJECTION.test(input.prompt || '')) errors.push('untrusted_instruction_blocked');
  if (input.maxSteps !== undefined && (!Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 6)) errors.push('max_steps_exceeded');
  if (input.maxRetries !== undefined && (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 2)) errors.push('max_retries_exceeded');
  if (input.deadlineSeconds !== undefined && (!Number.isSafeInteger(input.deadlineSeconds) || input.deadlineSeconds < 1 || input.deadlineSeconds > 180)) errors.push('deadline_exceeded');
  if (input.budgetMinor !== undefined && (!Number.isSafeInteger(input.budgetMinor) || input.budgetMinor < 0)) errors.push('budget_invalid');
  if ((input.metricQueries || []).length + 1 > (input.maxSteps ?? 6)) errors.push('max_steps_exceeded');
  if (input.budgetMinor !== undefined && input.budgetMinor > 100000) errors.push('budget_limit_exceeded');
  for (const query of input.metricQueries || []) if (!query || typeof query !== 'object' || !ALLOWED_METRICS.has(query.metricKey)) errors.push('metric_not_allowlisted');
  for (const tool of input.allowedTools || []) if (!['metric_query', 'approved_knowledge', 'feedback_cases'].includes(tool)) errors.push(`tool_not_allowlisted:${tool}`);
  return errors;
}

export function runDeterministicRouter(input: RouterRequest, metrics: MetricEvidence[], ownerUserId: string, asOf: string): RouterResult {
  const limits = { maxSteps: Math.min(input.maxSteps || 6, 6), maxRetries: Math.min(input.maxRetries ?? 2, 2), deadlineSeconds: Math.min(input.deadlineSeconds || 180, 180), budgetMinor: input.budgetMinor ?? 0 };
  const refs = metrics.map(metric => metric.id);
  if (INJECTION.test(input.prompt || '')) return { skill: input.skill, status: 'blocked', observations: [], hypotheses: [], proposedActions: [], metricEvidence: [], limits };
  const incomplete = !metrics.length || metrics.some((metric) => metric.quality !== 'verified');
  const observations = metrics.filter((metric) => metric.value !== null).map((metric) => ({ text: `${metric.metricKey}=${metric.value}`, sourceRefs: [metric.id] }));
  const hypotheses = incomplete ? [{ text: '数据截止或完整性尚未确认，以下仅为待验证假设。', evidenceRefs: refs }] : [{ text: '指标变化需要按来源和时间窗进一步验证，当前不推断因果。', evidenceRefs: refs }];
  const proposedActions = input.skill === 'growth_analyst' || input.skill === 'crm_planner' ? [{ title: '复核白名单指标并记录下一步实验', ownerUserId, dueAt: new Date(Date.parse(asOf) + 3 * 86_400_000).toISOString(), budgetMinor: 0, guardrails: ['先确认 complete_through', '不得导出联系人', '未经审批不发送'], evidenceRefs: refs }] : [];
  return { skill: input.skill, status: incomplete ? 'needs_input' : 'completed', observations, hypotheses, proposedActions, metricEvidence: metrics, limits };
}
