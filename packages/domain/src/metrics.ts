import { computeMetricBundle } from './metric-engine';
import type { AttributionEvidenceRecord, OrderRecord } from './imports';

interface FixtureScope { tenant_id?: string; store_id?: string }

export interface FixtureMember extends FixtureScope {
  id: string;
  registered_at: string;
}

export interface FixtureOrder extends FixtureScope {
  source?: string;
  currency?: string;
  external_order_id: string;
  member_id: string | null;
  paid_at: string;
  amount_paid_minor: number;
  status: OrderRecord['status'];
}

export interface FixtureAdjustment extends FixtureScope {
  source?: string;
  occurred_at?: string;
  external_adjustment_id: string;
  external_order_id: string;
  amount_minor: number;
}

export interface FixtureAttribution extends FixtureScope {
  order_source?: string;
  order_id: string;
  campaign_id: string;
  method: AttributionEvidenceRecord['method'];
  occurred_at: string;
}

export interface GoldenFixture extends FixtureScope {
  timezone?: string;
  currency?: string;
  as_of: string;
  orders_complete_through: string;
  members: FixtureMember[];
  orders: FixtureOrder[];
  adjustments: FixtureAdjustment[];
  attribution_evidence: FixtureAttribution[];
}

export interface GoldenMetrics {
  net_revenue_minor: number;
  qualified_order_count: number;
  average_order_value_minor: number | null;
  linked_order_count: number;
  identity_coverage: number | null;
  member_revenue_minor: number;
  member_revenue_share: number | null;
  mature_30d_cohort_count: number;
  repeat_30d_count: number;
  repeat_30d_rate: number | null;
  mature_7d_registration_cohort_count: number;
  converted_7d_count: number;
  conversion_7d_rate: number | null;
  primary_attributed_revenue_minor: Record<string, number>;
}

// The fixture adapter uses the application engine; it contains no second metric policy.
export function computeGoldenMetrics(fixture: GoldenFixture): GoldenMetrics {
  const scope = (row: FixtureScope) => ({ tenantId: row.tenant_id ?? fixture.tenant_id ?? 'fixture', storeId: row.store_id ?? fixture.store_id ?? 'fixture' });
  const bundle = computeMetricBundle({
    asOf: fixture.as_of, completeThrough: fixture.orders_complete_through, timezone: fixture.timezone ?? 'Asia/Dhaka',
    orders: fixture.orders.map((row, i) => ({ ...scope(row), id: `fixture-order-${i}`, source: row.source ?? 'fixture', externalOrderId: row.external_order_id, memberId: row.member_id, paidAt: row.paid_at, currency: row.currency ?? fixture.currency ?? 'BDT', amountPaidMinor: row.amount_paid_minor, status: row.status, revision: 1, active: true, sourceRowHash: String(i), correctionOfId: null, createdAt: fixture.as_of, updatedAt: fixture.as_of })),
    refunds: fixture.adjustments.map((row, i) => ({ ...scope(row), id: `fixture-refund-${i}`, source: row.source ?? 'fixture', externalAdjustmentId: row.external_adjustment_id, externalOrderId: row.external_order_id, amountMinor: row.amount_minor, occurredAt: row.occurred_at ?? fixture.as_of, sourceRowHash: String(i), createdAt: fixture.as_of })),
    members: fixture.members.map(row => ({ ...scope(row), id: row.id, externalMemberId: row.id, registeredAt: row.registered_at, displayName: null, language: null, contact: null, contactHmac: null, publicAccessTokenHash: null, contactVerified: false, verificationProof: null, verificationExpiresAt: null, isSynthetic: true, createdAt: fixture.as_of })),
    attribution: fixture.attribution_evidence.map((row, i) => ({ ...scope(row), id: `fixture-evidence-${i}`, orderExternalId: row.order_id, orderSource: row.order_source, campaignId: row.campaign_id, method: row.method, occurredAt: row.occurred_at }))
  });
  const summary = { ...bundle.summary };
  delete summary.attribution_model;
  return summary as unknown as GoldenMetrics;
}
