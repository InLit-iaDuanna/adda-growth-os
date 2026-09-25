import { ALLOWED_METRICS, SKILL_NAMES, type RouterRequest, type SkillName } from './control';
import { explicitTimestamp, requireCondition } from './validation';

export const READ_TOOLS = ['metric_query', 'approved_knowledge', 'feedback_cases'] as const;
export const SKILL_TOOL: Record<SkillName, typeof READ_TOOLS[number]> = {
  brand_guardian: 'approved_knowledge', content_producer: 'approved_knowledge',
  campus_coordinator: 'approved_knowledge', event_planner: 'approved_knowledge',
  crm_planner: 'approved_knowledge', customer_voice: 'feedback_cases', growth_analyst: 'metric_query'
};
const INJECTION = /(ignore\s+(all|previous)|system\s+prompt|export\s+(all|full)|手机号|token|验证码|send\s+externally|shell|sql)/i;
const record = (input: unknown): input is Record<string, unknown> => Boolean(input && typeof input === 'object' && !Array.isArray(input));

/** Validate the runtime boundary, not merely a TypeScript assertion. */
export function routerRequestErrors(input: unknown): string[] {
  if (!record(input)) return ['router_contract_invalid'];
  const errors: string[] = [];
  if (!(SKILL_NAMES as readonly unknown[]).includes(input.skill)) errors.push('skill_not_allowlisted');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) errors.push('prompt_invalid');
  if (typeof input.prompt === 'string' && INJECTION.test(input.prompt)) errors.push('untrusted_instruction_blocked');
  for (const [key, min, max, code] of [
    ['maxSteps', 1, 6, 'max_steps_exceeded'], ['maxRetries', 0, 2, 'max_retries_exceeded'],
    ['deadlineSeconds', 1, 180, 'deadline_exceeded'], ['budgetMinor', 0, 100000, 'budget_invalid']
  ] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)) {
      errors.push(key === 'budgetMinor' && typeof value === 'number' && value > max ? 'budget_limit_exceeded' : code);
    }
  }
  if (input.storeId !== undefined && (typeof input.storeId !== 'string' || !input.storeId.trim() || input.storeId.length > 160)) errors.push('store_id_invalid');
  const queries = input.metricQueries === undefined ? [] : input.metricQueries;
  if (!Array.isArray(queries)) errors.push('metric_queries_invalid');
  else {
    if (queries.length > 5 || queries.length + 1 > (typeof input.maxSteps === 'number' ? input.maxSteps : 6)) errors.push('max_steps_exceeded');
    for (const q of queries) {
      if (!record(q) || typeof q.metricKey !== 'string' || !ALLOWED_METRICS.has(q.metricKey)) { errors.push('metric_not_allowlisted'); continue; }
      if (q.storeId !== undefined && q.storeId !== null && (typeof q.storeId !== 'string' || !q.storeId.trim() || q.storeId.length > 160)) errors.push('store_id_invalid');
      if (q.asOf !== undefined && !explicitTimestamp(q.asOf)) errors.push('as_of_invalid');
      if (input.storeId && q.storeId && q.storeId !== input.storeId) errors.push('metric_scope_mismatch');
    }
  }
  const tools = input.allowedTools === undefined ? [] : input.allowedTools;
  if (!Array.isArray(tools) || tools.length > READ_TOOLS.length || tools.some(t => typeof t !== 'string' || !(READ_TOOLS as readonly string[]).includes(t))) errors.push('tool_not_allowlisted');
  return [...new Set(errors)];
}

/** HTTP snake_case is mapped once; invalid supplied arrays are not erased. */
export function parseControlRequest(body: unknown): RouterRequest {
  requireCondition(record(body), 'router_contract_invalid', 400);
  const input = {
    skill: body.skill, prompt: body.prompt, storeId: body.store_id,
    metricQueries: body.metric_queries, allowedTools: body.allowed_tools,
    budgetMinor: body.budget_minor, maxSteps: body.max_steps, maxRetries: body.max_retries,
    deadlineSeconds: body.deadline_seconds
  };
  const errors = routerRequestErrors(input);
  requireCondition(!errors.length, errors[0] || 'router_contract_invalid', 400);
  return input as RouterRequest;
}

/** A permitted tool name is not permission to use every other read capability. */
export function assertControlTools(input: RouterRequest): void {
  const granted = new Set(input.allowedTools || []);
  requireCondition(granted.has(SKILL_TOOL[input.skill]), 'required_tool_not_granted', 403);
  if (input.metricQueries?.length) requireCondition(granted.has('metric_query'), 'required_tool_not_granted', 403);
}
