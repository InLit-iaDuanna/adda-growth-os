/** Validate the complete synthetic fixture without changing application data. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cp from '../dist/packages/domain/src/content-policy.js';
import cs from '../dist/packages/domain/src/control-service.js';
import rp from '../dist/packages/domain/src/report-policy.js';
import op from '../dist/packages/domain/src/outreach-policy.js';
import imp from '../dist/packages/domain/src/imports.js';

const { checkContentApproval } = cp;
const { queryMetrics } = cs;
const { canReadDailyReport } = rp;
const { outreachApprovalHash } = op;
const { parseMembersCsv, parseOrdersCsv, parseRefundsCsv } = imp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.resolve(process.argv.find((arg) => arg.startsWith('--fixture='))?.slice(10) || path.join(root, 'artifacts/test-data/complete-demo.json'));
const artifactDir = path.dirname(fixturePath);
const serverArg = process.argv.find((arg) => arg.startsWith('--server='));
const server = serverArg?.slice(9).replace(/\/$/, '');
const secret = 'local-complete-test-secret-change-me';
const state = JSON.parse(await readFile(fixturePath, 'utf8'));
const manifest = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'));
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const byteHash = (value) => createHash('sha256').update(value).digest('hex');
const couponToken = (memberId) => createHmac('sha256', secret).update(JSON.stringify(['coupon-v2', state.tenants[0].id, state.stores[0].id, state.offers[0].id, memberId])).digest('base64url');
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); }

await check('single synthetic tenant and store', () => {
  assert.equal(state.tenants.length, 1); assert.equal(state.tenants[0].mode, 'demo');
  assert.equal(state.stores.length, 1); assert.equal(state.stores[0].tenantId, state.tenants[0].id);
  assert.ok(state.members.every((member) => member.isSynthetic));
});
await check('real calculated metric snapshot', () => {
  const report = state.dailyReports[0];
  assert.equal(report.asOf, manifest.generated_at);
  const metric = Object.fromEntries(report.metrics.map((item) => [item.metricKey, item]));
  assert.equal(metric.net_revenue_minor.value, 64000);
  assert.equal(metric.qualified_order_count.value, 4);
  assert.equal(metric.identity_coverage.value, 0.75);
  assert.equal(metric.repeat_30d_rate.value, 0.5);
  assert.equal(metric.conversion_7d_rate.value, 1 / 3);
  assert.ok(report.metrics.every((item) => item.quality === 'verified'));
  assert.equal(canReadDailyReport(state, state.tenants[0].id, [state.stores[0].id], report), true);
  const queried = queryMetrics(state, { userId: 'usr_demo_owner', tenantId: state.tenants[0].id, role: 'OWNER', storeIds: [state.stores[0].id], sessionId: 'fixture-check' }, [{ metricKey: 'net_revenue_minor' }], report.asOf)[0];
  assert.equal(queried.value, metric.net_revenue_minor.value); assert.equal(queried.id, metric.net_revenue_minor.id);
});
await check('content approval is executable and draft is blocked', () => {
  const now = state.dailyReports[0].asOf;
  assert.deepEqual(checkContentApproval(state, state.contentApprovals[0], now), { ok: true, errors: [] });
  assert.equal(state.contentRevisions.find((item) => item.id === 'content_rev_draft').status, 'needs_local_review');
  assert.ok(state.contentRevisions.find((item) => item.id === 'content_rev_draft').packageData.needs_input.length);
});
await check('approved asset checksums bind to image bytes', async () => {
  const assets = new Map(state.mediaAssets.map((item) => [item.id, item]));
  for (const [id, file] of [['asset_lotus_water', '4da38778134ae0fc6f4fb0046521903b.jpg'], ['asset_suiwu_logo', '99b0b4ec1602cc2760ffed5944b53444.jpg']]) {
    const bytes = await readFile(path.join(artifactDir, 'assets', 'originals', file));
    assert.equal(assets.get(id)?.checksum, byteHash(bytes));
  }
  assert.equal(assets.get('asset_needs_confirmation')?.checksum, null);
});
await check('source and attribution timelines are causally ordered', async () => {
  const links = new Map(state.sourceLinks.map((item) => [item.id, item]));
  const campaign = state.campaigns.find((item) => item.id === 'camp_spring_wellness');
  for (const touch of state.touchEvents) {
    const link = links.get(touch.sourceLinkId);
    assert.ok(link && Date.parse(link.createdAt) <= Date.parse(touch.occurredAt));
    assert.ok(!campaign || Date.parse(campaign.startAt) <= Date.parse(touch.occurredAt));
  }
  for (const attribution of state.attributionEvidence) {
    const order = state.orders.find((item) => item.id === attribution.orderId);
    assert.ok(order && Date.parse(attribution.occurredAt) <= Date.parse(order.paidAt));
    if (attribution.method === 'linked_first_party_touch') assert.ok(Date.parse(order.paidAt) - Date.parse(attribution.occurredAt) <= 7 * 86_400_000);
  }
  const pending = state.issuedCoupons.find((item) => item.id === 'coupon_rina_001');
  assert.equal(pending?.status, 'pending_pos_verification');
  assert.equal(state.attributionEvidence.find((item) => item.orderId === 'ord_rina_001')?.method, 'linked_first_party_touch');
});
await check('cashier scenarios keep positive and mismatch members distinct', async () => {
  const scenarios = JSON.parse(await readFile(path.join(artifactDir, 'scenarios.json'), 'utf8'));
  const order = state.orders.find((item) => item.externalOrderId === scenarios.cashier.authoritative_order);
  const positive = state.issuedCoupons.find((item) => item.id === scenarios.cashier.pending_coupon);
  const mismatch = state.issuedCoupons.find((item) => item.id === scenarios.cashier.member_mismatch_coupon);
  assert.equal(positive?.memberId, order?.memberId);
  assert.notEqual(mismatch?.memberId, order?.memberId);
  assert.equal(scenarios.cashier.member_mismatch_expected, 'member_mismatch');
});
await check('pending reply has no executable manual task', () => {
  const pending = state.replyRevisions.find((item) => item.id === 'reply_routine_01');
  assert.equal(pending?.status, 'pending_approval');
  assert.equal(state.voiceTasks.some((task) => task.replyRevisionId === pending?.id), false);
  const allowedMetrics = new Set(['orders_count', 'qualified_order_count', 'revenue_minor', 'net_revenue_minor', 'aov_minor', 'average_order_value_minor', 'identity_coverage', 'repeat_purchase_rate', 'repeat_30d_rate', 'mature_30d_cohort_count', 'mature_30d_repeat_rate', 'conversion_7d_rate']);
  assert.ok(state.contentBriefs.every((brief) => allowedMetrics.has(brief.targetMetric)));
});
await check('coupon and outreach hashes match runtime contracts', () => {
  for (const [memberId, couponId] of [['member_ana', 'coupon_ana_001'], ['member_rina', 'coupon_rina_001'], ['member_noor', 'coupon_noor_001']]) {
    const coupon = state.issuedCoupons.find((item) => item.id === couponId);
    assert.equal(coupon.tokenHash, createHmac('sha256', secret).update(couponToken(memberId)).digest('hex'));
  }
  const campaign = state.outreachCampaigns[0];
  assert.equal(campaign.approvalHash, outreachApprovalHash(campaign, state.audienceSnapshots[0], 1));
});
await check('CSV rows are parseable and hashes are bound to the snapshot', async () => {
  const [members, orders, refunds] = await Promise.all(['members.csv', 'orders.csv', 'refunds.csv'].map((file) => readFile(path.join(artifactDir, file), 'utf8')));
  assert.ok(parseMembersCsv(members).rows.every((row) => row.value && !row.errors.length));
  assert.ok(parseOrdersCsv(orders).rows.every((row) => row.value && !row.errors.length));
  assert.ok(parseRefundsCsv(refunds).rows.every((row) => row.value && !row.errors.length));
  assert.equal(state.imports.find((item) => item.id === 'import_orders_complete').fileHash, hash(orders));
  assert.equal(state.imports.find((item) => item.id === 'import_refunds_complete').fileHash, hash(refunds));
});
await check('durable agent runs are completed read-only runs', () => {
  assert.deepEqual(state.controlRuns.map((run) => run.plan).sort(), ['campus', 'content', 'growth', 'voice']);
  assert.ok(state.controlRuns.every((run) => run.status === 'completed' && run.externalWrites === false && run.actualCostMinor === 0));
});
await check('no inherited environment secret is serialized', () => {
  assert.equal(manifest.app_start.SESSION_SECRET, secret);
  assert.equal(state.externalWritesKillSwitch, true);
  assert.ok(!JSON.stringify(manifest).includes(process.env.SESSION_SECRET || '\u0000'));
});

async function httpCheck() {
  if (!server) return;
  const client = async (email) => {
    let cookie = '';
    const request = async (pathname, init = {}) => {
      const headers = { ...(init.headers || {}) };
      if (cookie) headers.cookie = cookie;
      if (init.body) headers['content-type'] = 'application/json';
      const response = await fetch(server + pathname, { ...init, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { response, body };
    };
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'demo-only-password' }) });
    assert.equal(login.response.status, 200); return { request, csrf: login.body.csrf_token };
  };
  for (const email of ['owner@demo.adda.local', 'reviewer@demo.adda.local', 'cashier@demo.adda.local']) {
    const user = await client(email);
    const me = await user.request('/api/me'); assert.equal(me.response.status, 200);
    const content = await user.request('/api/content'); assert.equal(content.response.status, 200);
  }
  const owner = await client('owner@demo.adda.local');
  const reports = await owner.request('/api/reports/daily'); assert.equal(reports.response.status, 200); assert.equal(reports.body.items.length, 1);
  const publicOffers = await owner.request('/api/public/offers?source_token=' + encodeURIComponent(manifest.raw_tokens.source_links.campus));
  assert.equal(publicOffers.response.status, 200); assert.equal(publicOffers.body.items.length, 1);
  checks.push('three role logins and HTTP surfaces');
}
await httpCheck();
const evidence = { schema_version: 1, recorded_at: new Date().toISOString(), fixture: fixturePath, synthetic_only: true, server: server || null, checks, notes: ['Metrics are computed from the fixture snapshot.', 'No external connector or publication write was attempted.'] };
await writeFile(path.join(artifactDir, 'validation.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
