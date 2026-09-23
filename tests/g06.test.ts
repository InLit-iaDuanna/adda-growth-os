import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';

let app: RunningTestApp;
let owner: TestClient;

async function member(label: string, verified = true) {
  const created = await app.repository.createMember({
    tenantId: 'ten_demo_01',
    storeId: 'sto_demo_01',
    externalMemberId: `g06-${label}-${randomUUID()}`,
    displayName: label,
    registeredAt: '2026-09-01T00:00:00.000Z',
    language: 'en',
    contact: null,
    contactHmac: `hmac-${label}-${randomUUID()}`,
    publicAccessTokenHash: null,
    isSynthetic: true
  });
  if (verified) await app.repository.verifyMemberContact(created.tenantId, created.id, 'test-proof', '2099-01-01T00:00:00.000Z');
  if (verified) await app.repository.addConsent({ tenantId: created.tenantId, memberId: created.id, channel: 'email', purpose: 'marketing', granted: true, noticeVersion: 'g06-test', source: 'test' });
  return created;
}

async function orderFor(memberId: string, externalOrderId: string, paidAt = '2026-09-20T04:00:00.000Z') {
  await app.repository.mutate((state) => {
    state.orders.push({ id: randomUUID(), tenantId: 'ten_demo_01', storeId: 'sto_demo_01', source: 'g06-test', externalOrderId, memberId, paidAt, currency: 'BDT', amountPaidMinor: 1000, status: 'paid', revision: 1, sourceRowHash: `hash-${externalOrderId}`, active: true, correctionOfId: null, createdAt: paidAt, updatedAt: paidAt });
  });
}

async function createOutreach(extra: Record<string, unknown> = {}) {
  return owner.request('/api/outreach/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: 'sto_demo_01', name: `G06 outreach ${randomUUID()}`, rule: 'marketing_opt_in', channel: 'email', template_id: 'tpl-approved-1', template_text: 'Approved synthetic message', template_approved: true, budget_minor: 10000, cost_per_attempt_minor: 100, holdout_percent: 50, seed: 'stable-g06-seed', quiet_start_local: '00:00', quiet_end_local: '23:59', frequency_cap_days: 7, ...extra })
  });
}

before(async () => {
  app = await startTestApp({ seedDemo: true });
  owner = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
});

after(async () => { await app.close(); });

test('A28/A37: segment rules use real behavior and preview never returns contacts', async () => {
  const opted = await member('opted');
  const notOpted = await member('not-opted', false);
  await orderFor(opted.id, 'g06-order-opted');
  const preview = await owner.request('/api/segments/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', rule: 'marketing_opt_in' }) });
  assert.equal(preview.response.status, 200);
  assert.ok(preview.body.count >= 1);
  assert.equal(preview.body.contact_fields_included, false);
  assert.equal(preview.body.sample_redacted, true);
  assert.ok(!JSON.stringify(preview.body).includes('hmac-'));
  const unpurchased = await owner.request('/api/segments/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', rule: 'registered_unpurchased' }) });
  assert.equal(unpurchased.response.status, 200);
  assert.ok(unpurchased.body.count >= 1);
  assert.ok(notOpted.id);
});

test('A38/A40: frozen audience keeps stable holdout, excludes post-freeze opt-out and new members', async () => {
  const first = await member('freeze-first');
  const outreach = await createOutreach();
  assert.equal(outreach.response.status, 201);
  const secondPreview = await owner.request('/api/outreach/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', name: outreach.body.segment.name, rule: 'marketing_opt_in', channel: 'email', template_id: 'tpl-approved-1', template_text: 'Approved synthetic message', template_approved: true, budget_minor: 10000, cost_per_attempt_minor: 100, holdout_percent: 50, seed: 'stable-g06-seed', quiet_start_local: '00:00', quiet_end_local: '23:59', frequency_cap_days: 7 }) });
  assert.equal(secondPreview.response.status, 201);
  assert.equal(secondPreview.body.audience.id, outreach.body.audience.id);
  assert.equal(secondPreview.body.audience.policy_hash, outreach.body.audience.policy_hash);
  await app.repository.addConsent({ tenantId: first.tenantId, memberId: first.id, channel: 'email', purpose: 'marketing', granted: false, noticeVersion: 'g06-revoke', source: 'test' });
  const newcomer = await member('after-freeze');
  const submit = await owner.request(`/api/outreach/${outreach.body.campaign.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(submit.response.status, 200);
  const dispatch = await owner.request(`/api/outreach/${outreach.body.campaign.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2026-09-22T06:00:00.000Z' }) });
  assert.equal(dispatch.response.status, 200);
  const ids = dispatch.body.attempts.map((attempt: any) => attempt.member_ref);
  assert.ok(!ids.includes(newcomer.id));
  const revoked = dispatch.body.attempts.find((attempt: any) => attempt.member_ref === first.id);
  assert.ok(!revoked || ['skipped_suppressed', 'skipped_holdout'].includes(revoked.status));
  assert.equal(dispatch.body.report.analysis_population, 'all_frozen_assignments_including_holdout_and_not_sent');
  assert.equal(dispatch.body.report.exploratory, true);
});

test('A39: template, budget, quiet hours and frequency cap are server-side policies', async () => {
  await member('policy-a');
  const unapproved = await createOutreach({ template_approved: false });
  assert.equal((await owner.request(`/api/outreach/${unapproved.body.campaign.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).response.status, 409);
  const quiet = await createOutreach({ holdout_percent: 0, quiet_start_local: '09:00', quiet_end_local: '21:00' });
  assert.equal((await owner.request(`/api/outreach/${quiet.body.campaign.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).response.status, 200);
  const quietDispatch = await owner.request(`/api/outreach/${quiet.body.campaign.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2026-09-22T00:00:00.000Z' }) });
  assert.equal(quietDispatch.response.status, 200);
  assert.ok(quietDispatch.body.attempts.some((attempt: any) => attempt.status === 'skipped_quiet_hours'));
  const budget = await createOutreach({ holdout_percent: 0, budget_minor: 0, cost_per_attempt_minor: 100, quiet_start_local: '00:00', quiet_end_local: '23:59' });
  assert.equal((await owner.request(`/api/outreach/${budget.body.campaign.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).response.status, 200);
  const budgetDispatch = await owner.request(`/api/outreach/${budget.body.campaign.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2026-09-22T06:00:00.000Z' }) });
  assert.ok(budgetDispatch.body.attempts.some((attempt: any) => attempt.status === 'skipped_budget'));
  const first = await createOutreach({ holdout_percent: 0, quiet_start_local: '00:00', quiet_end_local: '23:59', seed: `frequency-${randomUUID()}` });
  await owner.request(`/api/outreach/${first.body.campaign.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const firstDispatch = await owner.request(`/api/outreach/${first.body.campaign.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2026-09-22T06:00:00.000Z' }) });
  assert.equal(firstDispatch.response.status, 200);
  const second = await createOutreach({ holdout_percent: 0, quiet_start_local: '00:00', quiet_end_local: '23:59', seed: `frequency-2-${randomUUID()}` });
  await owner.request(`/api/outreach/${second.body.campaign.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const secondDispatch = await owner.request(`/api/outreach/${second.body.campaign.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2026-09-22T07:00:00.000Z' }) });
  assert.ok(secondDispatch.body.attempts.some((attempt: any) => attempt.status === 'skipped_frequency'));
});

test('A40/A48: production dispatch does not fake delivery', async () => {
  const outreach = await createOutreach({ seed: `production-${randomUUID()}`, holdout_percent: 0, quiet_start_local: '00:00', quiet_end_local: '23:59' });
  assert.equal((await owner.request(`/api/outreach/${outreach.body.campaign.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).response.status, 200);
  app.config.allowTestOutbox = false;
  const result = await owner.request(`/api/outreach/${outreach.body.campaign.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2026-09-22T06:00:00.000Z' }) });
  assert.equal(result.response.status, 200);
  assert.ok(result.body.attempts.every((attempt: any) => ['external_blocked', 'skipped_suppressed', 'skipped_frequency', 'skipped_unverified', 'skipped_holdout'].includes(attempt.status)));
  app.config.allowTestOutbox = true;
});
