import type { AttributionEvidenceRecord, MemberRecord, OrderRecord, RefundRecord } from './imports';
import { assessMetricQuality } from './metric-quality';
import { currentOrders, orderKey } from './order-identity';
import { ATTRIBUTION_MODEL, resolveAttribution } from './attribution-policy';

export const METRIC_FORMULA_VERSION = 'metric-engine-v3-order-identity';

export interface MetricEngineInput {
  orders: OrderRecord[];
  orderCatalog?: OrderRecord[];
  refunds: RefundRecord[];
  members: MemberRecord[];
  attribution: AttributionEvidenceRecord[];
  asOf: string;
  completeThrough: string | null;
  timezone: string;
}

export interface MetricResult<T = number | Record<string, number> | null> {
  metric_key: string;
  formula_version: string;
  scope: { tenant_id?: string; store_id?: string };
  period: { as_of: string };
  value: T;
  numerator?: number | null;
  denominator?: number | null;
  as_of: string;
  complete_through: string | null;
  coverage: Record<string, number | string | null>;
  quality: 'complete' | 'provisional' | 'missing';
  source_refs: string[];
  missing_reason: string | null;
}

export interface MetricBundle {
  results: MetricResult[];
  summary: Record<string, unknown>;
}

function dateMs(value: string): number { return Date.parse(value); }
function localDate(value: string, timezone: string): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)); }
  catch { return value.slice(0, 10); }
}

export function computeMetricBundle(input: MetricEngineInput): MetricBundle {
  const asOfMs = dateMs(input.asOf);
  const completeMs = input.completeThrough ? dateMs(input.completeThrough) : Number.NaN;
  const cutoffMs = Number.isFinite(completeMs) ? Math.min(asOfMs, completeMs) : asOfMs;
  const refundByOrder = new Map<string, number>();
  const seenRefund = new Set<string>();
  for (const refund of input.refunds) {
    if (dateMs(refund.occurredAt) > cutoffMs) continue;
    const refundKey = JSON.stringify([refund.tenantId, refund.storeId, refund.source, refund.externalAdjustmentId]);
    if (seenRefund.has(refundKey)) continue;
    seenRefund.add(refundKey);
    const key = orderKey(refund);
    refundByOrder.set(key, (refundByOrder.get(key) || 0) + refund.amountMinor);
  }
  const qualified = currentOrders(input.orders).filter((order) => order.active && order.status === 'paid' && dateMs(order.paidAt) <= cutoffMs).map((order) => {
    const refund = refundByOrder.get(orderKey(order)) || 0;
    const net = Math.max(0, order.amountPaidMinor - Math.min(order.amountPaidMinor, refund));
    return { order, refund, net };
  }).filter((item) => item.net > 0);
  const netRevenue = qualified.reduce((sum, item) => sum + item.net, 0);
  // External member IDs are scoped to a tenant and store.
  const memberByInternalId = new Map<string, string>();
  const membersByExternalId = new Map<string, string[]>();
  for (const member of input.members) {
    const internalKey = `${member.tenantId}|${member.storeId}|${member.id}`;
    memberByInternalId.set(internalKey, member.id);
    const externalKey = `${member.tenantId}|${member.storeId}|${member.externalMemberId}`;
    const ids = membersByExternalId.get(externalKey) || [];
    ids.push(member.id);
    membersByExternalId.set(externalKey, ids);
  }
  const resolveCanonicalMemberId = (order: OrderRecord): string | null => {
    if (!order.memberId) return null;
    const byId = memberByInternalId.get(`${order.tenantId}|${order.storeId}|${order.memberId}`);
    if (byId) return byId;
    const byExternalId = membersByExternalId.get(`${order.tenantId}|${order.storeId}|${order.memberId}`) || [];
    // Ambiguous external IDs are left unlinked.
    return byExternalId.length === 1 ? byExternalId[0] : null;
  };
  const linked = qualified.flatMap((item) => {
    const memberId = resolveCanonicalMemberId(item.order);
    return memberId ? [{ ...item, memberId }] : [];
  });
  const memberRevenue = linked.reduce((sum, item) => sum + item.net, 0);
  const firstByMember = new Map<string, (typeof qualified)[number]>();
  const ordersByMember = new Map<string, Array<(typeof qualified)[number]>>();
  for (const item of linked.sort((a, b) => dateMs(a.order.paidAt) - dateMs(b.order.paidAt))) {
    const memberId = item.memberId;
    if (!firstByMember.has(memberId)) firstByMember.set(memberId, item);
    const items = ordersByMember.get(memberId) || [];
    items.push(item);
    ordersByMember.set(memberId, items);
  }
  const mature30 = Array.from(firstByMember.entries()).filter(([, item]) => dateMs(item.order.paidAt) + 30 * 86_400_000 <= cutoffMs);
  const repeat30 = mature30.filter(([memberId, first]) => (ordersByMember.get(memberId) || []).some((item) => orderKey(item.order) !== orderKey(first.order) && dateMs(item.order.paidAt) > dateMs(first.order.paidAt) && dateMs(item.order.paidAt) <= dateMs(first.order.paidAt) + 30 * 86_400_000 && localDate(item.order.paidAt, input.timezone) !== localDate(first.order.paidAt, input.timezone)));
  const mature7 = input.members.filter((member) => dateMs(member.registeredAt) + 7 * 86_400_000 <= cutoffMs && (!firstByMember.has(member.id) || dateMs(firstByMember.get(member.id)!.order.paidAt) >= dateMs(member.registeredAt)));
  const converted7 = mature7.filter((member) => {
    const first = firstByMember.get(member.id);
    return Boolean(first && dateMs(first.order.paidAt) <= dateMs(member.registeredAt) + 7 * 86_400_000);
  });
  const primary = resolveAttribution(input.orderCatalog ?? input.orders, input.attribution, input.asOf);
  const attributed: Record<string, number> = { unknown: 0 };
  for (const item of qualified) {
    const campaign = primary.get(orderKey(item.order))?.campaignId || 'unknown';
    attributed[campaign] = (attributed[campaign] || 0) + item.net;
  }
  const freshness = assessMetricQuality({ hasData: input.orders.length > 0, asOf: input.asOf, completeThrough: input.completeThrough });
  const quality: MetricResult['quality'] = freshness.quality === 'verified' ? 'complete' : freshness.quality;
  const coverage = { qualified_orders: qualified.length, linked_orders: linked.length, identity_coverage: qualified.length ? linked.length / qualified.length : null };
  const base = { formula_version: METRIC_FORMULA_VERSION, scope: {}, period: { as_of: input.asOf }, as_of: input.asOf, complete_through: input.completeThrough, coverage, quality, source_refs: ['orders', 'refunds', 'members'] as string[], missing_reason: freshness.missingReason };
  const result = (metric_key: string, value: MetricResult['value'], numerator?: number | null, denominator?: number | null): MetricResult => ({ ...base, metric_key, value, ...(numerator === undefined ? {} : { numerator }), ...(denominator === undefined ? {} : { denominator }) });
  const results: MetricResult[] = [
    result('net_revenue_minor', netRevenue),
    result('qualified_order_count', qualified.length),
    result('average_order_value_minor', qualified.length ? netRevenue / qualified.length : null, netRevenue, qualified.length),
    result('identity_coverage', qualified.length ? linked.length / qualified.length : null, linked.length, qualified.length),
    result('member_revenue_minor', memberRevenue),
    result('member_revenue_share', netRevenue ? memberRevenue / netRevenue : null, memberRevenue, netRevenue),
    result('mature_30d_cohort_count', mature30.length),
    result('repeat_30d_count', repeat30.length, repeat30.length, mature30.length),
    result('repeat_30d_rate', mature30.length ? repeat30.length / mature30.length : null, repeat30.length, mature30.length),
    result('mature_7d_registration_cohort_count', mature7.length),
    result('converted_7d_count', converted7.length, converted7.length, mature7.length),
    result('conversion_7d_rate', mature7.length ? converted7.length / mature7.length : null, converted7.length, mature7.length),
    result('primary_attributed_revenue_minor', attributed)
  ];
  return { results, summary: { attribution_model: ATTRIBUTION_MODEL, net_revenue_minor: netRevenue, qualified_order_count: qualified.length, average_order_value_minor: qualified.length ? netRevenue / qualified.length : null, linked_order_count: linked.length, identity_coverage: coverage.identity_coverage, member_revenue_minor: memberRevenue, member_revenue_share: netRevenue ? memberRevenue / netRevenue : null, mature_30d_cohort_count: mature30.length, repeat_30d_count: repeat30.length, repeat_30d_rate: mature30.length ? repeat30.length / mature30.length : null, mature_7d_registration_cohort_count: mature7.length, converted_7d_count: converted7.length, conversion_7d_rate: mature7.length ? converted7.length / mature7.length : null, primary_attributed_revenue_minor: attributed } };
}
