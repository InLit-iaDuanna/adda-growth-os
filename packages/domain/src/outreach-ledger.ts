import type { DatabaseState } from './types';
import type { MessageAttempt, OutreachCampaign, AudienceSnapshot } from './crm';
import type { DeliveryIntent } from './connectors';

export interface OutreachLedgerEntry {
  tenantId: string;
  storeId: string;
  outreachId: string | null;
  memberId: string;
  channel: OutreachCampaign['channel'];
  costMinor: number | null;
  createdAt: string;
  status: 'reserved' | 'unknown' | 'consumed';
  attempt?: MessageAttempt;
  intent?: DeliveryIntent;
}

/** Attempts and provider intents share accounting; linked attempts never charge twice. */
export function outreachLedger(state: DatabaseState): OutreachLedgerEntry[] {
  const entries: OutreachLedgerEntry[] = [];
  for (const attempt of state.messageAttempts) {
    if (attempt.deliveryIntentId || !['queued', 'sent_test'].includes(attempt.status)) continue;
    const campaign = state.outreachCampaigns.find(c => c.id === attempt.outreachId && c.tenantId === attempt.tenantId);
    if (campaign) entries.push({ tenantId: campaign.tenantId, storeId: campaign.storeId, outreachId: campaign.id, memberId: attempt.memberId, channel: campaign.channel, costMinor: attempt.costMinor ?? campaign.costPerAttemptMinor, createdAt: attempt.createdAt, status: attempt.status === 'queued' ? 'reserved' : 'consumed', attempt });
  }
  for (const intent of state.deliveryIntents) {
    if (intent.status === 'blocked' && !intent.providerReference) continue;
    const campaign = state.outreachCampaigns.find(c => c.tenantId === intent.tenantId && c.storeId === intent.storeId && (intent.outreachId ? c.id === intent.outreachId : c.approvalHash === intent.approvalHash));
    entries.push({ tenantId: intent.tenantId, storeId: intent.storeId, outreachId: campaign?.id || null, memberId: intent.memberId, channel: intent.provider, costMinor: intent.costMinor ?? campaign?.costPerAttemptMinor ?? null, createdAt: intent.createdAt, status: intent.status === 'delivered' ? 'consumed' : ['pending', 'accepted'].includes(intent.status) ? 'reserved' : 'unknown', intent });
  }
  return entries;
}

const belongs = (entry: OutreachLedgerEntry, campaign: OutreachCampaign) => entry.tenantId === campaign.tenantId && entry.storeId === campaign.storeId && entry.channel === campaign.channel && (entry.outreachId === campaign.id || entry.outreachId === null);

export function outreachBudget(state: DatabaseState, campaign: OutreachCampaign) {
  const entries = outreachLedger(state).filter(e => belongs(e, campaign));
  const unknownBindings = entries.filter(e => e.costMinor === null || !e.outreachId).length;
  const reservedMinor = entries.filter(e => e.status !== 'consumed').reduce((sum, e) => sum + (e.costMinor || 0), 0);
  const consumedMinor = entries.filter(e => e.status === 'consumed').reduce((sum, e) => sum + (e.costMinor || 0), 0);
  return { reservedMinor, consumedMinor, unknownBindings, availableMinor: unknownBindings ? 0 : Math.max(0, campaign.budgetMinor - reservedMinor - consumedMinor) };
}

export function outreachSpend(state: DatabaseState, campaign: OutreachCampaign): number {
  const budget = outreachBudget(state, campaign);
  return budget.unknownBindings ? Number.POSITIVE_INFINITY : budget.reservedMinor + budget.consumedMinor;
}

export function existingDelivery(state: DatabaseState, campaign: OutreachCampaign, memberId: string): OutreachLedgerEntry | undefined {
  return outreachLedger(state).find(e => belongs(e, campaign) && e.memberId === memberId);
}

export function hasRecentMessage(state: DatabaseState, campaign: OutreachCampaign, memberId: string, now: string): boolean {
  if (campaign.frequencyCapDays <= 0) return false;
  const threshold = Date.parse(now) - campaign.frequencyCapDays * 86400000;
  return outreachLedger(state).some(e => e.tenantId === campaign.tenantId && e.memberId === memberId && e.outreachId !== campaign.id && (e.status !== 'consumed' || Date.parse(e.createdAt) >= threshold));
}

export function refreshOutreachStatus(state: DatabaseState, campaign: OutreachCampaign, snapshot: AudienceSnapshot): void {
  if (!['approved', 'queued', 'completed', 'blocked'].includes(campaign.status)) return;
  const entries = outreachLedger(state).filter(e => belongs(e, campaign));
  const attempts = state.messageAttempts.filter(a => a.outreachId === campaign.id);
  const treatmentIds = snapshot.memberIds.filter(id => snapshot.assignments[id] !== 'holdout');
  if (entries.some(e => e.status === 'unknown')) campaign.status = 'blocked';
  else if (entries.some(e => e.status === 'reserved')) campaign.status = 'queued';
  else if (treatmentIds.length > 0 && treatmentIds.every(id => entries.some(e => e.memberId === id && e.status === 'consumed'))) campaign.status = 'completed';
  else if (attempts.length || state.deliveryIntents.some(i => i.outreachId === campaign.id)) campaign.status = 'blocked';
}

export function refreshDeliveryCampaign(state: DatabaseState, intent: DeliveryIntent): void {
  const campaign = state.outreachCampaigns.find(c => c.tenantId === intent.tenantId && c.storeId === intent.storeId && (intent.outreachId ? c.id === intent.outreachId : c.approvalHash === intent.approvalHash));
  const snapshot = campaign && state.audienceSnapshots.find(s => s.id === campaign.audienceSnapshotId && s.tenantId === campaign.tenantId);
  if (campaign && snapshot) refreshOutreachStatus(state, campaign, snapshot);
}
