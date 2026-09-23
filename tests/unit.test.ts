import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig, validateConfig } from '../packages/adapters/src/config';
import { roleCan } from '../packages/domain/src/auth';
import { computeGoldenMetrics, type GoldenFixture } from '../packages/domain/src/metrics';
import { JsonRepository } from '../packages/db/src/repository';

test('production is the safe default and rejects a missing session secret', () => {
  const config = readConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.mode, 'production');
  assert.equal(config.allowTestOutbox, false);
  assert.ok(validateConfig(config).some((item) => item.includes('SESSION_SECRET')));
});

test('CASHIER cannot export, edit budget, approve or manage channels', () => {
  assert.equal(roleCan('CASHIER', 'campaign:read'), true);
  assert.equal(roleCan('CASHIER', 'member:export'), false);
  assert.equal(roleCan('CASHIER', 'campaign:edit_budget'), false);
  assert.equal(roleCan('CASHIER', 'campaign:approve'), false);
  assert.equal(roleCan('CASHIER', 'integration:manage'), false);
});

test('real domain metric code reproduces the golden fixture', async () => {
  const fixture = JSON.parse(await fs.readFile(path.resolve('fixtures/golden_dataset.json'), 'utf8')) as GoldenFixture;
  const expected = JSON.parse(await fs.readFile(path.resolve('fixtures/expected_metrics.json'), 'utf8'));
  assert.deepEqual(computeGoldenMetrics(fixture), expected);
});

test('demo seed is idempotent and production refuses it', async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-unit-'));
  const demo = new JsonRepository(path.join(root, 'demo.json'), 'test');
  await demo.ensure();
  await demo.seedDemo();
  await demo.seedDemo();
  assert.equal(demo.snapshot().tenants.length, 1);
  assert.equal(demo.snapshot().users.length, 4);
  const production = new JsonRepository(path.join(root, 'production.json'), 'production');
  await production.ensure();
  await assert.rejects(() => production.seedDemo(), /demo_seed_requires/);
});
