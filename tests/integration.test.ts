import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';

let app: RunningTestApp;
let owner: TestClient;
let cashier: TestClient;
let campaignId = '';

before(async () => {
  app = await startTestApp({ seedDemo: true });
  owner = new TestClient(app.baseUrl);
  cashier = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
  assert.equal((await cashier.login('cashier@demo.adda.local')).response.status, 200);
});

after(async () => { await app.close(); });

test('A02: authenticated campaign creation persists to disk', async () => {
  const created = await owner.request('/api/campaigns', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Persistence slice', store_id: 'sto_demo_01' })
  });
  assert.equal(created.response.status, 201);
  campaignId = created.body.item.id;
  assert.equal(created.body.item.status, 'needs_input');
  const onDisk = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.dataDir, 'db.json'), 'utf8'));
  assert.ok(onDisk.campaigns.some((item: any) => item.id === campaignId));
});

test('A02: campaign survives a web server restart', async () => {
  await app.close();
  app = await startTestApp({ dataFile: path.join(app.dataDir, 'db.json') });
  owner = new TestClient(app.baseUrl);
  cashier = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
  assert.equal((await cashier.login('cashier@demo.adda.local')).response.status, 200);
  const result = await owner.request(`/api/campaigns/${campaignId}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.item.name, 'Persistence slice');
});

test('A03: another tenant cannot read or enumerate the first tenant campaign', async () => {
  const tenant = await app.repository.createTenant({ slug: 'other', name: 'Other synthetic tenant', mode: 'test', status: 'active', timezone: 'UTC', currency: 'USD', launchDate: null });
  const store = await app.repository.createStore({ tenantId: tenant.id, slug: 'other-store', name: 'Other store', timezone: 'UTC', currency: 'USD', status: 'active' });
  const user = await app.repository.createUser({ email: 'owner@other.invalid', displayName: 'Other owner', password: 'other-test-password', status: 'active' });
  await app.repository.addMembership({ tenantId: tenant.id, userId: user.id, role: 'OWNER', storeIds: [store.id], revokedAt: null });
  const other = new TestClient(app.baseUrl);
  assert.equal((await other.login('owner@other.invalid', 'other-test-password')).response.status, 200);
  const direct = await other.request(`/api/campaigns/${campaignId}`);
  assert.equal(direct.response.status, 404);
  const listed = await other.request('/api/campaigns');
  assert.equal(listed.body.items.length, 0);
});

test('A04: same-tenant ungranted store is hidden', async () => {
  const second = await app.repository.createStore({ tenantId: 'ten_demo_01', slug: 'hidden-store', name: 'Hidden demo store', timezone: 'Asia/Dhaka', currency: 'BDT', status: 'active' });
  await app.repository.createCampaign({ tenantId: 'ten_demo_01', storeId: second.id, name: 'Hidden campaign', objective: null, budgetMinor: null, status: 'needs_input', needsInput: ['objective'], createdBy: 'usr_demo_owner' });
  const list = await owner.request('/api/campaigns');
  assert.ok(!list.body.items.some((item: any) => item.name === 'Hidden campaign'));
  const scoped = await owner.request(`/api/campaigns?store_id=${encodeURIComponent(second.id)}`);
  assert.equal(scoped.response.status, 404);
});

test('A05: CASHIER is blocked from sensitive operations', async () => {
  const exportResult = await cashier.request('/api/exports/members');
  assert.equal(exportResult.response.status, 403);
  assert.equal(exportResult.body.error_code, 'member_export_forbidden');
  const integrationResult = await cashier.request('/api/integrations');
  assert.equal(integrationResult.response.status, 403);
  const editResult = await cashier.request(`/api/campaigns/${campaignId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ budget_minor: 1000 })
  });
  assert.equal(editResult.response.status, 403);
  assert.equal(editResult.body.error_code, 'budget_edit_forbidden');
});

test('writes require the session CSRF token', async () => {
  const noCsrf = new TestClient(app.baseUrl);
  const login = await noCsrf.login('owner@demo.adda.local');
  assert.equal(login.response.status, 200);
  noCsrf.csrf = '';
  const result = await noCsrf.request('/api/campaigns', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'blocked', store_id: 'sto_demo_01' })
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.error_code, 'csrf_failed');
});
