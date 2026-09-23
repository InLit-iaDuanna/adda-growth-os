import type { DatabaseState } from './types';
import type { ControlTask, DailyReport } from './control';
import { canAccessStoreScope } from './auth';

function visibleRecord(state: DatabaseState, tenantId: string, storeIds: string[], id: string): boolean {
  const row = [...state.imports, ...state.orders, ...state.refunds, ...state.members].find(r => r.id === id);
  if (row) return row.tenantId === tenantId && storeIds.includes(row.storeId);
  return false;
}

function visibleRef(state: DatabaseState, tenantId: string, storeIds: string[], id: string): boolean {
  if (visibleRecord(state, tenantId, storeIds, id)) return true;
  const report = state.dailyReports.find(r => r.tenantId === tenantId && r.metrics.some(m => m.id === id));
  const metric = report?.metrics.find(m => m.id === id);
  return Boolean(metric && canAccessStoreScope(storeIds, metric.storeIds) && [...metric.sourceRefs, ...Object.values(metric.recordRefs).flat()].every(ref => visibleRecord(state, tenantId, storeIds, ref)));
}

export function canReadControlTask(state: DatabaseState, tenantId: string, storeIds: string[], task: ControlTask): boolean {
  return task.tenantId === tenantId && canAccessStoreScope(storeIds, task.storeIds) && task.evidenceRefs.every(id => visibleRef(state, tenantId, task.storeIds, id));
}

export function canReadDailyReport(state: DatabaseState, tenantId: string, storeIds: string[], report: DailyReport): boolean {
  if (report.tenantId !== tenantId || !canAccessStoreScope(storeIds, report.storeIds)) return false;
  if (report.storeId && !report.storeIds.includes(report.storeId)) return false;
  const refs = [...report.sourceRefs];
  for (const metric of report.metrics) {
    if (!canAccessStoreScope(report.storeIds, metric.storeIds)) return false;
    if (metric.sourceCoverage?.some(source => !metric.storeIds.includes(source.storeId))) return false;
    refs.push(...metric.sourceRefs, ...Object.values(metric.recordRefs).flat());
  }
  refs.push(...report.observations.flatMap(o => o.metricRefs), ...report.hypotheses.flatMap(h => h.evidenceRefs), ...report.advice.flatMap(a => a.evidenceRefs));
  return refs.every(id => visibleRef(state, tenantId, report.storeIds, id)) && report.taskIds.every(id => {
    const task = state.controlTasks.find(t => t.id === id);
    return Boolean(task && canReadControlTask(state, tenantId, report.storeIds, task));
  });
}
