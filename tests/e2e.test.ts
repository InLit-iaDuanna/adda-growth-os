import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TestClient } from '../packages/testing/src/http';

const apps: Awaited<ReturnType<typeof startTestApp>>[] = [];
after(async () => { for (const app of apps) await app.close(); });

test('A01: a fresh production database shows onboarding and no demo business data', async () => {
  const app = await startTestApp({ mode: 'production' });
  apps.push(app);
  const client = new TestClient(app.baseUrl);
  const health = await client.request('/api/healthz');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.mode, 'production');
  assert.equal(health.body.demo, false);
  assert.equal(health.body.has_business_data, false);
  assert.deepEqual(health.body.missing_configuration, ['brand_profile', 'store', 'menu', 'owner_invitation']);
  const page = await client.request('/');
  assert.match(page.body, /空生产库/);
  assert.doesNotMatch(page.body, /210000/);
  const login = await client.login('owner@demo.adda.local');
  assert.equal(login.response.status, 401);
});

test('A57: admin and consumer shells expose required language choices and mobile viewport', async () => {
  const app = await startTestApp({ seedDemo: true });
  apps.push(app);
  const client = new TestClient(app.baseUrl);
  const admin = await client.request('/');
  assert.match(admin.body, /zh-CN/);
  assert.match(admin.body, /English/);
  assert.match(admin.body, /SUIWU 随物/);
  assert.match(admin.body, /suiwu-lotus-mark\.png/);
  assert.match(admin.body, /4da38778134ae0fc6f4fb0046521903b\.jpg/);
  assert.match(admin.body, /width=device-width/);
  const consumer = await client.request('/s/du-gate-demo/join');
  assert.match(consumer.body, /English/);
  assert.match(consumer.body, /বাংলা/);
  assert.match(consumer.body, /SUIWU 随物旗下品牌/);
  assert.match(consumer.body, /width=device-width/);
  const manifest = await client.request('/assets/brand/manifest.json');
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.body.brand_owner, 'SUIWU 随物');
  const logo = await client.request('/assets/brand/7846e5a3d39a673b230a47f52f4532ca.jpg');
  assert.equal(logo.response.status, 200);
  assert.equal(logo.response.headers.get('content-type'), 'image/jpeg');
});

test('health and readiness are explicit and connectors remain unconfigured', async () => {
  const app = await startTestApp({ seedDemo: true });
  apps.push(app);
  const client = new TestClient(app.baseUrl);
  const ready = await client.request('/api/readyz');
  assert.equal(ready.response.status, 200);
  const health = await client.request('/api/healthz');
  assert.equal(health.body.connectors.whatsapp.mode, 'unconfigured');
  assert.equal(health.body.connectors.whatsapp.enabled, false);
});
