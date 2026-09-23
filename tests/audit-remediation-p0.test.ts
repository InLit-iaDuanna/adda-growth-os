import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TestClient } from '../packages/testing/src/http';

test('R01: tenant owner cannot change the platform-wide kill switch', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    const owner = new TestClient(app.baseUrl);
    assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
    const denied = await owner.request('/api/connectors/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(denied.response.status, 403);
    assert.equal(app.repository.snapshot().externalWritesKillSwitch, false);
  } finally { await app.close(); }
});

test('R02: reviewer cannot smuggle an unauthorized campaign edit with approval status', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    const owner = new TestClient(app.baseUrl);
    const reviewer = new TestClient(app.baseUrl);
    assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
    assert.equal((await reviewer.login('reviewer@demo.adda.local')).response.status, 200);
    const created = await owner.request('/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'R02 campaign', objective: 'orders', store_id: 'sto_demo_01' }) });
    assert.equal(created.response.status, 201);
    const denied = await reviewer.request(`/api/campaigns/${created.body.item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved', name: 'reviewer changed name' }) });
    assert.equal(denied.response.status, 403);
    const unchanged = await owner.request(`/api/campaigns/${created.body.item.id}`);
    assert.equal(unchanged.body.item.name, 'R02 campaign');
    assert.notEqual(unchanged.body.item.status, 'approved');
  } finally { await app.close(); }
});

test('R07/R08: dispatch preview and intent creation share contact and holdout policy', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    const owner = new TestClient(app.baseUrl);
    assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
    const unverified = await app.repository.createMember({ tenantId: 'ten_demo_01', storeId: 'sto_demo_01', externalMemberId: 'r07-unverified', displayName: 'Unverified', registeredAt: new Date().toISOString(), language: 'en', contact: null, contactHmac: 'r07-unverified-contact', publicAccessTokenHash: null, isSynthetic: true });
    const holdout = await app.repository.createMember({ tenantId: 'ten_demo_01', storeId: 'sto_demo_01', externalMemberId: 'r08-holdout', displayName: 'Holdout', registeredAt: new Date().toISOString(), language: 'en', contact: null, contactHmac: 'r08-holdout-contact', publicAccessTokenHash: null, isSynthetic: true });
    await app.repository.verifyMemberContact('ten_demo_01', holdout.id, 'r08-proof', new Date(Date.now() + 86_400_000).toISOString());
    for (const member of [unverified, holdout]) await app.repository.addConsent({ tenantId: 'ten_demo_01', memberId: member.id, channel: 'whatsapp', purpose: 'marketing', granted: true, noticeVersion: 'v1', source: 'audit-remediation' });
    const segment = await app.repository.createSegmentDefinition({ tenantId: 'ten_demo_01', name: 'R07/R08 segment', rule: 'marketing_opt_in', createdBy: 'usr_demo_owner', storeId: 'sto_demo_01' });
    const frozen = await app.repository.freezeAudience({ tenantId: 'ten_demo_01', segmentId: segment.id, storeId: 'sto_demo_01', holdoutPercent: 0, seed: 'audit-remediation' });
    await app.repository.mutate((state) => {
      const snapshot = state.audienceSnapshots.find((item) => item.id === frozen.snapshot.id)!;
      snapshot.memberIds = [unverified.id, holdout.id];
      snapshot.assignments = { [unverified.id]: 'treatment', [holdout.id]: 'holdout' };
    });
    const campaign = await app.repository.createOutreachCampaign({ tenantId: 'ten_demo_01', storeId: 'sto_demo_01', segmentId: segment.id, audienceSnapshotId: frozen.snapshot.id, channel: 'whatsapp', templateId: 'r07-approved', templateText: 'Approved remediation template', templateApproved: true, budgetMinor: 100, costPerAttemptMinor: 1, quietStartLocal: '00:00', quietEndLocal: '23:59', frequencyCapDays: 1, status: 'pending_approval', createdBy: 'usr_demo_owner' });
    const approved = await app.repository.approveOutreachCampaign(campaign.id, 'usr_demo_owner');
    const preview = app.repository.outreachExportPreview({ outreachId: campaign.id, tenantId: 'ten_demo_01', storeId: 'sto_demo_01' });
    assert.equal(preview.items.find((item) => item.memberId === unverified.id)?.status, 'skipped_unverified');
    assert.equal(preview.items.find((item) => item.memberId === holdout.id)?.status, 'skipped_holdout');
    for (const [memberId, code] of [[unverified.id, 'verified_contact_required'], [holdout.id, 'persistent_holdout']] as const) {
      const intent = await owner.request('/api/connectors/whatsapp/intents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 'sto_demo_01', member_id: memberId, template_name: 'r07-approved', approval_hash: approved.approvalHash, idempotency_key: `audit-${memberId}` }) });
      assert.equal(intent.response.status, 409);
      assert.equal(intent.body.intent.status, 'blocked');
      assert.equal(intent.body.intent.errorCode, code);
    }
  } finally { await app.close(); }
});
