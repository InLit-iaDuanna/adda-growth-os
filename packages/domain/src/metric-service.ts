import type { ActorContext, DatabaseState } from './types';
import { computeMetricBundle } from './metric-engine';
import { assessMetricQuality } from './metric-quality';
import { explicitTimestamp, requireCondition } from './validation';

export interface OrderSourceCoverage {
  storeId: string;
  source: string | null;
  completeThrough: string | null;
  status: 'not_imported' | 'unconfirmed' | 'stale' | 'confirmed_zero' | 'complete';
}

function orderCoverage(state: DatabaseState, tenantId: string, storeIds: string[], asOf: string): OrderSourceCoverage[] {
  return storeIds.flatMap<OrderSourceCoverage>(storeId => {
    const orders = state.orders.filter(o => o.tenantId === tenantId && o.storeId === storeId);
    const batches = state.imports.filter(b => b.tenantId === tenantId && b.storeId === storeId && b.kind === 'orders');
    const configured = state.stores.find(s => s.id === storeId && s.tenantId === tenantId)?.orderSources || [];
    const sources = [...new Set([...configured, ...orders.map(o => o.source), ...batches.map(b => b.source)])].sort();
    if (!sources.length) return [{ storeId, source: null, completeThrough: null, status: 'not_imported' }];
    return sources.map(source => {
      const committed = batches.filter(b => b.source === source && b.status === 'committed');
      const confirmed = committed.filter(b => b.errorCount === 0 && explicitTimestamp(b.completeThrough));
      const latest = confirmed.map(b => Date.parse(b.completeThrough!)).sort((a, b) => b - a)[0];
      const completeThrough = latest === undefined ? null : new Date(latest).toISOString();
      const observed = orders.some(o => o.source === source && Date.parse(o.paidAt) <= Date.parse(asOf));
      const status = !committed.length && !observed ? 'not_imported' : !completeThrough ? 'unconfirmed' : latest < Date.parse(asOf) ? 'stale' : observed ? 'complete' : 'confirmed_zero';
      return { storeId, source, completeThrough, status };
    });
  });
}

/** One scoped calculation for HTTP metrics, control queries and stored daily reports. */
export function calculateMetrics(state: DatabaseState, actor: ActorContext, storeId: string | null | undefined, asOf: string) {
  requireCondition(explicitTimestamp(asOf), 'as_of_invalid', 400);
  requireCondition(!storeId || actor.storeIds.includes(storeId), 'not_found', 404);
  const storeIds = [...new Set(storeId ? [storeId] : actor.storeIds)].sort();
  const stores = state.stores.filter(s => s.tenantId === actor.tenantId && s.status === 'active' && storeIds.includes(s.id));
  requireCondition(stores.length === storeIds.length, 'not_found', 404);
  requireCondition(new Set(stores.map(s => s.currency + ':' + s.timezone)).size <= 1, 'mixed_store_currency_or_timezone_requires_single_store', 400);
  const visible = (row: { tenantId: string; storeId: string }) => row.tenantId === actor.tenantId && storeIds.includes(row.storeId);
  const orderCatalog = state.orders.filter(visible);
  const orders = orderCatalog.filter(o => Date.parse(o.paidAt) <= Date.parse(asOf));
  requireCondition(orders.every(o => o.currency === stores.find(s => s.id === o.storeId)?.currency), 'order_currency_mismatch', 400);
  const refunds = state.refunds.filter(r => visible(r) && Date.parse(r.occurredAt) <= Date.parse(asOf));
  const members = state.members.filter(m => visible(m) && Date.parse(m.registeredAt) <= Date.parse(asOf));
  const imports = state.imports.filter(b => visible(b) && b.status === 'committed');
  const sourceCoverage = orderCoverage(state, actor.tenantId, storeIds, asOf);
  const completeThrough = sourceCoverage.length && sourceCoverage.every(s => s.completeThrough) ? sourceCoverage.map(s => s.completeThrough!).sort()[0] : null;
  const freshness = assessMetricQuality({ hasData: orders.length > 0, hasImport: imports.some(b => b.kind === 'orders'), asOf, completeThrough });
  if (freshness.quality === 'provisional' && sourceCoverage.some(s => s.status === 'not_imported')) freshness.missingReason = 'store_sources_incomplete';
  const bundle = computeMetricBundle({ orders, orderCatalog, refunds, members, attribution: state.attributionEvidence.filter(visible), asOf, completeThrough, timezone: stores[0]?.timezone || 'Asia/Dhaka' });
  return { storeIds, orders, imports, completeThrough, freshness, sourceCoverage, bundle, sourceRefs: imports.map(b => b.id), recordRefs: { orders: orders.map(o => o.id), refunds: refunds.map(r => r.id), members: members.map(m => m.id) } };
}
