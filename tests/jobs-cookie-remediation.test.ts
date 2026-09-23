import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonRepository } from '../packages/db/src/repository';
import { startTestApp } from '../packages/testing/src/http';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

test('production login and logout cookies include Secure', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adda-cookie-'));
  const app = await startTestApp({ mode: 'production', dataFile: path.join(dataDir, 'db.json') });
  cleanups.push(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });

  const tenant = await app.repository.createTenant({ slug: 'cookie-tenant', name: 'Cookie tenant', mode: 'production', status: 'active', timezone: 'UTC', currency: 'USD', launchDate: null });
  const store = await app.repository.createStore({ tenantId: tenant.id, slug: 'cookie-store', name: 'Cookie store', timezone: 'UTC', currency: 'USD', status: 'active' });
  const user = await app.repository.createUser({ email: 'cookie-owner@example.invalid', displayName: 'Cookie owner', password: 'strong-test-password', status: 'active' });
  await app.repository.addMembership({ tenantId: tenant.id, userId: user.id, role: 'OWNER', storeIds: [store.id], revokedAt: null });

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'strong-test-password' })
  });
  assert.equal(login.status, 200);
  const loginCookie = login.headers.get('set-cookie') || '';
  assert.match(loginCookie, /Secure/);
  assert.match(loginCookie, /HttpOnly/);

  const logout = await fetch(`${app.baseUrl}/api/auth/logout`, {
    method: 'POST', headers: { cookie: loginCookie.split(';')[0], 'x-csrf-token': (await login.json()).csrf_token }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Secure/);
});

test('running jobs are protected by owner leases and only expired leases recover', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adda-jobs-'));
  const repository = new JsonRepository(path.join(dataDir, 'db.json'), 'test');
  await repository.ensure();
  await repository.migrate();
  cleanups.push(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });

  const queued = await repository.enqueueJob({ tenantId: null, type: 'maintenance', idempotencyKey: 'lease-case' });
  const ownerA = await repository.claimNextJob('worker-a', 60);
  assert.equal(ownerA?.id, queued.id);
  assert.ok(ownerA?.leaseToken);
  const renewed = await repository.renewJobLease(queued.id, 'worker-a', ownerA?.leaseToken || undefined, 120);
  assert.equal(renewed?.leaseOwnerId, 'worker-a');
  assert.ok(renewed?.leaseHeartbeatAt);
  assert.equal(await repository.recoverInterruptedJobs(new Date()), 0);
  assert.equal(await repository.claimNextJob('worker-b'), undefined);
  assert.equal(await repository.finishJob(queued.id, 'succeeded', null, 'worker-b'), undefined);

  const expiresAt = Date.parse(renewed!.leaseExpiresAt!);
  assert.ok(Number.isFinite(expiresAt));
  assert.equal(await repository.recoverInterruptedJobs(new Date(expiresAt + 1)), 1);
  const ownerB = await repository.claimNextJob('worker-b', 60);
  assert.equal(ownerB?.leaseOwnerId, 'worker-b');
  assert.equal(await repository.finishJob(queued.id, 'succeeded', null, 'worker-a'), undefined);
  assert.equal((await repository.finishJob(queued.id, 'succeeded', null, 'worker-b', ownerB?.leaseToken || undefined))?.status, 'succeeded');
});

test('legacy running jobs without lease metadata are recovered once', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adda-legacy-jobs-'));
  const repository = new JsonRepository(path.join(dataDir, 'db.json'), 'test');
  await repository.ensure();
  await repository.migrate();
  cleanups.push(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });

  const job = await repository.enqueueJob({ tenantId: null, type: 'maintenance', idempotencyKey: 'legacy-case' });
  await repository.mutate((state) => {
    const item = state.jobs.find((candidate) => candidate.id === job.id)!;
    item.status = 'running';
    item.leaseOwnerId = undefined;
    item.leaseExpiresAt = undefined;
  });
  assert.equal(await repository.recoverInterruptedJobs(), 1);
  assert.equal(repository.listJobs()[0].status, 'queued');
});
