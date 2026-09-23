import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';
import { computeMetricBundle } from '../packages/domain/src/metric-engine';

let app: RunningTestApp;
let owner: TestClient;
let ordersCsv = '';
let refundsCsv = '';
let membersCsv = '';
const fixture = JSON.parse(fs.readFileSync(path.resolve('fixtures/golden_dataset.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.resolve('fixtures/expected_metrics.json'), 'utf8'));

function localize(content: string): string {
  return content.replaceAll('DEMO_TENANT_ADDA', 'ten_demo_01').replaceAll('DEMO_STORE_001', 'sto_demo_01');
}

before(async () => {
  app = await startTestApp({ seedDemo: true });
  owner = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
  ordersCsv = localize(fs.readFileSync(path.resolve('fixtures/orders.csv'), 'utf8'));
  refundsCsv = localize(fs.readFileSync(path.resolve('fixtures/refunds.csv'), 'utf8'));
  membersCsv = localize(fs.readFileSync(path.resolve('fixtures/members.csv'), 'utf8'));
});

after(async () => { await app.close(); });

async function importAndCommit(kind: 'orders' | 'refunds' | 'members', content: string, completeThrough?: string) {
  const preview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, content, file_name: `${kind}.csv`, source: 'demo_pos', store_id: 'sto_demo_01', complete_through: completeThrough }) });
  assert.equal(preview.response.status, 201);
  const commit = await owner.request(`/api/imports/${preview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(commit.response.status, 200);
  return { preview, commit };
}

test('A15: importing the same CSV twice is idempotent', async () => {
  await importAndCommit('members', membersCsv);
  const first = await importAndCommit('orders', ordersCsv, fixture.orders_complete_through);
  assert.equal(first.preview.body.preview.valid_row_count, 12);
  const secondPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: ordersCsv, file_name: 'orders-repeat.csv', source: 'demo_pos', store_id: 'sto_demo_01', complete_through: fixture.orders_complete_through }) });
  assert.equal(secondPreview.body.import.id, first.preview.body.import.id);
  const state = app.repository.snapshot();
  assert.equal(state.orders.filter((row) => row.active).length, 11);
  assert.equal(state.orders.filter((row) => row.externalOrderId === 'O001' && row.active).length, 1);
});

test('A16: a changed order is a correction, not a second active sale', async () => {
  const correctionCsv = ordersCsv.replace(',O002,M001,2026-08-10T10:00:00+06:00,BDT,25000,paid', ',O002,M001,2026-08-10T10:00:00+06:00,BDT,26000,paid');
  const result = await importAndCommit('orders', correctionCsv, fixture.orders_complete_through);
  assert.equal(result.commit.body.reconciliation.corrections, 1);
  const rows = app.repository.snapshot().orders.filter((row) => row.externalOrderId === 'O002');
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.active).length, 1);
  assert.equal(rows.find((row) => row.active)?.amountPaidMinor, 26000);
  // Restore the fixture value so later golden assertions remain independent
  // while retaining the correction chain in the audit/history.
  await importAndCommit('orders', `${ordersCsv}\n`, fixture.orders_complete_through);
});

test('A17: malformed rows and over-refunds are isolated with stable row errors', async () => {
  const invalid = 'tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\nten_demo_01,sto_demo_01,demo_pos,BAD,,not-a-date,BDT,-5,paid';
  const preview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: invalid, source: 'demo_pos', store_id: 'sto_demo_01' }) });
  assert.equal(preview.body.preview.valid_row_count, 0);
  assert.ok(preview.body.preview.errors.some((item: any) => item.code === 'invalid_date'));
  assert.ok(preview.body.preview.errors.some((item: any) => item.code === 'invalid_amount'));
  const over = 'tenant_id,store_id,source,external_adjustment_id,external_order_id,occurred_at,amount_minor\nten_demo_01,sto_demo_01,demo_pos,R999,O001,2026-09-22T00:00:00+06:00,999999';
  const overPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'refunds', content: over, source: 'demo_pos', store_id: 'sto_demo_01' }) });
  const overCommit = await owner.request(`/api/imports/${overPreview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok(overCommit.body.reconciliation.rejected.some((item: any) => item.code === 'refund_exceeds_order'));
});

test('A18/A19/A21/A22/A23: code-calculated golden metrics match expected values', async () => {
  await importAndCommit('refunds', refundsCsv, fixture.orders_complete_through);
  for (const evidence of fixture.attribution_evidence) {
    const result = await owner.request('/api/attribution/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', order_external_id: evidence.order_id, campaign_id: evidence.campaign_id, method: evidence.method, occurred_at: evidence.occurred_at }) });
    assert.equal(result.response.status, 201);
  }
  const metrics = await owner.request(`/api/metrics?store_id=sto_demo_01&as_of=${encodeURIComponent(fixture.as_of)}`);
  assert.equal(metrics.response.status, 200);
  assert.equal(metrics.body.summary.net_revenue_minor, expected.net_revenue_minor);
  assert.equal(metrics.body.summary.qualified_order_count, expected.qualified_order_count);
  assert.equal(metrics.body.summary.average_order_value_minor, expected.average_order_value_minor);
  assert.equal(metrics.body.summary.identity_coverage, expected.identity_coverage);
  assert.equal(metrics.body.summary.member_revenue_minor, expected.member_revenue_minor);
  assert.equal(metrics.body.summary.mature_30d_cohort_count, expected.mature_30d_cohort_count);
  assert.equal(metrics.body.summary.repeat_30d_count, expected.repeat_30d_count);
  assert.equal(metrics.body.summary.mature_7d_registration_cohort_count, expected.mature_7d_registration_cohort_count);
  assert.equal(metrics.body.summary.converted_7d_count, expected.converted_7d_count);
  assert.deepEqual(metrics.body.summary.primary_attributed_revenue_minor, expected.primary_attributed_revenue_minor);
  assert.equal(metrics.body.summary.quality, 'verified');
});

test('A20: business-day comparisons use the store timezone, not server timezone', () => {
  const result = computeMetricBundle({
    orders: [
      { id: '1', tenantId: 't', storeId: 's', source: 'p', externalOrderId: 'a', memberId: 'm', paidAt: '2026-01-01T23:30:00Z', currency: 'BDT', amountPaidMinor: 100, status: 'paid', revision: 1, sourceRowHash: 'a', active: true, correctionOfId: null, createdAt: '', updatedAt: '' },
      { id: '2', tenantId: 't', storeId: 's', source: 'p', externalOrderId: 'b', memberId: 'm', paidAt: '2026-01-02T00:30:00Z', currency: 'BDT', amountPaidMinor: 100, status: 'paid', revision: 1, sourceRowHash: 'b', active: true, correctionOfId: null, createdAt: '', updatedAt: '' }
    ], refunds: [], members: [{ id: 'm', tenantId: 't', storeId: 's', externalMemberId: 'm', displayName: null, registeredAt: '2025-12-01T00:00:00Z', language: 'en', contact: null, contactHmac: null, publicAccessTokenHash: null, contactVerified: false, verificationProof: null, verificationExpiresAt: null, isSynthetic: true, createdAt: '' }], attribution: [], asOf: '2026-02-10T00:00:00Z', completeThrough: '2026-02-10T00:00:00Z', timezone: 'Asia/Dhaka'
  });
  assert.equal(result.summary.repeat_30d_count, 0); // both timestamps are the same Dhaka business date
});

test('A64: missing source watermark is explicitly provisional', async () => {
  const provisional = await startTestApp({ seedDemo: true });
  const client = new TestClient(provisional.baseUrl);
  await client.login('owner@demo.adda.local');
  const one = ordersCsv.split('\n').slice(0, 2).join('\n');
  const preview = await client.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: one, source: 'manual_partial', store_id: 'sto_demo_01' }) });
  await client.request(`/api/imports/${preview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const metrics = await client.request('/api/metrics?store_id=sto_demo_01');
  assert.equal(metrics.body.summary.quality, 'provisional');
  assert.equal(metrics.body.summary.missing_reason, 'source_watermark_not_confirmed');
  await provisional.close();
});
