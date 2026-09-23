import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';

let app: RunningTestApp;
let owner: TestClient;
let cashier: TestClient;

async function makeMember(label: string) {
  return app.repository.createMember({ tenantId: 'ten_demo_01', storeId: 'sto_demo_01', externalMemberId: `g05-${label}-${randomUUID()}`, displayName: label, registeredAt: new Date().toISOString(), language: 'en', contact: null, contactHmac: `h-${label}-${randomUUID()}`, publicAccessTokenHash: null, isSynthetic: true });
}

before(async () => {
  app = await startTestApp({ seedDemo: true });
  owner = new TestClient(app.baseUrl);
  cashier = new TestClient(app.baseUrl);
  await owner.login('owner@demo.adda.local');
  await cashier.login('cashier@demo.adda.local');
});

after(async () => { await app.close(); });

test('A33: partner/KOC requires a source and starts as identified', async () => {
  const missing = await owner.request('/api/partners', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Unverified club' }) });
  assert.equal(missing.response.status, 400);
  const created = await owner.request('/api/partners', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic student club', kind: 'club', source_url: 'https://example.invalid/club', contact_permission: false, follower_count: 999 }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.item.stage, 'identified');
  assert.equal(created.body.item.followerCount, 999);
  const verified = await owner.request(`/api/partners/${created.body.item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: 'verified' }) });
  assert.equal(verified.response.status, 200);
  assert.ok(verified.body.item.verifiedAt);
});

test('A34: event capacity, registration and check-in counts are separate and idempotent', async () => {
  const templates = await owner.request('/api/events/templates');
  assert.equal(templates.response.status, 200);
  assert.equal(templates.body.items.length, 12);
  const event = await owner.request('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template_key: 'study_break', store_id: 'sto_demo_01', name: 'Synthetic study break', capacity: 2, starts_at: '2026-10-01T16:00:00Z', ends_at: '2026-10-01T17:00:00Z' }) });
  assert.equal(event.response.status, 201);
  await owner.request(`/api/events/${event.body.item.id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'open' }) });
  const members = await Promise.all([makeMember('r1'), makeMember('r2'), makeMember('r3')]);
  const registrations = await Promise.all(members.map((member) => owner.request(`/api/events/${event.body.item.id}/registrations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: member.id }) })));
  assert.equal(registrations.filter((item) => item.response.status === 200).length, 2);
  assert.equal(registrations.filter((item) => item.response.status === 409).length, 1);
  const duplicate = await owner.request(`/api/events/${event.body.item.id}/registrations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: members[0].id }) });
  assert.equal(duplicate.response.status, 200);
  const checkin = await cashier.request(`/api/events/${event.body.item.id}/checkins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: members[0].id, registration_id: registrations[0].body.registration.id }) });
  assert.equal(checkin.response.status, 200);
  const duplicateCheckin = await cashier.request(`/api/events/${event.body.item.id}/checkins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: members[0].id, registration_id: registrations[0].body.registration.id }) });
  assert.equal(duplicateCheckin.response.status, 200);
  const stored = app.repository.findEvent(event.body.item.id)!;
  assert.equal(stored.registrationCount, 2);
  assert.equal(stored.checkinCount, 1);
});

test('A35/A36: referral qualification excludes self/duplicates/prior buyers and rewards stay manual', async () => {
  const inviter = await makeMember('inviter');
  const invitee = await makeMember('invitee');
  const self = await owner.request('/api/referrals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', inviter_member_id: inviter.id, invitee_member_id: inviter.id }) });
  assert.equal(self.response.status, 409);
  const created = await owner.request('/api/referrals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', inviter_member_id: inviter.id, invitee_member_id: invitee.id }) });
  assert.equal(created.response.status, 201);
  const duplicate = await owner.request('/api/referrals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', inviter_member_id: inviter.id, invitee_member_id: invitee.id }) });
  assert.equal(duplicate.response.status, 409);
  const beforeOrder = await owner.request(`/api/referrals/${created.body.item.id}/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(beforeOrder.body.referral.status, 'registered');
  const paidAt = new Date(Date.parse(created.body.item.createdAt) + 1000).toISOString();
  const orderCsv = `tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\nten_demo_01,sto_demo_01,g05_pos,G05-ORDER-1,${invitee.id},${paidAt},BDT,10000,paid`;
  const orderPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: orderCsv, source: 'g05_pos', store_id: 'sto_demo_01', complete_through: new Date(Date.parse(paidAt) + 3600000).toISOString() }) });
  await owner.request(`/api/imports/${orderPreview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const evaluated = await owner.request(`/api/referrals/${created.body.item.id}/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(evaluated.body.referral.status, 'qualified');
  assert.equal(evaluated.body.reward.status, 'eligible');
  const approved = await owner.request(`/api/rewards/${evaluated.body.reward.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount_minor: 500 }) });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.item.status, 'approved');
  assert.equal(approved.body.payment, 'not_automated');
});

test('A35: existing buyer and full refund make referral not payable', async () => {
  const inviter = await makeMember('inviter2');
  const buyer = await makeMember('buyer2');
  const orderCsv = `tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\nten_demo_01,sto_demo_01,g05_prior,G05-ORDER-2,${buyer.id},2026-09-21T10:00:00+06:00,BDT,8000,paid`;
  const orderPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: orderCsv, source: 'g05_prior', store_id: 'sto_demo_01', complete_through: '2026-09-22T12:00:00+06:00' }) });
  await owner.request(`/api/imports/${orderPreview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const ineligible = await owner.request('/api/referrals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', inviter_member_id: inviter.id, invitee_member_id: buyer.id }) });
  assert.equal(ineligible.response.status, 201);
  assert.equal(ineligible.body.item.status, 'ineligible');
  assert.equal(ineligible.body.reward_status, 'not_payable');
  const fresh = await makeMember('refund-buyer');
  const referral = await owner.request('/api/referrals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', inviter_member_id: inviter.id, invitee_member_id: fresh.id }) });
  const paidAt = new Date(Date.parse(referral.body.item.createdAt) + 1000).toISOString();
  const freshOrder = 'tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\nten_demo_01,sto_demo_01,g05_refund,G05-ORDER-3,' + fresh.id + ',' + paidAt + ',BDT,7000,paid';
  const freshPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'orders', content: freshOrder, source: 'g05_refund', store_id: 'sto_demo_01', complete_through: new Date(Date.parse(paidAt) + 3600000).toISOString() }) });
  await owner.request(`/api/imports/${freshPreview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const refundedAt = new Date(Date.parse(paidAt) + 2 * 3600000).toISOString();
  const refund = 'tenant_id,store_id,source,external_adjustment_id,external_order_id,occurred_at,amount_minor\nten_demo_01,sto_demo_01,g05_refund,G05-R-3,G05-ORDER-3,' + refundedAt + ',7000';
  const refundPreview = await owner.request('/api/imports/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'refunds', content: refund, source: 'g05_refund', store_id: 'sto_demo_01', complete_through: new Date(Date.parse(refundedAt) + 3600000).toISOString() }) });
  await owner.request(`/api/imports/${refundPreview.body.import.id}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const reversed = await owner.request(`/api/referrals/${referral.body.item.id}/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(reversed.body.referral.status, 'reversed');
  assert.equal(reversed.body.reward.status, 'reversed');
});
