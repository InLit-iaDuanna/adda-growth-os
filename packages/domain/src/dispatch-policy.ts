export type DispatchDecisionStatus =
  | 'eligible'
  | 'skipped_duplicate'
  | 'skipped_holdout'
  | 'skipped_unverified'
  | 'skipped_suppressed'
  | 'skipped_frequency'
  | 'skipped_quiet_hours'
  | 'skipped_budget';

export interface DispatchPolicyInput {
  assignment: 'treatment' | 'holdout';
  hasContact: boolean;
  contactVerified: boolean;
  verificationExpiresAt: string | null | undefined;
  consentGranted: boolean;
  suppressed?: boolean;
  frequencyLimited: boolean;
  outsideQuietHours: boolean;
  budgetAvailable: boolean;
  now: string;
}

export interface DispatchPolicyDecision {
  status: DispatchDecisionStatus;
  reason: string | null;
}

export function evaluateDispatchPolicy(input: DispatchPolicyInput): DispatchPolicyDecision {
  if (input.assignment === 'holdout') return { status: 'skipped_holdout', reason: 'persistent_holdout' };
  const expires = input.verificationExpiresAt ? Date.parse(input.verificationExpiresAt) : NaN;
  if (!input.hasContact || !input.contactVerified || (Number.isFinite(expires) && expires <= Date.parse(input.now))) {
    return { status: 'skipped_unverified', reason: 'verified_contact_required' };
  }
  if (!input.consentGranted || input.suppressed === true) return { status: 'skipped_suppressed', reason: 'marketing_consent_missing_or_revoked' };
  if (input.frequencyLimited) return { status: 'skipped_frequency', reason: 'frequency_cap' };
  if (input.outsideQuietHours) return { status: 'skipped_quiet_hours', reason: 'outside_local_send_window' };
  if (!input.budgetAvailable) return { status: 'skipped_budget', reason: 'budget_exhausted' };
  return { status: 'eligible', reason: null };
}
