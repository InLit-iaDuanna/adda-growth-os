export const SKILL_NAMES = ['brand_guardian', 'content_producer', 'campus_coordinator', 'event_planner', 'crm_planner', 'customer_voice', 'growth_analyst'] as const;
export type SkillName = typeof SKILL_NAMES[number];

export interface MetricQueryRequest {
  metricKey: string;
  storeId?: string | null;
  asOf?: string;
}

export interface MetricEvidence {
  id: string;
  storeIds: string[];
  formulaVersion: string;
  missingReason: string | null;
  recordRefs: { orders: string[]; refunds: string[]; members: string[] };
  metricKey: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  asOf: string;
  completeThrough: string | null;
  quality: 'verified' | 'provisional' | 'missing';
  sourceRefs: string[];
  sourceCoverage?: import('./metric-service').OrderSourceCoverage[];
}

export interface ControlTask {
  id: string;
  tenantId: string;
  storeIds: string[];
  ownerUserId: string;
  title: string;
  dueAt: string;
  targetMetric: string;
  budgetMinor: number | null;
  guardrails: string[];
  evidenceRefs: string[];
  status: 'open' | 'in_progress' | 'done' | 'blocked';
  createdAt: string;
  completionEvidence?: string;
}

export interface DailyReport {
  id: string;
  tenantId: string;
  storeId: string | null;
  storeIds: string[];
  metrics: MetricEvidence[];
  dataHash: string;
  version: number;
  asOf: string;
  completeThrough: string | null;
  status: 'provisional' | 'verified' | 'missing';
  observations: Array<{ text: string; metricRefs: string[] }>;
  hypotheses: Array<{ text: string; evidenceRefs: string[] }>;
  advice: Array<{ text: string; guardrails: string[]; evidenceRefs: string[] }>;
  taskIds: string[];
  sourceRefs: string[];
  restatedFrom: string | null;
  createdBy: string;
  createdAt: string;
}

export interface RouterRequest {
  skill: SkillName;
  prompt: string;
  metricQueries?: MetricQueryRequest[];
  allowedTools?: string[];
  budgetMinor?: number;
  maxSteps?: number;
  maxRetries?: number;
  deadlineSeconds?: number;
  storeId?: string;
}

export interface RouterResult {
  skill: SkillName;
  status: 'completed' | 'needs_input' | 'blocked';
  observations: Array<{ text: string; sourceRefs: string[] }>;
  hypotheses: Array<{ text: string; evidenceRefs: string[] }>;
  proposedActions: Array<{ title: string; ownerUserId: string; dueAt: string; budgetMinor: number | null; guardrails: string[]; evidenceRefs: string[] }>;
  metricEvidence: MetricEvidence[];
  needsInput?: string[];
  sourceRecords?: Array<{ id: string; kind: string; summary: string }>;
  limits: { maxSteps: number; maxRetries: number; deadlineSeconds: number; budgetMinor: number };
}

export const ALLOWED_METRICS = new Set(['orders_count', 'qualified_order_count', 'revenue_minor', 'net_revenue_minor', 'aov_minor', 'average_order_value_minor', 'identity_coverage', 'repeat_purchase_rate', 'repeat_30d_rate', 'mature_30d_cohort_count', 'mature_30d_repeat_rate', 'conversion_7d_rate']);
