export type SegmentRule = 'registered_unpurchased' | 'first_purchase_no_second' | 'inactive_14d' | 'event_participant' | 'marketing_opt_in';

export interface SegmentDefinition {
  id: string;
  tenantId: string;
  name: string;
  rule: SegmentRule;
  version: number;
  createdBy: string;
  createdAt: string;
  /** Optional store scope. A null/omitted value means tenant-wide. */
  storeId?: string | null;
}

export interface AudienceSnapshot {
  id: string;
  tenantId: string;
  segmentId: string;
  seed: string;
  memberIds: string[];
  holdoutPercent: number;
  assignments: Record<string, 'treatment' | 'holdout'>;
  frozenAt: string;
  policyHash: string;
  /** The store scope used when the snapshot was frozen. */
  storeId?: string | null;
  /** Observation timestamp used to compute the rule. */
  asOf?: string;
}

export interface OutreachCampaign {
  id: string;
  tenantId: string;
  storeId: string;
  segmentId: string;
  audienceSnapshotId: string;
  channel: 'email' | 'sms' | 'whatsapp' | 'manual';
  templateId: string;
  templateText: string;
  templateApproved: boolean;
  budgetMinor: number;
  costPerAttemptMinor: number;
  quietStartLocal: string;
  quietEndLocal: string;
  frequencyCapDays: number;
  status: 'draft' | 'pending_approval' | 'approved' | 'queued' | 'completed' | 'blocked' | 'cancelled';
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  policyVersion?: string;
  approvalHash?: string | null;
  expiresAt?: string;
}

export interface MessageAttempt {
  id: string;
  tenantId: string;
  outreachId: string;
  memberId: string;
  assignment: 'treatment' | 'holdout';
  status: 'queued' | 'sent_test' | 'skipped_duplicate' | 'skipped_holdout' | 'skipped_suppressed' | 'skipped_unverified' | 'skipped_frequency' | 'skipped_quiet_hours' | 'skipped_budget' | 'external_blocked' | 'failed';
  reason: string | null;
  providerReference: string | null;
  dispatchKey?: string;
  approvalHash?: string;
  costMinor?: number;
  deliveryIntentId?: string;
  retryOfId?: string;
  createdAt: string;
}
