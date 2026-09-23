import type { AttributionEvidenceRecord, OrderRecord } from './imports';
import { orderKey, resolveOrder } from './order-identity';
import { explicitTimestamp } from './validation';

export const ATTRIBUTION_MODEL = Object.freeze({ version: 'primary_source_v2', touch_window_days: 7 });
const rank = { verified_coupon: 2, linked_first_party_touch: 1, declared_source: 0 };

export function resolveAttribution(orders: OrderRecord[], evidence: AttributionEvidenceRecord[], asOf: string): Map<string, AttributionEvidenceRecord> {
  const selected = new Map<string, AttributionEvidenceRecord>();
  for (const row of evidence) {
    if (!rank[row.method] || !explicitTimestamp(row.occurredAt) || Date.parse(row.occurredAt) > Date.parse(asOf)) continue;
    const resolved = resolveOrder(orders, row);
    if (!resolved.ok || !explicitTimestamp(resolved.order.paidAt)) continue;
    if (row.method === 'linked_first_party_touch') {
      const age = Date.parse(resolved.order.paidAt) - Date.parse(row.occurredAt);
      if (age < 0 || age > ATTRIBUTION_MODEL.touch_window_days * 86_400_000) continue;
    }
    // Coupon proof confirms an order; its verification may occur after payment.
    const key = orderKey(resolved.order);
    const previous = selected.get(key);
    if (!previous || rank[row.method] > rank[previous.method] || (rank[row.method] === rank[previous.method] && (Date.parse(row.occurredAt) > Date.parse(previous.occurredAt) || (Date.parse(row.occurredAt) === Date.parse(previous.occurredAt) && row.id < previous.id)))) selected.set(key, row);
  }
  return selected;
}
