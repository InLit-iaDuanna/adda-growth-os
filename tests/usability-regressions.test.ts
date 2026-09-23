import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startTestApp, TestClient } from '../packages/testing/src/http';
import { marketingConsentForChannel } from '../packages/domain/src/outreach-policy';
import { refreshOutreachStatus } from '../packages/domain/src/outreach-ledger';

const storeId = 'sto_demo_01';
const tenantId = 'ten_demo_01';
const post = (client: TestClient, path: string, body: unknown = {}) => client.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function setup(t: TestContext) {
  const app = await startTestApp({ seedDemo: true });
  t.after(async () => { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }); });
  const owner = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
  return { app, owner };
}

test('invalid empty CSV cannot certify zero revenue', async t => {
  const { owner } = await setup(t);
  const preview = await post(owner, '/api/imports/preview', { kind: 'orders', store_id: storeId, source: 'pos', content: 'garbage_header\n', complete_through: new Date().toISOString() });
  assert.equal(preview.response.status, 400);
  assert.equal(preview.body.error_code, 'invalid_import_headers');
  const metrics = await owner.request('/api/metrics');
  assert.equal(metrics.body.quality, 'missing');
});

test('same CSV bytes in two POS sources create separate import batches', async t => {
  const { owner } = await setup(t);
  const csv = 'tenant_id,store_id,source,external_order_id,paid_at,currency,amount_paid_minor,status\n';
  const through = new Date().toISOString();
  const first = await post(owner, '/api/imports/preview', { kind: 'orders', store_id: storeId, source: 'pos-a', content: csv, complete_through: through });
  const second = await post(owner, '/api/imports/preview', { kind: 'orders', store_id: storeId, source: 'pos-b', content: csv, complete_through: through });
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.notEqual(first.body.import.id, second.body.import.id);
  assert.equal(second.body.import.source, 'pos-b');
});

test('campaign with missing objective cannot be approved or issue offers', async t => {
  const { owner } = await setup(t);
  const created = await post(owner, '/api/campaigns', { store_id: storeId, name: 'Incomplete test' });
  const id = created.body.item.id;
  const approval = await owner.request('/api/campaigns/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved', needs_input: [] }) });
  assert.equal(approval.response.status, 400);
  assert.equal(approval.body.error_code, 'campaign_needs_input');
  const offer = await post(owner, '/api/offers', { campaign_id: id, name: 'Invalid offer', valid_to: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(offer.response.status, 409);
});

test('changing an approved campaign returns it to approval', async t => {
  const { owner } = await setup(t);
  const campaign = await post(owner, '/api/campaigns', { store_id: storeId, name: 'Original campaign', objective: 'qualified orders' });
  const path = '/api/campaigns/' + campaign.body.item.id;
  const approved = await owner.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) });
  assert.equal(approved.body.item.status, 'approved');
  const edited = await owner.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Updated campaign' }) });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.item.status, 'pending_approval');
});

test('store manager cannot self-approve prices, assets, or outreach copy', async t => {
  const { app, owner } = await setup(t);
  await app.repository.mutate(state => { const membership = state.memberships.find(item => item.userId === 'usr_demo_manager'); assert.ok(membership); membership.role = 'STORE_MANAGER'; });
  const manager = new TestClient(app.baseUrl);
  assert.equal((await manager.login('manager@demo.adda.local')).response.status, 200);
  const product = await post(owner, '/api/products', { store_id: storeId, external_sku: 'ROLE-TEST', names: { en: 'Role test' } });
  const price = await post(manager, '/api/products/' + product.body.item.id + '/prices', { amount_minor: 10000, status: 'approved' });
  assert.equal(price.response.status, 403);
  assert.equal(price.body.error_code, 'price_approval_forbidden');
  const asset = await post(manager, '/api/media-assets', { store_id: storeId, storage_key: 'synthetic/role.jpg', checksum: 'role-test', rights_status: 'approved' });
  assert.equal(asset.response.status, 403);
  assert.equal(asset.body.error_code, 'asset_approval_forbidden');
  const outreach = await post(manager, '/api/outreach/preview', { template_approved: true });
  assert.equal(outreach.response.status, 403);
  assert.equal(outreach.body.error_code, 'template_approval_forbidden');
});

test('public marketing opt-in without a channel grants no WhatsApp permission', async t => {
  const { app, owner } = await setup(t);
  const campaign = await post(owner, '/api/campaigns', { store_id: storeId, name: 'Consent test', objective: 'visits' });
  const link = await post(owner, '/api/campaigns/' + campaign.body.item.id + '/source-links', { label: 'consent link' });
  const publicClient = new TestClient(app.baseUrl);
  const registration = await post(publicClient, '/api/members/register', { source_token: link.body.token, contact: 'consent@example.invalid', marketing_opt_in: true });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.body.member.marketing_opt_in, false);
  assert.equal(marketingConsentForChannel(app.repository.snapshot(), tenantId, registration.body.member.id, 'whatsapp'), false);
});

test('check-in requires an open event and a registration', async t => {
  const { app, owner } = await setup(t);
  const member = await app.repository.createMember({ tenantId, storeId, externalMemberId: 'checkin-regression', displayName: null, registeredAt: new Date().toISOString(), language: 'en', contact: null, contactHmac: null, publicAccessTokenHash: null, isSynthetic: true });
  const event = await post(owner, '/api/events', { store_id: storeId, template_key: 'study_break', name: 'Check-in test', capacity: 1 });
  const path = '/api/events/' + event.body.item.id + '/checkins';
  const draft = await post(owner, path, { member_id: member.id });
  assert.equal(draft.response.status, 409);
  assert.equal(draft.body.error_code, 'event_not_open');
  const premature = await post(owner, '/api/events/' + event.body.item.id + '/status', { status: 'open' });
  assert.equal(premature.response.status, 409);
  assert.equal(premature.body.error_code, 'event_date_required');
  const scheduled = await owner.request('/api/events/' + event.body.item.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starts_at: '2026-10-01T16:00:00Z', ends_at: '2026-10-01T17:00:00Z', capacity: 1 }) });
  assert.equal(scheduled.response.status, 200);
  await post(owner, '/api/events/' + event.body.item.id + '/status', { status: 'open' });
  const unregistered = await post(owner, path, { member_id: member.id });
  assert.equal(unregistered.response.status, 409);
  assert.equal(unregistered.body.error_code, 'registration_not_found');
});

test('a prior purchase imported after referral creation stays ineligible', async t => {
  const { app, owner } = await setup(t);
  const memberInput = (id: string) => ({ tenantId, storeId, externalMemberId: id, displayName: null, registeredAt: new Date().toISOString(), language: 'en' as const, contact: null, contactHmac: null, publicAccessTokenHash: null, isSynthetic: true });
  const inviter = await app.repository.createMember(memberInput('late-prior-inviter'));
  const invitee = await app.repository.createMember(memberInput('late-prior-invitee'));
  const referral = await post(owner, '/api/referrals', { store_id: storeId, inviter_member_id: inviter.id, invitee_member_id: invitee.id });
  assert.equal(referral.body.item.status, 'registered');
  const priorPaidAt = new Date(Date.parse(referral.body.item.createdAt) - 86400000).toISOString();
  const csv = `tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\n${tenantId},${storeId},late_pos,LATE-PRIOR-1,${invitee.id},${priorPaidAt},BDT,5000,paid`;
  const preview = await post(owner, '/api/imports/preview', { kind: 'orders', store_id: storeId, source: 'late_pos', content: csv, complete_through: new Date().toISOString() });
  assert.equal(preview.body.preview.error_count, 0);
  await post(owner, '/api/imports/' + preview.body.import.id + '/commit');
  const evaluated = await post(owner, '/api/referrals/' + referral.body.item.id + '/evaluate');
  assert.equal(evaluated.body.referral.status, 'ineligible');
  assert.equal(evaluated.body.reward.status, 'not_payable');
});

test('outreach with only holdout members is not marked completed', () => {
  const campaign = { id: 'outreach-only-holdout', tenantId, storeId, channel: 'email', status: 'approved' } as any;
  const snapshot = { memberIds: ['member-1'], assignments: { 'member-1': 'holdout' } } as any;
  const state = { outreachCampaigns: [campaign], messageAttempts: [{ tenantId, outreachId: campaign.id, memberId: 'member-1', status: 'skipped_holdout' }], deliveryIntents: [] } as any;
  refreshOutreachStatus(state, campaign, snapshot);
  assert.equal(campaign.status, 'blocked');
});

test('migration repairs a previously completed all-holdout outreach', async t => {
  const { app } = await setup(t);
  await app.repository.mutate(state => {
    state.audienceSnapshots.push({ id: 'all-holdout-snapshot', tenantId, storeId, memberIds: ['member-1'], assignments: { 'member-1': 'holdout' } } as any);
    state.outreachCampaigns.push({ id: 'historical-all-holdout', tenantId, storeId, audienceSnapshotId: 'all-holdout-snapshot', channel: 'email', status: 'completed' } as any);
    state.messageAttempts.push({ id: 'historical-holdout-attempt', tenantId, outreachId: 'historical-all-holdout', memberId: 'member-1', status: 'skipped_holdout' } as any);
  });
  await app.repository.migrate();
  assert.equal(app.repository.findOutreachCampaign('historical-all-holdout')?.status, 'blocked');
});

test('large CSV preview follows the advertised import size and validates quiet hours', async t => {
  const { owner } = await setup(t);
  const csv = 'tenant_id,store_id,source,external_order_id,paid_at,currency,amount_paid_minor,status\n' + 'x'.repeat(300_000);
  const preview = await post(owner, '/api/imports/preview', { kind: 'orders', store_id: storeId, source: 'pos', content: csv });
  assert.equal(preview.response.status, 201);
  assert.ok(preview.body.preview.error_count > 0);
  const outreach = await post(owner, '/api/outreach/preview', { store_id: storeId, rule: 'marketing_opt_in', channel: 'manual', template_id: 'test', template_text: 'test', quiet_start_local: '99:99' });
  assert.equal(outreach.response.status, 400);
  assert.equal(outreach.body.error_code, 'invalid_outreach_window');
});
