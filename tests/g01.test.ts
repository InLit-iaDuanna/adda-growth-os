import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';

let app: RunningTestApp;
let owner: TestClient;
let revisionId = '';
let productId = '';
let priceVersionId = '';
let assetId = '';

const brandInput = {
  schema_version: '1.0',
  brand_name: 'ADDA TEA',
  slogan: 'More than tea. It’s our Adda.',
  store: { launch_date: null, display_name: null },
  products: [],
  needs_input: ['official assets', 'menu prices', 'launch date']
};

before(async () => {
  app = await startTestApp({ seedDemo: true });
  owner = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
});

after(async () => { await app.close(); });

test('A06: empty Brand Brain exposes needs_input and does not invent prices or launch date', async () => {
  const result = await owner.request('/api/brand/overview');
  assert.equal(result.response.status, 200);
  assert.ok(result.body.needs_input.includes('launch_date'));
  assert.ok(result.body.needs_input.includes('menu_prices'));
  assert.deepEqual(result.body.products, []);
  assert.deepEqual(result.body.facts, []);
});

test('A07: only an approved, current revision is returned by default', async () => {
  const created = await owner.request('/api/brand/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_type: 'form', source_label: 'client brief (synthetic)', content: JSON.stringify(brandInput) })
  });
  assert.equal(created.response.status, 201);
  revisionId = created.body.revision.id;
  const beforeApproval = await owner.request('/api/brand/facts');
  assert.equal(beforeApproval.body.items.length, 0);
  const approved = await owner.request(`/api/brand/revisions/${revisionId}/approve`, { method: 'POST' });
  assert.equal(approved.response.status, 200);
  const afterApproval = await owner.request('/api/brand/facts');
  assert.ok(afterApproval.body.items.some((item: any) => item.key === 'brand_name' && item.value === 'ADDA TEA'));

  const conflict = await owner.request('/api/brand/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_type: 'markdown', source_label: 'conflicting note', content: '# price conflict', conflict_keys: ['products.tea.price'] })
  });
  const conflictApproval = await owner.request(`/api/brand/revisions/${conflict.body.revision.id}/approve`, { method: 'POST' });
  assert.equal(conflictApproval.response.status, 409);
  assert.equal(conflictApproval.body.error_code, 'brand_revision_conflict');
});

test('A08: changing a price version marks an old brand reference stale', async () => {
  const created = await owner.request('/api/products', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'sto_demo_01', external_sku: 'TEA-001', names: { en: 'Milk Tea' }, price_minor: 12000, currency: 'BDT' })
  });
  assert.equal(created.response.status, 201);
  productId = created.body.item.id;
  const price = await owner.request(`/api/products/${productId}/prices`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount_minor: 12000, currency: 'BDT', status: 'approved', source_citation: 'synthetic client price sheet' })
  });
  assert.equal(price.response.status, 201);
  priceVersionId = price.body.item.id;
  const reference = await owner.request('/api/brand/references', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'sto_demo_01', resource_type: 'content', resource_id: 'content-demo-1', product_price_refs: [{ product_id: productId, price_version_id: priceVersionId }] })
  });
  assert.equal(reference.response.status, 201);
  const changed = await owner.request(`/api/products/${productId}/prices`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount_minor: 14000, currency: 'BDT', status: 'approved', source_citation: 'synthetic revised price sheet' })
  });
  assert.equal(changed.response.status, 201);
  const referenceState = await owner.request(`/api/brand/references/${reference.body.item.id}`);
  assert.equal(referenceState.body.item.status, 'stale');
  assert.equal(referenceState.body.executable, false);
});

test('A13: publish check blocks missing/expired rights and unapproved prices', async () => {
  const asset = await owner.request('/api/media-assets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'sto_demo_01', storage_key: 'synthetic/photo.jpg', checksum: 'abc123', mime_type: 'image/jpeg', rights_status: 'unknown' })
  });
  assert.equal(asset.response.status, 201);
  assetId = asset.body.item.id;
  const blocked = await owner.request('/api/brand/publish-check', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'sto_demo_01', product_ids: [productId], asset_ids: [assetId], end_at: new Date(Date.now() - 60_000).toISOString() })
  });
  assert.equal(blocked.response.status, 409);
  assert.ok(blocked.body.errors.some((item: any) => item.code === 'asset_rights_missing'));
  assert.ok(blocked.body.errors.some((item: any) => item.code === 'campaign_expired'));
  const approvedAsset = await owner.request('/api/media-assets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'sto_demo_01', storage_key: 'synthetic/approved.jpg', checksum: 'approved123', mime_type: 'image/jpeg', rights_status: 'approved', allowed_uses: ['organic_social'] })
  });
  const ok = await owner.request('/api/brand/publish-check', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'sto_demo_01', product_ids: [productId], asset_ids: [approvedAsset.body.item.id], start_at: new Date().toISOString(), end_at: new Date(Date.now() + 86_400_000).toISOString() })
  });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body.ok, true);
});

test('expired brand revisions cannot be approved', async () => {
  const created = await owner.request('/api/brand/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_type: 'txt', source_label: 'expired synthetic note', content: 'old fact', effective_to: new Date(Date.now() - 86_400_000).toISOString() })
  });
  const result = await owner.request(`/api/brand/revisions/${created.body.revision.id}/approve`, { method: 'POST' });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error_code, 'brand_revision_expired');
});
