import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRepository } from '../packages/db/src/repository';
import { startTestApp, TestClient, type RunningTestApp } from '../packages/testing/src/http';
import type { DatabaseState } from '../packages/domain/src/types';
import { queryMetrics } from '../packages/domain/src/control-service';
import { outreachBudget } from '../packages/domain/src/outreach-ledger';

const tenantId = 'ten_demo_01';
const storeId = 'sto_demo_01';
const userId = 'usr_demo_owner';
const asOf = '2026-03-01T00:00:00.000Z';
const post = (client: TestClient, url: string, body = {}) => client.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function setup(t: TestContext) {
  const app = await startTestApp({ seedDemo: true });
  t.after(() => app.close());
  const owner = new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status, 200);
  return { app, owner };
}

async function content(owner: TestClient) {
  const brand = await post(owner, '/api/brand/documents', { source_type: 'form', source_label: 'audit synthetic', content: JSON.stringify({ brand_name: 'ADDA TEA' }) });
  assert.equal((await post(owner, `/api/brand/revisions/${brand.body.revision.id}/approve`)).response.status, 200);
  const product = await post(owner, '/api/products', { store_id: storeId, external_sku: 'AUDIT', names: { en: 'Milk Tea' } });
  const productId = product.body.item.id as string;
  assert.equal((await price(owner, productId)).response.status, 201);
  const asset = await post(owner, '/api/media-assets', { store_id: storeId, storage_key: 'synthetic/audit.jpg', checksum: 'audit', rights_status: 'approved', allowed_uses: ['organic_social'] });
  const campaign = await post(owner, '/api/campaigns', { name: 'Audit content', objective: 'orders', store_id: storeId, product_ids: [productId], asset_ids: [asset.body.item.id] });
  const generated = await post(owner, '/api/content/generate', { campaign_id: campaign.body.item.id });
  assert.equal(generated.response.status, 201);
  const revisionId = generated.body.revision.id as string;
  assert.equal((await post(owner, `/api/content/${revisionId}/review-bn`)).response.status, 200);
  return { productId, revisionId };
}

function price(owner: TestClient, productId: string, amountMinor = 15000) {
  return post(owner, `/api/products/${productId}/prices`, { amount_minor: amountMinor, currency: 'BDT', status: 'approved', source_citation: 'synthetic audit price' });
}

async function approve(owner: TestClient, revisionId: string) {
  const submitted = await post(owner, '/api/content/submit', { revision_id: revisionId });
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.body));
  assert.equal((await post(owner, `/api/approvals/${submitted.body.approval.id}/approve`)).response.status, 200);
  return submitted.body.approval.id as string;
}

function seedOrders(state: DatabaseState, selectedStore: string, amount: number, currency = 'BDT') {
  const id = `order-${selectedStore}`;
  state.orders.push({ id, tenantId, storeId: selectedStore, source: 'pos', externalOrderId: id, memberId: null, paidAt: '2026-02-01T00:00:00Z', currency, amountPaidMinor: amount, status: 'paid', revision: 1, sourceRowHash: id, active: true, correctionOfId: null, createdAt: asOf, updatedAt: asOf });
  state.imports.push({ id: `import-${selectedStore}`, tenantId, storeId: selectedStore, kind: 'orders', source: 'pos', fileName: 'synthetic.csv', fileHash: id, status: 'committed', rowCount: 1, validRowCount: 1, errorCount: 0, completeThrough: asOf, createdBy: userId, createdAt: asOf, committedAt: asOf });
}

async function secondStore(app: RunningTestApp, currency = 'BDT') {
  const store = await app.repository.createStore({ tenantId, slug: 'audit-b', name: 'Synthetic B', timezone: 'Asia/Dhaka', currency, status: 'active' });
  await app.repository.mutate(state => { state.memberships.find(m => m.userId === userId)!.storeIds.push(store.id); });
  return store.id;
}

async function outreach(app: RunningTestApp, verified = true, count = 1) {
  const members = [];
  for (let i = 0; i < count; i++) {
    const member = await app.repository.createMember({ tenantId, storeId, externalMemberId: `audit-${i}`, displayName: null, registeredAt: new Date().toISOString(), language: 'en', contact: null, contactHmac: `audit-contact-${i}`, publicAccessTokenHash: null, isSynthetic: true });
    if (verified) await app.repository.verifyMemberContact(tenantId, member.id, 'synthetic-proof', new Date(Date.now() + 86400000).toISOString());
    await app.repository.addConsent({ tenantId, memberId: member.id, channel: 'whatsapp', purpose: 'marketing', granted: true, noticeVersion: 'v1', source: 'audit' });
    members.push(member);
  }
  const segment = await app.repository.createSegmentDefinition({ tenantId, storeId, name: 'Audit audience', rule: 'marketing_opt_in', createdBy: userId });
  const frozen = await app.repository.freezeAudience({ tenantId, storeId, segmentId: segment.id, holdoutPercent: 0, seed: 'audit' });
  const campaign = await app.repository.createOutreachCampaign({ tenantId, storeId, segmentId: segment.id, audienceSnapshotId: frozen.snapshot.id, channel: 'whatsapp', templateId: 'audit-approved', templateText: 'Synthetic approved template', templateApproved: true, budgetMinor: 1, costPerAttemptMinor: 1, quietStartLocal: '00:00', quietEndLocal: '23:59', frequencyCapDays: 1, status: 'pending_approval', createdBy: userId });
  const approved = await app.repository.approveOutreachCampaign(campaign.id, userId);
  await app.repository.setConnectorState({ tenantId, provider: 'whatsapp', mode: 'demo', status: 'active', enabled: true, killSwitch: false, capabilities: { readMetrics: false, reply: false, sendTemplate: true }, reason: 'synthetic offline', checkedAt: new Date().toISOString() });
  return { campaign: approved, members };
}

test('N01: a price changed after generation cannot be rebound at submission', async t => {
  const { owner, app } = await setup(t);
  const { revisionId, productId } = await content(owner);
  assert.match(JSON.stringify(app.repository.findContentRevision(revisionId)!.packageData), /150/);
  assert.equal((await price(owner, productId, 20000)).response.status, 201);
  const submit = await post(owner, '/api/content/submit', { revision_id: revisionId });
  assert.equal(submit.response.status, 409);
  assert.equal(submit.body.error_code, 'price_version_changed');
  assert.equal(app.repository.snapshot().contentApprovals.length, 0);
});

test('N02: another repository changes price at the export boundary; no intent is written', async t => {
  const { owner, app } = await setup(t);
  const { revisionId, productId } = await content(owner);
  await approve(owner, revisionId);
  const other = new JsonRepository(app.repository.filePath, 'test');
  await other.load();
  const original = app.repository.createPublicationIntent.bind(app.repository);
  app.repository.createPublicationIntent = async input => {
    await other.addPriceVersion({ tenantId, productId, amountMinor: 20000, currency: 'BDT', status: 'approved', sourceCitation: 'concurrent synthetic change', validFrom: '2025-01-01T00:00:00Z', validTo: null, createdBy: userId });
    return original(input);
  };
  const result = await post(owner, '/api/content/export', { revision_id: revisionId });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error_code, 'price_version_changed');
  assert.equal((await app.repository.load()).publicationIntents.length, 0);
});

test('N03: reports and tasks require access to every contributing store', async t => {
  const { app, owner } = await setup(t);
  const b = await secondStore(app);
  await app.repository.mutate(state => { seedOrders(state, storeId, 1000); seedOrders(state, b, 99000); });
  const aggregate = await post(owner, '/api/reports/daily', { as_of: asOf });
  assert.equal(aggregate.response.status, 201);
  const task = await app.repository.createControlTask({ tenantId, storeIds: [storeId, b], ownerUserId: userId, title: 'Both stores', dueAt: asOf, targetMetric: 'net_revenue_minor', budgetMinor: null, guardrails: [], evidenceRefs: [`order-${b}`] });
  const reviewer = new TestClient(app.baseUrl);
  await reviewer.login('reviewer@demo.adda.local');
  assert.equal((await reviewer.request(`/api/reports/daily?store_id=${b}`)).response.status, 404);
  const visible = await reviewer.request('/api/reports/daily');
  assert.equal(visible.response.status, 200);
  assert.ok(!visible.body.items.some((r: { id: string }) => r.id === aggregate.body.report.id));
  assert.ok(!JSON.stringify(visible.body).includes(b));
  assert.ok(!visible.body.tasks.some((r: { id: string }) => r.id === task.id));
  const denied = await post(reviewer, `/api/control-tasks/${task.id}/complete`, { evidence: 'not authorized' });
  assert.notEqual(denied.response.status, 200);
  assert.equal(app.repository.snapshot().controlTasks.find(r => r.id === task.id)!.status, 'open');
  assert.equal((await owner.request('/api/reports/daily')).body.items.length, 1);
});

test('N04: ordinary metrics and queryMetrics both reject mixed currencies', async t => {
  const { app, owner } = await setup(t);
  const b = await secondStore(app, 'USD');
  await app.repository.mutate(state => { seedOrders(state, storeId, 1000); seedOrders(state, b, 99000, 'USD'); });
  const actor = { tenantId, userId, role: 'OWNER' as const, sessionId: 'test', storeIds: [storeId, b] };
  assert.throws(() => queryMetrics(app.repository.snapshot(), actor, [{ metricKey: 'net_revenue_minor' }], asOf), /mixed_store_currency_or_timezone/);
  const result = await owner.request(`/api/metrics?as_of=${asOf}`);
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error_code, 'mixed_store_currency_or_timezone_requires_single_store');
  assert.equal((await owner.request(`/api/metrics?store_id=${storeId}&as_of=${asOf}`)).response.status, 200);
});

test('N05: an entirely missing store prevents a verified aggregate', async t => {
  const { app, owner } = await setup(t);
  const b = await secondStore(app);
  await app.repository.mutate(state => seedOrders(state, storeId, 1000));
  const missing = await owner.request(`/api/metrics?store_id=${b}&as_of=${asOf}`);
  assert.equal(missing.body.quality, 'missing');
  const aggregate = await owner.request(`/api/metrics?as_of=${asOf}`);
  assert.equal(aggregate.body.summary.quality, 'provisional');
  const actor = { tenantId, userId, role: 'OWNER' as const, sessionId: 'test', storeIds: [storeId, b] };
  assert.equal(queryMetrics(app.repository.snapshot(), actor, [{ metricKey: 'net_revenue_minor' }], asOf)[0].quality, 'provisional');
});

test('N06: different request keys cannot reserve the same business delivery repeatedly', async t => {
  const { app, owner } = await setup(t);
  const { campaign, members } = await outreach(app);
  const ids = [];
  for (const key of ['n06-a', 'n06-b', 'n06-c']) {
    const result = await post(owner, '/api/connectors/whatsapp/intents', { store_id: storeId, member_id: members[0].id, template_name: campaign.templateId, approval_hash: campaign.approvalHash, idempotency_key: key });
    assert.equal(result.body.intent.status, 'pending');
    ids.push(result.body.intent.id);
  }
  assert.equal(new Set(ids).size, 1);
  assert.equal(app.repository.snapshot().deliveryIntents.length, 1);
  const preview = app.repository.outreachExportPreview({ tenantId, storeId, outreachId: campaign.id });
  assert.notEqual(preview.items[0].status, 'eligible');
});

test('N07: new explicit retry reevaluates unsent members and keeps prior attempt history', async t => {
  const { app } = await setup(t);
  const { campaign, members } = await outreach(app, false);
  const input = { tenantId, storeId, outreachId: campaign.id, allowTestOutbox: true, now: new Date().toISOString() };
  const first = await app.repository.dispatchOutreach({ ...input, idempotencyKey: 'first' });
  assert.equal(first.attempts[0].status, 'skipped_unverified');
  await app.repository.verifyMemberContact(tenantId, members[0].id, 'synthetic-proof', new Date(Date.now() + 86400000).toISOString());
  assert.equal(app.repository.outreachExportPreview(input).items[0].status, 'eligible');
  assert.equal((await app.repository.dispatchOutreach({ ...input, idempotencyKey: 'first' })).attempts[0].id, first.attempts[0].id);
  const retry = await app.repository.dispatchOutreach({ ...input, idempotencyKey: 'explicit-retry' });
  assert.equal(retry.attempts[0].status, 'sent_test');
  assert.notEqual(first.campaign.status, 'completed');
  assert.equal(app.repository.snapshot().messageAttempts.length, 2);
  const duplicate = await app.repository.dispatchOutreach({ ...input, idempotencyKey: 'do-not-send-again' });
  assert.equal(duplicate.attempts[0].id, retry.attempts[0].id);
  assert.equal(app.repository.snapshot().messageAttempts.length, 2);
});

test('N08: renewed approval replaces expired approval without changing or re-reviewing content', async t => {
  const { app, owner } = await setup(t);
  const { revisionId } = await content(owner);
  const oldId = await approve(owner, revisionId);
  await app.repository.mutate(state => { state.contentApprovals.find(a => a.id === oldId)!.expiresAt = '2020-01-01T00:00:00Z'; });
  const newId = await approve(owner, revisionId);
  assert.equal(app.repository.validateContentExecution(newId).ok, true);
  const exported = await post(owner, '/api/content/export', { revision_id: revisionId });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.body.intent.approval_id, newId);
});

test('N01/N02: approval also rechecks generation facts inside the write lock', async t => {
  const { app, owner } = await setup(t);
  const { revisionId, productId } = await content(owner);
  const submitted = await post(owner, '/api/content/submit', { revision_id: revisionId });
  assert.equal(submitted.response.status, 201);
  const other = new JsonRepository(app.repository.filePath, 'test');
  await other.load();
  const approveOriginal = app.repository.approveContent.bind(app.repository);
  app.repository.approveContent = async (...args) => {
    await other.addPriceVersion({ tenantId, productId, amountMinor: 20000, currency: 'BDT', status: 'approved', sourceCitation: 'concurrent synthetic change', validFrom: '2025-01-01T00:00:00Z', validTo: null, createdBy: userId });
    return approveOriginal(...args);
  };
  const approved = await post(owner, `/api/approvals/${submitted.body.approval.id}/approve`);
  assert.equal(approved.response.status, 409);
  assert.equal(approved.body.error_code, 'price_version_changed');
  assert.equal((await app.repository.load()).contentApprovals[0].status, 'pending');
});

test('N01: legacy content without generation provenance cannot acquire a fresh approval', async t => {
  const { app, owner } = await setup(t);
  const { revisionId } = await content(owner);
  await app.repository.mutate(state => { delete state.contentRevisions.find(r => r.id === revisionId)!.generationFacts; });
  const result = await post(owner, '/api/content/submit', { revision_id: revisionId });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error_code, 'generation_facts_missing');
});

test('N02: exported payload is the transaction snapshot even if content changes before the HTTP response', async t => {
  const { app, owner } = await setup(t);
  const { revisionId } = await content(owner);
  await approve(owner, revisionId);
  const originalData = structuredClone(app.repository.findContentRevision(revisionId)!.packageData);
  const original = app.repository.createPublicationIntent.bind(app.repository);
  app.repository.createPublicationIntent = async input => {
    const intent = await original(input);
    await app.repository.updateContentRevision(revisionId, { ...originalData, operator_notes_zh: 'later edit' }, userId);
    return intent;
  };
  const exported = await post(owner, '/api/content/export', { revision_id: revisionId });
  assert.equal(exported.response.status, 200);
  assert.deepEqual(exported.body.package, originalData);
  assert.deepEqual(app.repository.snapshot().publicationIntents[0].packageData, originalData);
});

test('N03: authorized single-store reports survive; incomplete or mislabeled scope is hidden', async t => {
  const { app, owner } = await setup(t);
  const b = await secondStore(app);
  await app.repository.mutate(state => { seedOrders(state, storeId, 1000); seedOrders(state, b, 99000); });
  const single = await post(owner, '/api/reports/daily', { store_id: storeId, as_of: asOf });
  const aggregate = await post(owner, '/api/reports/daily', { as_of: asOf });
  await app.repository.mutate(state => { state.dailyReports.find(r => r.id === aggregate.body.report.id)!.storeIds = [storeId]; });
  const reviewer = new TestClient(app.baseUrl);
  await reviewer.login('reviewer@demo.adda.local');
  const visible = await reviewer.request('/api/reports/daily');
  assert.deepEqual(visible.body.items.map((r: { id: string }) => r.id), [single.body.report.id]);
  assert.ok(!JSON.stringify(visible.body).includes(b));
  await app.repository.mutate(state => { state.dailyReports[0].storeIds = []; });
  assert.equal((await reviewer.request('/api/reports/daily')).body.items.length, 0);
});

test('N04: mixed timezones are rejected even when every store uses BDT', async t => {
  const { app, owner } = await setup(t);
  const b = await secondStore(app);
  await app.repository.mutate(state => { state.stores.find(s => s.id === b)!.timezone = 'UTC'; });
  const result = await owner.request(`/api/metrics?as_of=${asOf}`);
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error_code, 'mixed_store_currency_or_timezone_requires_single_store');
});

test('N05: explicit empty order import confirms zero; an expected missing source still blocks verification', async t => {
  const { app, owner } = await setup(t);
  const b = await secondStore(app);
  await app.repository.mutate(state => seedOrders(state, storeId, 1000));
  const emptyCsv = 'tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\n';
  const staged = await post(owner, '/api/imports/preview', { kind: 'orders', source: 'pos', store_id: b, file_name: 'confirmed-empty.csv', content: emptyCsv, complete_through: asOf });
  assert.equal(staged.response.status, 201);
  assert.equal((await post(owner, `/api/imports/${staged.body.import.id}/commit`)).response.status, 200);
  const zero = await owner.request(`/api/metrics?store_id=${b}&as_of=${asOf}`);
  assert.equal(zero.body.summary.quality, 'verified');
  assert.equal(zero.body.items.find((m: { metric_key: string }) => m.metric_key === 'net_revenue_minor').value, 0);
  assert.equal(zero.body.summary.source_coverage[0].status, 'confirmed_zero');
  assert.equal((await owner.request(`/api/metrics?as_of=${asOf}`)).body.summary.quality, 'verified');
  await app.repository.mutate(state => { state.stores.find(s => s.id === b)!.orderSources = ['pos', 'delivery-app']; });
  const partial = await owner.request(`/api/metrics?as_of=${asOf}`);
  assert.equal(partial.body.summary.quality, 'provisional');
  assert.ok(partial.body.summary.source_coverage.some((s: { source: string; status: string }) => s.source === 'delivery-app' && s.status === 'not_imported'));
});

test('N06: concurrent repositories reserve one budget unit, shared with G06 dispatch', async t => {
  const { app } = await setup(t);
  const { campaign, members } = await outreach(app, true, 2);
  const other = new JsonRepository(app.repository.filePath, 'test');
  await other.load();
  const input = { tenantId, storeId, provider: 'whatsapp' as const, templateName: campaign.templateId, approvalHash: campaign.approvalHash!, createdBy: userId };
  const intents = await Promise.all([app.repository.createDeliveryIntent({ ...input, memberId: members[0].id, idempotencyKey: 'concurrent-a' }), other.createDeliveryIntent({ ...input, memberId: members[1].id, idempotencyKey: 'concurrent-b' })]);
  assert.deepEqual(intents.map(i => i.status).sort(), ['blocked', 'pending']);
  const state = await app.repository.load();
  assert.deepEqual(outreachBudget(state, campaign), { reservedMinor: 1, consumedMinor: 0, availableMinor: 0, unknownBindings: 0 });
  const dispatch = await app.repository.dispatchOutreach({ tenantId, storeId, outreachId: campaign.id, allowTestOutbox: true, idempotencyKey: 'g06-after-g09' });
  assert.ok(dispatch.attempts.every(a => a.status !== 'sent_test'));
  assert.equal(outreachBudget(app.repository.snapshot(), campaign).reservedMinor, 1);
});

test('N06: unknown delivery keeps its reservation and cannot be retried with another request key', async t => {
  const { app } = await setup(t);
  const { campaign, members } = await outreach(app, true, 2);
  const input = { tenantId, storeId, provider: 'whatsapp' as const, templateName: campaign.templateId, approvalHash: campaign.approvalHash!, createdBy: userId, memberId: members[0].id };
  const first = await app.repository.createDeliveryIntent({ ...input, idempotencyKey: 'unknown-first' });
  await app.repository.markDeliveryUnknown(first.id, tenantId);
  const retry = await app.repository.createDeliveryIntent({ ...input, idempotencyKey: 'unknown-retry' });
  assert.equal(retry.id, first.id);
  assert.equal(retry.status, 'unknown_delivery');
  await assert.rejects(app.repository.createDeliveryIntent({ ...input, memberId: members[1].id, idempotencyKey: 'unknown-retry' }), /idempotency_key_conflict/);
  const second = await app.repository.createDeliveryIntent({ ...input, memberId: members[1].id, idempotencyKey: 'unknown-other-member' });
  assert.equal(second.status, 'blocked');
  assert.equal(second.errorCode, 'budget_exhausted');
  assert.equal(outreachBudget(app.repository.snapshot(), campaign).reservedMinor, 1);
  assert.equal(app.repository.findOutreachCampaign(campaign.id)!.status, 'blocked');
});

test('N06/N07: blocked intents reserve nothing; an explicit retry can recover after verification', async t => {
  const { app } = await setup(t);
  const { campaign, members } = await outreach(app, false);
  const input = { tenantId, storeId, provider: 'whatsapp' as const, templateName: campaign.templateId, approvalHash: campaign.approvalHash!, createdBy: userId, memberId: members[0].id };
  const blocked = await app.repository.createDeliveryIntent({ ...input, idempotencyKey: 'unverified-first' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(outreachBudget(app.repository.snapshot(), campaign).reservedMinor, 0);
  await app.repository.verifyMemberContact(tenantId, members[0].id, 'proof', new Date(Date.now() + 86400000).toISOString());
  assert.equal((await app.repository.createDeliveryIntent({ ...input, idempotencyKey: 'unverified-first' })).id, blocked.id);
  const retried = await app.repository.createDeliveryIntent({ ...input, idempotencyKey: 'verified-retry' });
  assert.equal(retried.status, 'pending');
  assert.equal(outreachBudget(app.repository.snapshot(), campaign).reservedMinor, 1);
});

test('N06: pending provider intents apply frequency limits to other campaigns', async t => {
  const { app } = await setup(t);
  const { campaign, members } = await outreach(app);
  await app.repository.createDeliveryIntent({ tenantId, storeId, provider: 'whatsapp', templateName: campaign.templateId, approvalHash: campaign.approvalHash!, createdBy: userId, memberId: members[0].id, idempotencyKey: 'frequency-first' });
  const next = await app.repository.createOutreachCampaign({ ...campaign, status: 'pending_approval', approvalHash: null });
  const approved = await app.repository.approveOutreachCampaign(next.id, userId);
  const preview = app.repository.outreachExportPreview({ tenantId, storeId, outreachId: next.id });
  assert.equal(preview.items[0].status, 'skipped_frequency');
  const result = await app.repository.createDeliveryIntent({ tenantId, storeId, provider: 'whatsapp', templateName: next.templateId, approvalHash: approved.approvalHash!, createdBy: userId, memberId: members[0].id, idempotencyKey: 'frequency-second' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'frequency_cap');
});

test('N01: editing copy cannot refresh generation facts or retain the previous language review', async t => {
  const { app, owner } = await setup(t);
  const { revisionId, productId } = await content(owner);
  await price(owner, productId, 20000);
  const data = app.repository.findContentRevision(revisionId)!.packageData;
  await app.repository.updateContentRevision(revisionId, { ...data, operator_notes_zh: 'editorial change' }, userId);
  assert.equal((await post(owner, '/api/content/submit', { revision_id: revisionId })).body.error_code, 'bn_review_required');
  await post(owner, `/api/content/${revisionId}/review-bn`);
  assert.equal((await post(owner, '/api/content/submit', { revision_id: revisionId })).body.error_code, 'price_version_changed');
  const generated = await post(owner, '/api/content/generate', { campaign_id: data.campaign_id });
  assert.equal(generated.response.status, 201);
  await post(owner, `/api/content/${generated.body.revision.id}/review-bn`);
  await approve(owner, generated.body.revision.id);
  const exported = await post(owner, '/api/content/export', { revision_id: generated.body.revision.id });
  assert.equal(exported.response.status, 200);
  assert.match(JSON.stringify(exported.body.package), /200/);
});

test('N06: changing approval cancels unsent reservations and preserves consumed cost', async t => {
  const { app } = await setup(t);
  const { campaign, members } = await outreach(app);
  const input = { tenantId, storeId, provider: 'whatsapp' as const, memberId: members[0].id, templateName: campaign.templateId, createdBy: userId };
  const pending = await app.repository.createDeliveryIntent({ ...input, approvalHash: campaign.approvalHash!, idempotencyKey: 'before-change' });
  await app.repository.updateOutreachCampaign(campaign.id, tenantId, { budgetMinor: 10, costPerAttemptMinor: 2 });
  const approved = await app.repository.approveOutreachCampaign(campaign.id, userId);
  assert.equal(app.repository.findDeliveryIntent(pending.id, tenantId)!.status, 'blocked');
  assert.equal(outreachBudget(app.repository.snapshot(), approved).reservedMinor, 0);
  const renewed = await app.repository.createDeliveryIntent({ ...input, approvalHash: approved.approvalHash!, idempotencyKey: 'after-change' });
  assert.equal(renewed.costMinor, 2);
  await app.repository.processWebhook({ tenantId, provider: 'whatsapp', providerEventId: 'synthetic-delivered', providerMessageId: renewed.id, status: 'delivered', occurredAt: new Date().toISOString() });
  assert.equal(app.repository.findOutreachCampaign(campaign.id)!.status, 'completed');
  await app.repository.updateOutreachCampaign(campaign.id, tenantId, { costPerAttemptMinor: 7 });
  const updated = await app.repository.approveOutreachCampaign(campaign.id, userId);
  assert.equal(outreachBudget(app.repository.snapshot(), updated).consumedMinor, 2);
});

test('N06: stopping an accepted delivery preserves an unknown reservation', async t => {
  const { app } = await setup(t);
  const { campaign, members } = await outreach(app);
  const intent = await app.repository.createDeliveryIntent({ tenantId, storeId, provider: 'whatsapp', memberId: members[0].id, templateName: campaign.templateId, approvalHash: campaign.approvalHash!, createdBy: userId, idempotencyKey: 'accepted-before-stop' });
  await app.repository.processWebhook({ tenantId, provider: 'whatsapp', providerEventId: 'synthetic-accepted', providerMessageId: intent.id, status: 'accepted', occurredAt: new Date().toISOString() });
  await app.repository.setGlobalKillSwitch(true);
  assert.equal(app.repository.findDeliveryIntent(intent.id, tenantId)!.status, 'unknown_delivery');
  assert.equal(outreachBudget(app.repository.snapshot(), campaign).reservedMinor, 1);
});

test('N07: explicit retry after quiet hours uses current policy, while replay keeps the earlier result', async t => {
  const { app } = await setup(t);
  const { campaign } = await outreach(app);
  await app.repository.updateOutreachCampaign(campaign.id, tenantId, { quietStartLocal: '09:00', quietEndLocal: '21:00' });
  await app.repository.approveOutreachCampaign(campaign.id, userId);
  const day = new Date().toISOString().slice(0, 10);
  const input = { tenantId, storeId, outreachId: campaign.id, allowTestOutbox: true };
  const first = await app.repository.dispatchOutreach({ ...input, now: `${day}T00:00:00.000Z`, idempotencyKey: 'too-early' });
  assert.equal(first.attempts[0].status, 'skipped_quiet_hours');
  const retry = await app.repository.dispatchOutreach({ ...input, now: `${day}T06:00:00.000Z`, idempotencyKey: 'send-window' });
  assert.equal(retry.attempts[0].status, 'sent_test');
  const replay = await app.repository.dispatchOutreach({ ...input, now: `${day}T06:00:00.000Z`, idempotencyKey: 'too-early' });
  assert.equal(replay.attempts[0].id, first.attempts[0].id);
  assert.equal((retry.report.treatment as { sent: number }).sent, 1);
  assert.equal(outreachBudget(app.repository.snapshot(), campaign).consumedMinor, 1);
});
