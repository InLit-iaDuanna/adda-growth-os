import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeMetricBundle } from '../packages/domain/src/metric-engine';
import { assessMetricQuality } from '../packages/domain/src/metric-quality';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';
import type { MemberRecord, OrderRecord } from '../packages/domain/src/imports';

function member(id: string, tenantId: string, storeId: string, externalMemberId: string): MemberRecord {
  return { id, tenantId, storeId, externalMemberId, displayName: null, registeredAt: '2025-01-01T00:00:00Z', language: 'en', contact: null, contactHmac: null, publicAccessTokenHash: null, isSynthetic: true, contactVerified: false, verificationProof: null, verificationExpiresAt: null, createdAt: '2025-01-01T00:00:00Z' };
}

function order(id: string, tenantId: string, storeId: string, externalOrderId: string, memberId: string): OrderRecord {
  return { id, tenantId, storeId, source: 'pos', externalOrderId, memberId, paidAt: '2025-02-01T10:00:00Z', currency: 'BDT', amountPaidMinor: 100, status: 'paid', revision: 1, sourceRowHash: id, active: true, correctionOfId: null, createdAt: '2025-02-01T10:00:00Z', updatedAt: '2025-02-01T10:00:00Z' };
}

test('R10: same external member id in different stores remains two canonical members', () => {
  const result = computeMetricBundle({
    members: [member('member-store-a', 'tenant-1', 'store-a', 'LOCAL-001'), member('member-store-b', 'tenant-1', 'store-b', 'LOCAL-001')],
    orders: [order('order-a', 'tenant-1', 'store-a', 'order-a', 'LOCAL-001'), order('order-b', 'tenant-1', 'store-b', 'order-b', 'LOCAL-001')],
    refunds: [],
    attribution: [],
    asOf: '2025-03-15T00:00:00Z',
    completeThrough: '2025-03-15T00:00:00Z',
    timezone: 'UTC'
  });

  assert.equal(result.summary.linked_order_count, 2);
  assert.equal(result.summary.mature_30d_cohort_count, 2);
  assert.equal(result.summary.repeat_30d_count, 0);
  assert.equal(result.summary.repeat_30d_rate, 0);
});

test('R10: an order carrying an internal member id resolves to that member only', () => {
  const result = computeMetricBundle({
    members: [member('member-a', 'tenant-1', 'store-a', 'LOCAL-001'), member('member-b', 'tenant-1', 'store-b', 'LOCAL-001')],
    orders: [order('order-a', 'tenant-1', 'store-a', 'order-a', 'member-a'), order('order-b', 'tenant-1', 'store-b', 'order-b', 'member-b')],
    refunds: [],
    attribution: [],
    asOf: '2025-03-15T00:00:00Z',
    completeThrough: '2025-03-15T00:00:00Z',
    timezone: 'UTC'
  });

  assert.equal(result.summary.mature_30d_cohort_count, 2);
  assert.equal(result.summary.repeat_30d_count, 0);
});

test('R10: ambiguous external ids are left unlinked instead of merged', () => {
  const result = computeMetricBundle({
    members: [member('member-source-a', 'tenant-1', 'store-a', 'LOCAL-001'), member('member-source-b', 'tenant-1', 'store-a', 'LOCAL-001')],
    orders: [order('order-a', 'tenant-1', 'store-a', 'order-a', 'LOCAL-001')],
    refunds: [],
    attribution: [],
    asOf: '2025-03-15T00:00:00Z',
    completeThrough: '2025-03-15T00:00:00Z',
    timezone: 'UTC'
  });

  assert.equal(result.summary.linked_order_count, 0);
  assert.equal(result.summary.identity_coverage, 0);
});

test('R11: a watermark older than as_of is provisional in the shared quality model', () => {
  assert.deepEqual(assessMetricQuality({ hasData: true, asOf: '2026-03-01T00:00:00Z', completeThrough: '2026-01-01T00:00:00Z' }), { quality: 'provisional', missingReason: 'source_watermark_not_confirmed' });
  assert.deepEqual(assessMetricQuality({ hasData: true, asOf: '2026-03-01T00:00:00Z', completeThrough: '2026-03-01T00:00:00Z' }), { quality: 'verified', missingReason: null });
});

let app: RunningTestApp;
let owner: TestClient;

before(async () => {
  app = await startTestApp({ seedDemo: true });
  owner = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
});

after(async () => { await app.close(); });

test('R11: /api/metrics does not label stale complete_through as verified', async () => {
  const fixtureOrders = fs.readFileSync(path.resolve('fixtures/orders.csv'), 'utf8').split('\n').slice(0, 2).join('\n').replaceAll('DEMO_TENANT_ADDA', 'ten_demo_01').replaceAll('DEMO_STORE_001', 'sto_demo_01').replace('2026-08-01T10:00:00+06:00', '2025-12-20T10:00:00+06:00');
  const fixtureMembers = fs.readFileSync(path.resolve('fixtures/members.csv'), 'utf8').split('\n').slice(0, 2).join('\n').replaceAll('DEMO_TENANT_ADDA', 'ten_demo_01').replaceAll('DEMO_STORE_001', 'sto_demo_01');
  const memberPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'members', content: fixtureMembers, file_name: 'members-r11.csv', source: 'r11_pos', store_id: 'sto_demo_01' }) });
  assert.equal(memberPreview.response.status, 201);
  assert.equal((await owner.request(`/api/imports/${memberPreview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).response.status, 200);
  const orderPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: fixtureOrders, file_name: 'orders-r11.csv', source: 'r11_pos', store_id: 'sto_demo_01', complete_through: '2026-01-01T00:00:00Z' }) });
  assert.equal(orderPreview.response.status, 201);
  assert.equal((await owner.request(`/api/imports/${orderPreview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).response.status, 200);
  const metrics = await owner.request('/api/metrics?store_id=sto_demo_01&as_of=2026-03-01T00:00:00.000Z');
  assert.equal(metrics.response.status, 200);
  assert.equal(metrics.body.summary.quality, 'provisional');
  assert.equal(metrics.body.summary.missing_reason, 'source_watermark_not_confirmed');
});
