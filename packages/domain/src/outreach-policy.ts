import { createHash } from 'node:crypto';
import type { DatabaseState } from './types';
import type { AudienceSnapshot, OutreachCampaign } from './crm';
import type { ConsentEvent, SuppressionEntry } from './growth';
import { evaluateDispatchPolicy } from './dispatch-policy';
import { existingDelivery, hasRecentMessage } from './outreach-ledger';
import { explicitTimestamp, requireCondition } from './validation';

export function approvedOutreachContext(state: DatabaseState, campaign: OutreachCampaign, now: string) {
  const snapshot = state.audienceSnapshots.find(s => s.id === campaign.audienceSnapshotId && s.tenantId === campaign.tenantId);
  const segment = state.segmentDefinitions.find(s => s.id === campaign.segmentId && s.tenantId === campaign.tenantId);
  requireCondition(snapshot && segment && snapshot.segmentId === segment.id, 'audience_snapshot_not_found');
  requireCondition(!snapshot.storeId || snapshot.storeId === campaign.storeId, 'audience_store_mismatch');
  requireCondition(['approved', 'queued', 'completed', 'blocked'].includes(campaign.status), 'outreach_not_approved');
  requireCondition(campaign.templateApproved, 'template_not_approved');
  requireCondition(explicitTimestamp(campaign.expiresAt) && Date.parse(campaign.expiresAt) > Date.parse(now), 'outreach_approval_expired');
  requireCondition(campaign.approvalHash && campaign.approvalHash === outreachApprovalHash(campaign, snapshot, segment.version), 'stale_outreach_approval');
  return snapshot;
}

export function marketingConsentForChannel(state: DatabaseState, tenantId: string, memberId: string, channel: OutreachCampaign['channel']): boolean {
  const applies = (event: ConsentEvent | SuppressionEntry) =>
    event.tenantId === tenantId && event.memberId === memberId && event.purpose === 'marketing' &&
    (channel === 'manual' || event.channel === channel);
  const events = state.consentEvents.filter(applies).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const latest = events[0];
  if (!latest?.granted) return false;
  return !state.suppressionEntries.some((entry) => (applies(entry) || (entry.tenantId === tenantId && entry.memberId === memberId && entry.purpose === 'marketing' && entry.channel === 'unknown')) && Date.parse(entry.occurredAt) >= Date.parse(latest.occurredAt));
}

export function outsideOutreachWindow(state: DatabaseState, campaign: OutreachCampaign, now: string): boolean {
  const timezone = state.stores.find((store) => store.id === campaign.storeId)?.timezone || 'Asia/Dhaka';
  return isOutsideAllowedWindow(now, campaign.quietStartLocal, campaign.quietEndLocal, timezone);
}

export function evaluateMemberDispatch(
  state: DatabaseState,
  campaign: OutreachCampaign,
  input: { memberId: string; assignment: 'treatment' | 'holdout'; now: string; quiet: boolean; spent: number }
) {
  const existing = existingDelivery(state, campaign, input.memberId);
  if (existing) return { status: 'skipped_duplicate' as const, reason: existing.status === 'unknown' ? 'reconciliation_required' : 'delivery_already_reserved_or_sent' };
  if (state.externalWritesKillSwitch) return { status: 'external_blocked' as const, reason: 'global_kill_switch' };
  const { tenantId, storeId } = campaign;
  const member = state.members.find((item) => item.id === input.memberId && item.tenantId === tenantId && item.storeId === storeId);
  return evaluateDispatchPolicy({
    assignment: input.assignment,
    hasContact: Boolean(member?.contactHmac),
    contactVerified: Boolean(member?.contactVerified),
    verificationExpiresAt: member?.verificationExpiresAt,
    consentGranted: member ? marketingConsentForChannel(state, tenantId, member.id, campaign.channel) : false,
    frequencyLimited: member ? hasRecentMessage(state, campaign, member.id, input.now) : false,
    outsideQuietHours: input.quiet,
    budgetAvailable: input.spent + campaign.costPerAttemptMinor <= campaign.budgetMinor,
    now: input.now
  });
}

export function outreachApprovalHash(campaign: OutreachCampaign, snapshot: AudienceSnapshot, segmentVersion: number): string {
  const payload = {
    outreachId: campaign.id,
    tenantId: campaign.tenantId,
    storeId: campaign.storeId,
    segmentId: campaign.segmentId,
    segmentVersion,
    audienceSnapshotId: snapshot.id,
    audiencePolicyHash: snapshot.policyHash,
    memberIds: [...snapshot.memberIds].sort(),
    assignments: snapshot.memberIds.slice().sort().map(id => [id, snapshot.assignments[id]]),
    channel: campaign.channel,
    templateId: campaign.templateId,
    templateText: campaign.templateText,
    templateApproved: campaign.templateApproved,
    budgetMinor: campaign.budgetMinor,
    costPerAttemptMinor: campaign.costPerAttemptMinor,
    quietStartLocal: campaign.quietStartLocal,
    quietEndLocal: campaign.quietEndLocal,
    frequencyCapDays: campaign.frequencyCapDays,
    policyVersion: campaign.policyVersion,
    expiresAt: campaign.expiresAt || null
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function parseLocalMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return 0;
  return hours * 60 + minutes;
}

function localMinutes(iso: string, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
    return hour * 60 + minute;
  } catch {
    const date = new Date(iso);
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

/** Returns true when the current local time is outside the configured send window. */
function isOutsideAllowedWindow(iso: string, start: string, end: string, timezone: string): boolean {
  const startMinutes = parseLocalMinutes(start || '09:00');
  const endMinutes = parseLocalMinutes(end || '21:00');
  const current = localMinutes(iso, timezone);
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return current < startMinutes || current >= endMinutes;
  return current < startMinutes && current >= endMinutes;
}
