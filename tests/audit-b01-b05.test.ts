import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TestClient } from '../packages/testing/src/http';
import { computeMetricBundle } from '../packages/domain/src/metric-engine';
import { captureContentFacts, checkPublish, contentDigest } from '../packages/domain/src/content-policy';
import { orderKey, resolveOrder } from '../packages/domain/src/order-identity';
import { explicitTimestamp } from '../packages/domain/src/validation';

const tenantId = 'ten_demo_01';
const storeId = 'sto_demo_01';
const asOf = '2026-03-01T00:00:00Z';
const post = (client: TestClient, url: string, body = {}) => client.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function setup(t: TestContext) {
  const app = await startTestApp({ seedDemo: true });
  t.after(() => app.close());
  const owner = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
  return { app, owner };
}

async function importOrders(owner: TestClient, source: string, paidAt: string, amount = 1000) {
  const content = `tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\n${tenantId},${storeId},${source},ORDER-001,MEMBER-001,${paidAt},BDT,${amount},paid`;
  const preview = await post(owner, '/api/imports/preview', { kind: 'orders', content, source, store_id: storeId, complete_through: asOf });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.body));
  assert.equal(preview.body.preview.valid_row_count, 1);
  const committed = await post(owner, `/api/imports/${preview.body.import.id}/commit`);
  assert.equal(committed.response.status, 200);
  return committed;
}

const metrics = (owner: TestClient) => owner.request(`/api/metrics?store_id=${storeId}&as_of=${asOf}`);
const touch = (owner: TestClient, occurredAt: string, extra = {}) => post(owner, '/api/attribution/evidence', { store_id: storeId, order_external_id: 'ORDER-001', campaign_id: 'synthetic-campaign', method: 'linked_first_party_touch', occurred_at: occurredAt, ...extra });

async function createProduct(owner: TestClient) {
  const result = await post(owner, '/api/products', { store_id: storeId, external_sku: 'THIRD-AUDIT', names: { en: 'Milk Tea' } });
  assert.equal(result.response.status, 201);
  return result.body.item.id as string;
}

async function content(owner: TestClient, expiresAt: string | null = null) {
  const brand = await post(owner, '/api/brand/documents', { source_type: 'form', source_label: 'synthetic third audit', content: JSON.stringify({ brand_name: 'ADDA TEA' }) });
  assert.equal((await post(owner, `/api/brand/revisions/${brand.body.revision.id}/approve`)).response.status, 200);
  const productId = await createProduct(owner);
  const price = await post(owner, `/api/products/${productId}/prices`, { amount_minor: 15000, status: 'approved', valid_from: '2025-01-01T00:00:00Z', valid_to: null });
  assert.equal(price.response.status, 201);
  const asset = await post(owner, '/api/media-assets', { store_id: storeId, storage_key: 'synthetic/third-audit.jpg', checksum: 'third-audit', rights_status: 'approved', allowed_uses: ['organic_social'], expires_at: expiresAt });
  assert.equal(asset.response.status, 201);
  const campaign = await post(owner, '/api/campaigns', { name: 'Third audit', objective: 'orders', store_id: storeId, product_ids: [productId], asset_ids: [asset.body.item.id] });
  assert.equal(campaign.response.status, 201);
  const generated = await post(owner, '/api/content/generate', { campaign_id: campaign.body.item.id });
  assert.equal(generated.response.status, 201);
  const revisionId = generated.body.revision.id as string;
  assert.equal((await post(owner, `/api/content/${revisionId}/review-bn`)).response.status, 200);
  return { revisionId, productId, priceId: price.body.item.id as string, assetId: asset.body.item.id as string, brandId: brand.body.revision.id as string, campaignId: campaign.body.item.id as string };
}

test('B01: source-scoped order numbers count as distinct cross-day purchases', async t => {
  const { app, owner } = await setup(t);
  await app.repository.createMember({ tenantId, storeId, externalMemberId: 'MEMBER-001', displayName: null, registeredAt: '2025-12-01T00:00:00Z', language: 'en', contact: null, contactHmac: null, publicAccessTokenHash: null, isSynthetic: true });
  await importOrders(owner, 'pos', '2026-01-01T10:00:00Z');
  await importOrders(owner, 'delivery', '2026-01-02T10:00:00Z');
  const { body } = await metrics(owner);
  assert.equal(body.summary.qualified_order_count, 2);
  assert.equal(body.summary.mature_30d_cohort_count, 1);
  assert.equal(body.summary.repeat_30d_count, 1);
  assert.equal(body.summary.repeat_30d_rate, 1);
});

test('B02: a first-party touch 31 days before purchase stays unknown', async t => {
  const { owner } = await setup(t);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z');
  assert.equal((await touch(owner, '2026-01-01T10:00:00Z')).response.status, 201);
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 1000 });
});

test('B03: ambiguous external order references are rejected without attribution writes', async t => {
  const { app, owner } = await setup(t);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z', 1000);
  await importOrders(owner, 'delivery', '2026-02-01T11:00:00Z', 9000);
  const result = await touch(owner, '2026-01-31T10:00:00Z');
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error_code, 'order_reference_ambiguous');
  assert.equal(app.repository.snapshot().attributionEvidence.length, 0);
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 10000 });
});

test('B04: malformed price dates are rejected before creating a version', async t => {
  const { app, owner } = await setup(t);
  const productId = await createProduct(owner);
  const result = await post(owner, `/api/products/${productId}/prices`, { amount_minor: 15000, status: 'approved', valid_from: 'not-a-date', valid_to: 'not-a-date' });
  assert.equal(result.response.status, 400);
  assert.equal(app.repository.snapshot().priceVersions.length, 0);
  assert.equal(app.repository.findProduct(productId)!.currentPriceVersionId, null);
});

test('B05: malformed asset expiry is rejected before creating an asset', async t => {
  const { app, owner } = await setup(t);
  const result = await post(owner, '/api/media-assets', { store_id: storeId, storage_key: 'synthetic/bad.jpg', checksum: 'bad-expiry', rights_status: 'approved', allowed_uses: ['organic_social'], expires_at: 'not-a-date' });
  assert.equal(result.response.status, 400);
  assert.equal(app.repository.snapshot().mediaAssets.length, 0);
});

test('B02 control: a touch two days before purchase is attributed', async t => {
  const { owner } = await setup(t);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z');
  assert.equal((await touch(owner, '2026-01-30T10:00:00Z')).response.status, 201);
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 0, 'synthetic-campaign': 1000 });
});

test('B05 control: a valid but expired asset blocks submission and export', async t => {
  const { app, owner } = await setup(t);
  const { revisionId } = await content(owner, '2020-01-01T00:00:00Z');
  const submit = await post(owner, '/api/content/submit', { revision_id: revisionId });
  assert.equal(submit.response.status, 409);
  assert.equal(submit.body.error_code, 'asset_rights_expired');
  assert.equal((await post(owner, '/api/content/export', { revision_id: revisionId })).response.status, 404); // No approval exists after rejected submission.
  assert.equal(app.repository.snapshot().publicationIntents.length, 0);
});

test('B01/B03: bound identity survives another source, corrections and scoped refunds', async t => {
  const { app, owner } = await setup(t);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z');
  const evidence = await touch(owner, '2026-01-31T10:00:00Z');
  assert.equal(evidence.response.status, 201);
  assert.equal(evidence.body.item.orderSource, 'pos');
  assert.ok(evidence.body.item.orderId);
  await importOrders(owner, 'delivery', '2026-02-01T11:00:00Z', 9000);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z', 5000);
  const preview = await post(owner, '/api/imports/preview', { store_id: storeId, source: 'pos', kind: 'refunds', content: `tenant_id,store_id,source,external_adjustment_id,external_order_id,occurred_at,amount_minor\n${tenantId},${storeId},pos,REFUND-001,ORDER-001,2026-02-02T10:00:00Z,1000` });
  assert.equal(preview.response.status, 201);
  assert.equal((await post(owner, `/api/imports/${preview.body.import.id}/commit`)).response.status, 200);
  const { body } = await metrics(owner);
  assert.equal(body.summary.qualified_order_count, 2);
  assert.equal(body.summary.net_revenue_minor, 13000);
  assert.deepEqual(body.summary.primary_attributed_revenue_minor, { unknown: 9000, 'synthetic-campaign': 4000 });
  const resolved = resolveOrder(app.repository.snapshot().orders, evidence.body.item);
  assert.ok(resolved.ok);
  assert.equal(resolved.order.revision, 2);
  assert.notEqual(resolved.order.id, evidence.body.item.orderId);
});

test('B03: legacy ambiguous evidence stays unknown, including cancelled-source collisions', async t => {
  const { app, owner } = await setup(t);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z', 1000);
  await importOrders(owner, 'delivery', '2026-02-01T11:00:00Z', 9000);
  await app.repository.mutate(state => state.attributionEvidence.push({ id: 'legacy', tenantId, storeId, orderExternalId: 'ORDER-001', campaignId: 'legacy-campaign', method: 'linked_first_party_touch', occurredAt: '2026-01-31T10:00:00Z' }));
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 10000 });
  await app.repository.mutate(state => { state.orders.find(o => o.source === 'delivery')!.status = 'cancelled'; });
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 1000 });
  assert.equal((await touch(owner, '2026-01-31T10:00:00Z')).response.status, 409);
  await app.repository.mutate(state => { const order = state.orders.find(o => o.source === 'delivery')!; order.status = 'paid'; order.paidAt = '2026-04-01T00:00:00Z'; });
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 1000 });
});

test('B03: explicit source or internal ID resolves one order; mismatches never write evidence', async t => {
  const { app, owner } = await setup(t);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z');
  await importOrders(owner, 'delivery', '2026-02-01T11:00:00Z', 9000);
  const delivery = app.repository.snapshot().orders.find(o => o.source === 'delivery')!;
  for (const fields of [{ order_id: delivery.id, order_source: 'pos' }, { order_id: 'unknown' }, { order_source: '' }, { order_source: null }, { order_source: 2 }]) {
    assert.equal((await touch(owner, '2026-01-31T10:00:00Z', fields)).response.status, 409);
  }
  assert.equal(app.repository.snapshot().attributionEvidence.length, 0);
  const one = await touch(owner, '2026-01-31T10:00:00Z', { order_id: delivery.id, order_external_id: undefined });
  assert.equal(one.response.status, 201);
  assert.equal(one.body.item.orderSource, 'delivery');
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 1000, 'synthetic-campaign': 9000 });
  assert.equal((await touch(owner, '2026-01-31T10:00:00Z', { order_source: 'pos', campaign_id: 'pos-campaign' })).response.status, 201);
  assert.deepEqual((await metrics(owner)).body.summary.primary_attributed_revenue_minor, { unknown: 0, 'pos-campaign': 1000, 'synthetic-campaign': 9000 });
  assert.deepEqual(resolveOrder(app.repository.snapshot().orders, { tenantId: 'other-tenant', storeId, orderId: delivery.id }), { ok: false, errorCode: 'order_not_found' });
  assert.deepEqual(resolveOrder(app.repository.snapshot().orders, { tenantId, storeId: 'other-store', orderId: delivery.id }), { ok: false, errorCode: 'order_not_found' });
  assert.notEqual(orderKey({ ...delivery, source: 'a|b', externalOrderId: 'c' }), orderKey({ ...delivery, source: 'a', externalOrderId: 'b|c' }));
});

test('B02: seven-day boundaries, latest eligible touch and post-purchase evidence', async t => {
  const { app, owner } = await setup(t);
  const paidAt = '2026-02-01T10:00:00Z';
  await importOrders(owner, 'pos', paidAt);
  const state = app.repository.snapshot();
  const base = { id: 'touch', tenantId, storeId, orderExternalId: 'ORDER-001', orderSource: 'pos', campaignId: 'touch-campaign', method: 'linked_first_party_touch' as const, occurredAt: paidAt };
  const input = { orders: state.orders, refunds: state.refunds, members: state.members, asOf, completeThrough: asOf, timezone: 'Asia/Dhaka' };
  for (const age of [-1, 0, 1, 7 * 86400000, 7 * 86400000 + 1]) {
    const occurredAt = new Date(Date.parse(paidAt) - age).toISOString();
    const result = computeMetricBundle({ ...input, attribution: [{ ...base, occurredAt }] });
    assert.deepEqual(result.summary.primary_attributed_revenue_minor, age >= 0 && age <= 7 * 86400000 ? { unknown: 0, 'touch-campaign': 1000 } : { unknown: 1000 }, `age=${age}`);
  }
  const rows = [
    { ...base, id: 'old', campaignId: 'old', occurredAt: '2026-01-26T10:00:00Z' },
    { ...base, id: 'latest', campaignId: 'latest', occurredAt: '2026-01-31T10:00:00Z' },
    { ...base, id: 'after', campaignId: 'after', occurredAt: '2026-02-01T10:00:00.001Z' }
  ];
  assert.deepEqual(computeMetricBundle({ ...input, attribution: rows }).summary.primary_attributed_revenue_minor, { unknown: 0, latest: 1000 });
  assert.deepEqual((await metrics(owner)).body.summary.attribution_model, { version: 'primary_source_v2', touch_window_days: 7 });
});

test('B02: verified order evidence has priority and is bounded by report as-of, not touch age', async t => {
  const { app, owner } = await setup(t);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z');
  const state = app.repository.snapshot();
  const input = { orders: state.orders, refunds: [], members: [], asOf, completeThrough: asOf, timezone: 'Asia/Dhaka' };
  const base = { id: 'coupon', tenantId, storeId, orderExternalId: 'ORDER-001', orderSource: 'pos', campaignId: 'coupon', method: 'verified_coupon' as const, occurredAt: '2026-02-02T10:00:00Z' };
  const touchRow = { ...base, id: 'touch', campaignId: 'touch', method: 'linked_first_party_touch' as const, occurredAt: '2026-02-01T10:00:00Z' };
  for (const occurredAt of ['2026-01-01T10:00:00Z', '2026-02-02T10:00:00Z']) {
    assert.deepEqual(computeMetricBundle({ ...input, attribution: [touchRow, { ...base, occurredAt }] }).summary.primary_attributed_revenue_minor, { unknown: 0, coupon: 1000 });
  }
  for (const row of [{ ...base, occurredAt: '2026-03-02T10:00:00Z' }, { ...base, occurredAt: 'bad' }, { ...base, method: 'declared_source' as const }]) {
    assert.deepEqual(computeMetricBundle({ ...input, attribution: [touchRow, row] }).summary.primary_attributed_revenue_minor, { unknown: 0, touch: 1000 });
  }
});

test('B03: coupon matching rejects ambiguous orders and saves the exact source', async t => {
  const { app, owner } = await setup(t);
  const member = await app.repository.createMember({ tenantId, storeId, externalMemberId: 'MEMBER-001', displayName: null, registeredAt: '2025-12-01T00:00:00Z', language: 'en', contact: null, contactHmac: null, publicAccessTokenHash: null, isSynthetic: true });
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z');
  await importOrders(owner, 'delivery', '2026-02-01T11:00:00Z', 9000);
  const campaign = await post(owner, '/api/campaigns', { store_id: storeId, name: 'Coupon audit', objective: 'orders' });
  const offer = await app.repository.createOffer({ tenantId, storeId, campaignId: campaign.body.item.id, name: 'Synthetic', terms: 'Synthetic terms', validFrom: '2025-01-01T00:00:00Z', validTo: new Date(Date.now() + 86400000).toISOString(), maxRedemptions: null, createdBy: 'usr_demo_owner' });
  const coupon = await app.repository.issueCoupon({ tenantId, storeId, offerId: offer.id, memberId: member.id, sourceLinkId: null, tokenHash: 'synthetic-coupon' });
  await app.repository.reserveCoupon({ tokenHash: coupon.tokenHash, tenantId, storeId, employeeUserId: 'usr_demo_owner', posOrderRef: 'ORDER-001' });
  const url = `/api/redemptions/${coupon.id}/match-pos`;
  const fields = { store_id: storeId, pos_order_ref: 'ORDER-001' };
  const ambiguous = await post(owner, url, fields);
  assert.equal(ambiguous.response.status, 409);
  assert.equal(ambiguous.body.error_code, 'order_reference_ambiguous');
  assert.equal(app.repository.snapshot().attributionEvidence.length, 0);
  const matched = await post(owner, url, { ...fields, order_source: 'pos' });
  assert.equal(matched.response.status, 200);
  assert.equal(matched.body.coupon.order_source, 'pos');
  assert.equal((await post(owner, url, { ...fields, order_source: 'delivery' })).response.status, 409);
  assert.equal((await post(owner, url, { ...fields, order_source: 'pos' })).response.status, 200);
  assert.equal(app.repository.snapshot().attributionEvidence.length, 1);
  const result = await owner.request(`/api/metrics?store_id=${storeId}&as_of=${new Date().toISOString()}`);
  assert.deepEqual(result.body.summary.primary_attributed_revenue_minor, { unknown: 9000, [campaign.body.item.id]: 1000 });
});

test('B04/B05: date input types, calendar values and reversed intervals cannot change saved state', async t => {
  const { app, owner } = await setup(t);
  const productId = await createProduct(owner);
  const invalid = ['', 42, true, {}, '2026-02-01', '2026-02-01T12:00:00', '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z'];
  for (const value of invalid) {
    assert.equal((await post(owner, `/api/products/${productId}/prices`, { amount_minor: 15000, valid_from: value })).response.status, 400, JSON.stringify(value));
    assert.equal((await post(owner, `/api/products/${productId}/prices`, { amount_minor: 15000, valid_to: value })).response.status, 400);
    assert.equal((await post(owner, '/api/media-assets', { storage_key: 'synthetic/invalid', checksum: 'invalid', expires_at: value })).response.status, 400);
  }
  assert.equal((await post(owner, `/api/products/${productId}/prices`, { amount_minor: 15000, valid_from: null })).response.status, 400);
  for (const end of ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']) {
    assert.equal((await post(owner, `/api/products/${productId}/prices`, { amount_minor: 15000, valid_from: '2026-01-02T00:00:00Z', valid_to: end })).response.status, 400);
  }
  assert.equal(app.repository.snapshot().priceVersions.length, 0);
  assert.equal(app.repository.snapshot().mediaAssets.length, 0);
  assert.equal((await post(owner, '/api/products', { store_id: storeId, external_sku: 'REJECTED', price_minor: 1, valid_from: 'bad' })).response.status, 400);
  assert.equal(app.repository.snapshot().products.length, 1);
});

test('B04/B05: repository writes and idempotent asset lookup also validate dates', async t => {
  const { app, owner } = await setup(t);
  const values = await content(owner);
  const state = app.repository.snapshot();
  const price = state.priceVersions.find(p => p.id === values.priceId)!;
  const asset = state.mediaAssets.find(a => a.id === values.assetId)!;
  await assert.rejects(app.repository.addPriceVersion({ ...price, validFrom: 'bad' }), /invalid_price_validity/);
  await assert.rejects(app.repository.createMediaAsset({ ...asset, expiresAt: 'bad' }), /invalid_expires_at/);
  await assert.rejects(app.repository.updateCampaign(values.campaignId, { endAt: 'bad' }), /invalid_campaign_window/);
  assert.equal(app.repository.snapshot().priceVersions.length, 1);
  assert.equal(app.repository.snapshot().mediaAssets.length, 1);
});

test('B04/B05: brand, campaign and attribution routes reject malformed dates', async t => {
  const { app, owner } = await setup(t);
  assert.equal((await post(owner, '/api/brand/documents', { source_type: 'form', content: '{"brand_name":"Synthetic"}', effective_to: 'bad' })).response.status, 400);
  assert.equal((await post(owner, '/api/campaigns', { store_id: storeId, name: 'Invalid', start_at: 'bad' })).response.status, 400);
  const created = await post(owner, '/api/campaigns', { store_id: storeId, name: 'Valid' });
  const result = await owner.request(`/api/campaigns/${created.body.item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start_at: '2026-03-01T00:00:00Z', end_at: '2026-02-01T00:00:00Z' }) });
  assert.equal(result.response.status, 400);
  assert.equal(app.repository.findCampaign(created.body.item.id)!.revision, 1);
  await importOrders(owner, 'pos', '2026-02-01T10:00:00Z');
  assert.equal((await touch(owner, 'not-a-date')).response.status, 400);
  assert.equal(app.repository.snapshot().attributionEvidence.length, 0);
});

for (const kind of ['price', 'asset', 'brand'] as const) {
  test(`B04/B05: an otherwise valid legacy approval with invalid ${kind} dates cannot export`, async t => {
    const { app, owner } = await setup(t);
    const values = await content(owner);
    const submitted = await post(owner, '/api/content/submit', { revision_id: values.revisionId });
    assert.equal(submitted.response.status, 201);
    assert.equal((await post(owner, `/api/approvals/${submitted.body.approval.id}/approve`)).response.status, 200);
    await app.repository.mutate(state => {
      if (kind === 'price') state.priceVersions.find(p => p.id === values.priceId)!.validFrom = 'not-a-date';
      if (kind === 'asset') state.mediaAssets.find(a => a.id === values.assetId)!.expiresAt = 'not-a-date';
      if (kind === 'brand') state.brandRevisions.find(b => b.id === values.brandId)!.effectiveTo = 'not-a-date';
      // Reconstruct a historical approval that already bound these dirty facts.
      // The date rule must reject it even when all version/hash bindings match.
      const revision = state.contentRevisions.find(r => r.id === values.revisionId)!;
      const brief = state.contentBriefs.find(b => b.id === revision.briefId)!;
      revision.generationFacts = captureContentFacts(state, brief, revision.packageData);
      state.contentApprovals.find(a => a.id === submitted.body.approval.id)!.factsHash = contentDigest(revision.generationFacts);
    });
    const exported = await post(owner, '/api/content/export', { revision_id: values.revisionId });
    assert.equal(exported.response.status, 409);
    assert.equal(exported.body.error_code, { price: 'price_validity_invalid', asset: 'asset_expiry_invalid', brand: 'brand_revision_changed' }[kind]);
    assert.equal(app.repository.snapshot().publicationIntents.length, 0);
  });
}

test('B04/B05: null expiry permits manual export; starts and ends obey exact boundaries', async t => {
  const { app, owner } = await setup(t);
  const values = await content(owner);
  const submitted = await post(owner, '/api/content/submit', { revision_id: values.revisionId });
  assert.equal(submitted.response.status, 201);
  assert.equal((await post(owner, `/api/approvals/${submitted.body.approval.id}/approve`)).response.status, 200);
  const exported = await post(owner, '/api/content/export', { revision_id: values.revisionId });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.body.published, false);
  const state = app.repository.snapshot();
  const price = state.priceVersions.find(p => p.id === values.priceId)!;
  const asset = state.mediaAssets.find(a => a.id === values.assetId)!;
  const input = { tenantId, storeId, productIds: [values.productId], assetIds: [values.assetId] };
  price.validFrom = asOf;
  assert.equal(checkPublish(state, input, asOf).ok, true);
  price.validFrom = '2026-03-01T00:00:00.001Z';
  assert.equal(checkPublish(state, input, asOf).errors[0].code, 'price_outside_validity');
  price.validFrom = '2026-01-01T00:00:00Z';
  price.validTo = asOf;
  assert.equal(checkPublish(state, input, asOf).errors[0].code, 'price_outside_validity');
  price.validTo = null;
  asset.expiresAt = asOf;
  assert.equal(checkPublish(state, input, asOf).errors[0].code, 'asset_rights_expired');
  assert.equal(explicitTimestamp('2024-02-29T06:00:00+06:00'), true);
  assert.equal(explicitTimestamp('2025-02-29T06:00:00+06:00'), false);
});
