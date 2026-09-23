import { createHash } from 'node:crypto';

export type FeedbackRisk = 'none' | 'urgent';
export type FeedbackStatus = 'open' | 'escalated' | 'in_progress' | 'resolved' | 'closed';

export interface FeedbackRecord {
  id: string;
  tenantId: string;
  storeId: string;
  source: string;
  sourceRef: string | null;
  externalId: string | null;
  originalText: string;
  evidenceExcerpt: string;
  receivedAt: string;
  customerRefHash: string | null;
  memberId: string | null;
  tags: string[];
  risk: FeedbackRisk;
  riskReasons: string[];
  status: FeedbackStatus;
  classificationVersion: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  originalTextRetentionUntil?: string | null;
}

export interface FeedbackClassification {
  id: string;
  tenantId: string;
  feedbackId: string;
  tags: string[];
  evidence: string[];
  method: 'rule' | 'human';
  actorUserId: string | null;
  createdAt: string;
}

export interface SupportCase {
  id: string;
  tenantId: string;
  storeId: string;
  feedbackId: string;
  ownerUserId: string | null;
  slaDueAt: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  escalationLevel: 'urgent' | 'normal';
  resolutionEvidence: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReplyRevision {
  id: string;
  tenantId: string;
  caseId: string;
  revision: number;
  channel: 'manual' | 'email' | 'sms' | 'whatsapp';
  body: string;
  bodyHash: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'manual_task' | 'sent';
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalHash: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface VoiceTask {
  id: string;
  tenantId: string;
  caseId: string;
  ownerUserId: string | null;
  kind: 'human_review' | 'manual_reply' | 'safety_escalation';
  status: 'open' | 'done' | 'cancelled';
  dueAt: string;
  evidence: string | null;
  createdAt: string;
  completedAt: string | null;
  replyRevisionId?: string;
}

export const URGENT_FEEDBACK_PATTERNS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: 'food_safety', pattern: /食物中毒|food\s*poison|allerg|过敏|异物|foreign\s*object|spoiled|腐败|生病|vomit|呕吐|খাদ্যে বিষক্রিয়া|অ্যালার্জি|বমি/i },
  { tag: 'personal_safety', pattern: /骚扰|harass|威胁|threat|暴力|assault|unsafe|不安全|危险|হয়রানি|হুমকি|নিরাপত্তা/i },
  { tag: 'severe_dispute', pattern: /诈骗|fraud|chargeback|争议|dispute|警察|police|lawsuit|诉讼/i }
];

export function redactFeedbackText(input: string): string {
  return input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted-phone]')
    .replace(/(?:Bearer\s+|token[=:]\s*)[A-Za-z0-9._~-]+/gi, '[redacted-token]')
    .slice(0, 1000);
}

export function classifyFeedback(text: string, suppliedTags: string[] = []): { tags: string[]; risk: FeedbackRisk; riskReasons: string[]; evidence: string[] } {
  const found = URGENT_FEEDBACK_PATTERNS.filter((item) => item.pattern.test(text) || suppliedTags.includes(item.tag));
  const tags = [...new Set([...suppliedTags.filter((tag) => /^[a-z0-9_\-]{1,48}$/i.test(tag)), ...found.map((item) => item.tag)])].slice(0, 12);
  const evidence = found.map((item) => {
    const match = text.match(item.pattern);
    return match ? redactFeedbackText(text.slice(Math.max(0, (match.index || 0) - 60), (match.index || 0) + match[0].length + 100)) : redactFeedbackText(text).slice(0, 160);
  });
  return { tags, risk: found.length ? 'urgent' : 'none', riskReasons: found.map((item) => item.tag), evidence };
}

export function hashFeedbackCustomer(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
