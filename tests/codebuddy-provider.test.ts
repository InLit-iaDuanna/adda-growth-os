import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCodeBuddyRole } from '../packages/adapters/src/codebuddy';
import type { AppConfig } from '../packages/adapters/src/config';

const config = (codebuddyBin: string, aiProvider: 'codebuddy_cli' | 'deterministic_offline'): AppConfig => ({
  mode: 'test', host: '127.0.0.1', port: 0, dataFile: '/tmp/adda-codebuddy-test.json', sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
  sessionTtlSeconds: 3600, workerHeartbeatSeconds: 10, allowTestOutbox: true, databaseAdapter: 'file-dev', aiProvider,
  codebuddyBin, codebuddyModel: 'synthetic-test-model', codebuddyTimeoutMs: 2_000, codebuddyMaxOutputBytes: 100_000
});

test('CodeBuddy provider is disabled unless explicitly selected', async () => {
  const result = await runCodeBuddyRole(config('missing-binary', 'deterministic_offline'), { role: 'data_generator', prompt: '{}' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, 'provider_disabled');
});

test('CodeBuddy provider executes without a shell and unwraps structured JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adda-codebuddy-'));
  const binary = path.join(directory, 'fake-codebuddy');
  await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:"result",result:JSON.stringify({rows:[{id:"synthetic-1"}],notes:[]})}));\n');
  await chmod(binary, 0o755);
  const result = await runCodeBuddyRole(config(binary, 'codebuddy_cli'), { role: 'data_generator', conversationId: 'data-test-1', prompt: '{"synthetic":true}' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.conversationId, 'data-test-1');
    assert.deepEqual(result.value, { rows: [{ id: 'synthetic-1' }], notes: [] });
  }
});
