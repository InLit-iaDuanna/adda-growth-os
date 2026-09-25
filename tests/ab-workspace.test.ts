// Full-application integration tests. Included for execution after applying the
// patch to the complete checkout; NOT executed in the isolated source harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestApp, TestClient } from '../packages/testing/src/http';
import { JsonRepository } from '../packages/db/src/repository';

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('AB: control HTTP preserves explicit store scope and rejects missing tools', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    await app.repository.mutate(state => {
      const first = state.stores.find(s => s.id === 'sto_demo_01')!;
      state.stores.push({ ...first, id: 'sto_ab_second', slug: 'ab-second' });
      for (const membership of state.memberships.filter(m => m.tenantId === first.tenantId && m.role === 'OWNER')) membership.storeIds.push('sto_ab_second');
    });
    const client = new TestClient(app.baseUrl); await client.login('owner@demo.adda.local');
    const scoped = await client.request('/api/control/route', post({ skill: 'growth_analyst', prompt: '检查当前门店指标', store_id: 'sto_demo_01', allowed_tools: ['metric_query'], metric_queries: [{ metricKey: 'qualified_order_count' }] }));
    assert.equal(scoped.response.status, 200);
    assert.deepEqual(scoped.body.result.metricEvidence[0].storeIds, ['sto_demo_01']);
    const denied = await client.request('/api/control/route', post({ skill: 'event_planner', prompt: '检查活动事实', allowed_tools: [] }));
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.error_code, 'required_tool_not_granted');
    const invalid = await client.request('/api/control/route', post({ skill: 'event_planner', prompt: '检查活动事实', metric_queries: {} }));
    assert.equal(invalid.response.status, 400);
  } finally { await app.close(); }
});

test('AB: persisted checkpoints fence simultaneous commands and survive repository reload', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    const client = new TestClient(app.baseUrl); await client.login('owner@demo.adda.local');
    const input = { plan: 'content', prompt: '核对本店品牌和内容资料', store_id: 'sto_demo_01', request_key: randomUUID(), budget_minor: 0 };
    const created = await client.request('/api/control/runs', post(input));
    assert.equal(created.response.status, 200);
    const r = created.body.item;
    const duplicate = await client.request('/api/control/runs', post(input));
    assert.equal(duplicate.body.item.id, r.id);
    const results = await Promise.all([0, 1].map(() => client.request('/api/control/runs/' + r.id + '/advance', post({ expected_version: 1 }))));
    assert.deepEqual(results.map(v => v.response.status).sort(), [200, 409]);
    const disk = new JsonRepository(app.config.dataFile, app.config.mode); await disk.load();
    const saved = disk.snapshot().controlRuns!.find(v => v.id === r.id)!;
    assert.equal(saved.version, 2);
    assert.equal(saved.nodes[0].attempts, 1);
    assert.equal(saved.nodes[1].attempts, 0);
    assert.equal(saved.externalWrites, false);
    const completed = await client.request('/api/control/runs/' + r.id + '/advance', post({ expected_version: 2 }));
    assert.equal(completed.body.item.status, 'completed');
    assert.equal(completed.body.item.conclusion, 'needs_input');
    assert.equal(completed.body.item.actualCostMinor, 0);
  } finally { await app.close(); }
});

test('AB: new writes require session and CSRF; failed authentication changes nothing', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    const input = { plan: 'content', prompt: '检查资料', store_id: 'sto_demo_01', request_key: randomUUID() };
    const anonymous = new TestClient(app.baseUrl);
    const unauthenticated = await anonymous.request('/api/control/runs', post(input));
    assert.equal(unauthenticated.response.status, 401);
    const client = new TestClient(app.baseUrl); await client.login('owner@demo.adda.local'); client.csrf = 'deliberately-invalid';
    const badCsrf = await client.request('/api/control/runs', post(input));
    assert.equal(badCsrf.response.status, 403);
    await app.repository.load(); assert.equal(app.repository.snapshot().controlRuns?.length || 0, 0);
  } finally { await app.close(); }
});

test('AB: SSR installs A+B while preserving existing business routes and branding', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    const html = await (await fetch(app.baseUrl)).text();
    assert.match(html, /ab-workspace|installABWorkspace/);
    assert.match(html, /abWorkspaceCss|CONTROLLED EXECUTION/);
    for (const page of ['brand', 'campaigns', 'content', 'imports', 'crm', 'campus', 'voice', 'control']) assert.ok(html.includes('page-' + page));
    assert.ok(html.includes('/assets/brand/suiwu-lotus-mark.png'));
  } finally { await app.close(); }
});
