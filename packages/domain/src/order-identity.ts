import type { OrderRecord } from './imports';

type OrderIdentity = Pick<OrderRecord, 'tenantId' | 'storeId' | 'source' | 'externalOrderId'>;
export interface OrderReference {
  tenantId: string;
  storeId: string;
  orderId?: string;
  orderExternalId?: string;
  orderSource?: string;
}

// JSON tuples keep separator characters in upstream IDs unambiguous.
export const orderKey = (order: OrderIdentity): string => JSON.stringify([order.tenantId, order.storeId, order.source, order.externalOrderId]);

export function currentOrders(orders: OrderRecord[]): OrderRecord[] {
  const current = new Map<string, OrderRecord>();
  for (const order of orders) {
    const key = orderKey(order);
    if (!current.has(key) || current.get(key)!.revision < order.revision) current.set(key, order);
  }
  return [...current.values()];
}

export function resolveOrder(orders: OrderRecord[], ref: OrderReference): { ok: true; order: OrderRecord } | { ok: false; errorCode: string } {
  const scoped = orders.filter(o => o.tenantId === ref.tenantId && o.storeId === ref.storeId);
  for (const value of [ref.orderId, ref.orderExternalId, ref.orderSource]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) return { ok: false, errorCode: 'order_reference_invalid' };
  }
  if (!ref.orderId && !ref.orderExternalId) return { ok: false, errorCode: 'order_reference_required' };
  const revision = ref.orderId ? scoped.find(o => o.id === ref.orderId) : undefined;
  if (ref.orderId && !revision) return { ok: false, errorCode: 'order_not_found' };
  if (revision && ((ref.orderSource !== undefined && ref.orderSource !== revision.source) || (ref.orderExternalId !== undefined && ref.orderExternalId !== revision.externalOrderId))) return { ok: false, errorCode: 'order_reference_mismatch' };
  const candidates = currentOrders(scoped).filter(o => revision ? orderKey(o) === orderKey(revision) : o.externalOrderId === ref.orderExternalId && (ref.orderSource === undefined || o.source === ref.orderSource));
  // Count all business identities, including cancelled orders, before checking usability.
  if (candidates.length > 1) return { ok: false, errorCode: 'order_reference_ambiguous' };
  const order = candidates[0];
  return order?.active ? { ok: true, order } : { ok: false, errorCode: 'order_not_found' };
}
