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
