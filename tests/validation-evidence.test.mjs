import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let root;
let evidence;
const evidencePath = 'artifacts/audit-b01-b05/validation.json';
const run = (directory, script) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // The fixture starts an independent Node test runner.
  return spawnSync(process.execPath, [`scripts/${script}.mjs`], { cwd: directory, env, encoding: 'utf8' });
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-evidence-'));
  for (const dir of ['apps/web/src', 'packages', 'tests', 'scripts', 'fixtures', 'contracts', 'docs']) fs.mkdirSync(path.join(directory, dir), { recursive: true });
  for (const script of ['capabilities', 'validate-release', 'validation-evidence']) fs.copyFileSync(`scripts/${script}.mjs`, path.join(directory, `scripts/${script}.mjs`));
  // This miniature project exercises the evidence recorder, not application gates.
  const scripts = Object.fromEntries(['typecheck', 'build', 'security:scan', 'test:ai', 'fixtures:verify'].map(name => [name, 'node -e "process.exit(0)"']));
  scripts.test = 'node --test tests/smoke.cjs';
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'evidence-test-fixture', private: true, scripts }));
  fs.writeFileSync(path.join(directory, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(directory, 'docs/capabilities.json'), '[]');
  fs.writeFileSync(path.join(directory, 'tests/smoke.cjs'), 'require("node:test")("synthetic fixture", () => require("node:assert/strict").equal(2 + 2, 4));');
  fs.writeFileSync(path.join(directory, 'apps/web/src/main.ts'), 'export const fixture = true;');
  return directory;
}

before(() => {
  root = fixture();
  const result = run(root, 'validate-release');
  assert.equal(result.status, 0, result.stdout + result.stderr + fs.readFileSync(path.join(root, 'artifacts/audit-b01-b05/test.log'), 'utf8'));
  evidence = fs.readFileSync(path.join(root, evidencePath), 'utf8');
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function rejectsChangedFile(file, value) {
  const target = path.join(root, file);
  const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
  try {
    if (value === null) fs.unlinkSync(target);
    else fs.writeFileSync(target, value);
    const result = run(root, 'capabilities');
    assert.notEqual(result.status, 0);
    assert.ok((result.stderr + result.stdout).includes('validation_is_stale: '), result.stderr);
    assert.ok(result.stderr.includes(file), result.stderr);
  } finally {
    if (before === null) fs.rmSync(target, { force: true });
    else fs.writeFileSync(target, before);
  }
}

test('A01: unchanged source and actual successful command logs generate capabilities', () => {
  const result = run(root, 'capabilities');
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'docs/CAPABILITIES.md'), 'utf8'), /1 项通过，0 项失败，0 项跳过/);
});

test('A01: adding a previously unrecorded source file invalidates old evidence', () => {
  const output = fs.readFileSync(path.join(root, 'docs/CAPABILITIES.md'), 'utf8');
  rejectsChangedFile('apps/web/src/audit-unvalidated-file.ts', 'throw new Error("unvalidated");');
  assert.equal(fs.readFileSync(path.join(root, 'docs/CAPABILITIES.md'), 'utf8'), output);
});

test('A01: deleted, changed and renamed sources invalidate old evidence', () => {
  rejectsChangedFile('apps/web/src/main.ts', null);
  rejectsChangedFile('apps/web/src/main.ts', 'export const fixture = false;');
  const from = path.join(root, 'apps/web/src/main.ts');
  const to = path.join(root, 'apps/web/src/renamed.ts');
  try {
    fs.renameSync(from, to);
    const result = run(root, 'capabilities');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /main\.ts/);
    assert.match(result.stderr, /renamed\.ts/);
  } finally { fs.renameSync(to, from); }
});

test('A01: lockfile and actual package scripts are part of the source snapshot', () => {
  rejectsChangedFile('package-lock.json', '{"lockfileVersion":3}');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.scripts.test = 'node -e "process.exit(0)"';
  rejectsChangedFile('package.json', JSON.stringify(manifest));
});

test('A01: different toolchain, omitted commands and changed logs cannot claim a current validation', () => {
  for (const [change, expected] of [
    [record => { record.toolchain.node = 'v0.0.0'; }, /validation_toolchain_changed/],
    [record => { record.checks.pop(); }, /validation_commands_changed/],
    [record => { record.source_stable = false; }, /validation_snapshot_incomplete/]
  ]) {
    try {
      const modified = JSON.parse(evidence);
      change(modified);
      fs.writeFileSync(path.join(root, evidencePath), JSON.stringify(modified));
      const result = run(root, 'capabilities');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    } finally { fs.writeFileSync(path.join(root, evidencePath), evidence); }
  }
  const log = path.join(root, JSON.parse(evidence).checks[0].log);
  const original = fs.readFileSync(log);
  try {
    fs.appendFileSync(log, '\nchanged log');
    const result = run(root, 'capabilities');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /validation_log_changed/);
  } finally { fs.writeFileSync(log, original); }
});

test('A01: a file created during the gate run makes that run invalid', () => {
  const directory = fixture();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    manifest.scripts.build = 'node -e "require(\'node:fs\').writeFileSync(\'apps/web/src/late.ts\', \'export {}\')"';
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    const result = run(directory, 'validate-release');
    assert.notEqual(result.status, 0);
    const recorded = JSON.parse(fs.readFileSync(path.join(directory, evidencePath), 'utf8'));
    assert.equal(recorded.source_stable, false);
    assert.deepEqual(recorded.changed_during_run, ['apps/web/src/late.ts']);
    assert.notEqual(run(directory, 'capabilities').status, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
