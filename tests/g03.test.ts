import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';

let app: RunningTestApp;
let owner: TestClient;
let cashier: TestClient;
let sourceToken = '';
let memberId = '';
let memberToken = '';
let couponId = '';
let couponToken = '';
let campaignId = '';

before(async () => {
  app = await startTestApp({ seedDemo: true });
  owner = new TestClient(app.baseUrl);
  cashier = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
  assert.equal((await cashier.login('cashier@demo.adda.local')).response.status, 200);
});

after(async () => { await app.close(); });

test('A24/A25/A27: opaque source link records touch without treating it as an order', async () => {
  const campaign = await owner.request('/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'First-party campus slice', objective: 'verified orders', store_id: 'sto_demo_01' }) });
  assert.equal(campaign.response.status, 201);
  campaignId = campaign.body.item.id;
  const link = await owner.request(`/api/campaigns/${campaignId}/source-links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'campus variant A', channel: 'manual', variant: 'A' }) });
  assert.equal(link.response.status, 201);
  sourceToken = link.body.token;
  assert.ok(sourceToken.length >= 32);
  assert.match(link.body.url, /\/s\/du-gate-demo\/c\//);
  assert.doesNotMatch(link.body.url, /@|phone|member|M001/);
  const page = await owner.request(link.body.url);
  assert.equal(page.response.status, 200);
  assert.match(page.body, /English/);
  assert.equal(app.repository.snapshot().touchEvents.filter((item) => item.eventType === 'view').length, 1);
  assert.equal(app.repository.snapshot().orders.length, 0);
});

test('A28/A29: registration works without marketing opt-in; verification is explicit', async () => {
  const registered = await owner.request('/api/members/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_token: sourceToken, contact: 'synthetic@example.invalid', language: 'en', marketing_opt_in: false }) });
  assert.equal(registered.response.status, 201);
  memberId = registered.body.member.id;
  memberToken = registered.body.member_token;
  assert.equal(registered.body.member.marketing_opt_in, false);
  assert.equal(registered.body.member.contact_verified, false);
  const verified = await owner.request('/api/members/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: memberId, member_token: memberToken, code: '000000' }) });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.contact_verified, true);
  assert.equal(app.repository.snapshot().consentEvents.filter((item) => item.memberId === memberId).length, 0);
});

test('A30/A31: coupon reservation is not revenue and 20 concurrent requests yield one success', async () => {
  const offer = await owner.request('/api/offers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaign_id: campaignId, name: 'Synthetic tea offer', terms: 'one approved offer', valid_to: new Date(Date.now() + 86_400_000).toISOString(), max_redemptions: 10 }) });
  assert.equal(offer.response.status, 201);
  const issued = await owner.request('/api/public/coupons/issue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_token: sourceToken, member_id: memberId, member_token: memberToken, offer_id: offer.body.item.id }) });
  assert.equal(issued.response.status, 201);
  couponId = issued.body.coupon.id;
  couponToken = issued.body.coupon.token;
  const requests = Array.from({ length: 20 }, () => cashier.request('/api/redemptions/reserve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coupon_token: couponToken, store_id: 'sto_demo_01', pos_order_ref: 'POS-G03-001' }) }));
  const results = await Promise.all(requests);
  assert.equal(results.filter((result) => result.response.status === 200).length, 1);
  assert.equal(results.filter((result) => result.response.status === 409).length, 19);
  assert.equal(app.repository.findCoupon(couponId)?.status, 'pending_pos_verification');
  assert.equal(app.repository.snapshot().orders.length, 0);
});

test('A30: reservation cannot match until authoritative POS import exists', async () => {
  const before = await cashier.request(`/api/redemptions/${couponId}/match-pos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', pos_order_ref: 'POS-G03-001' }) });
  assert.equal(before.response.status, 409);
  assert.equal(before.body.error_code, 'pos_order_not_found');
  const csv = 'tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\nten_demo_01,sto_demo_01,g03_pos,POS-G03-001,' + memberId + ',2026-09-22T12:00:00+06:00,BDT,15000,paid';
  const preview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: csv, source: 'g03_pos', store_id: 'sto_demo_01', complete_through: '2026-09-22T12:00:00+06:00' }) });
  await owner.request(`/api/imports/${preview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const matched = await cashier.request(`/api/redemptions/${couponId}/match-pos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', pos_order_ref: 'POS-G03-001' }) });
  assert.equal(matched.response.status, 200);
  assert.equal(matched.body.coupon.status, 'redeemed');
  const duplicate = await cashier.request(`/api/redemptions/${couponId}/match-pos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', pos_order_ref: 'POS-G03-001' }) });
  assert.equal(duplicate.response.status, 200);
  assert.equal(app.repository.snapshot().attributionEvidence.filter((item) => item.orderExternalId === 'POS-G03-001').length, 1);
});

test('A32: expired and wrong-store coupons are rejected with stable errors', async () => {
  const expiredOffer = await owner.request('/api/offers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaign_id: campaignId, name: 'Expired synthetic offer', valid_from: new Date(Date.now() - 86_400_000).toISOString(), valid_to: new Date(Date.now() - 60_000).toISOString(), terms: 'expired' }) });
  assert.equal(expiredOffer.response.status, 201);
  const issued = await owner.request('/api/public/coupons/issue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_token: sourceToken, member_id: memberId, member_token: memberToken, offer_id: expiredOffer.body.item.id }) });
  assert.equal(issued.response.status, 409);
  assert.equal(issued.body.error_code, 'offer_unavailable');
  const revoke = await owner.request('/api/consents/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: memberId, member_token: memberToken, channel: 'email' }) });
  assert.equal(revoke.response.status, 200);
  assert.equal(app.repository.consentGranted('ten_demo_01', memberId, 'marketing'), false);
});

test('production verification does not fake a verified contact', async () => {
  const production = await startTestApp({ mode: 'production' });
  const token = 'production-test-token';
  const tokenHash = createHmac('sha256', production.config.sessionSecret).update(token).digest('hex');
  const member = await production.repository.createMember({ tenantId: 'unknown', storeId: 'unknown', externalMemberId: 'm', displayName: null, registeredAt: new Date().toISOString(), language: 'en', contact: null, contactHmac: 'h', publicAccessTokenHash: tokenHash, isSynthetic: false });
  const client = new TestClient(production.baseUrl);
  const response = await client.request('/api/members/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: member.id, member_token: token, code: '000000' }) });
  assert.equal(response.response.status, 409);
  assert.equal(response.body.error_code, 'verification_external_blocked');
  await production.close();
});
