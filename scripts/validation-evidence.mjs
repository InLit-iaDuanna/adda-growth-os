import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const validationDirectory = 'artifacts/audit-b01-b05';
export const validationCommands = ['typecheck', 'build', 'test', 'security:scan', 'test:ai', 'fixtures:verify'].map(script => `npm run ${script}`);
export const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function sourceSnapshot(root = '.') {
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'docs/capabilities.json'];
  function collect(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error('unsupported_source_entry: ' + file);
    }
  }
  for (const directory of ['apps', 'packages', 'tests', 'scripts', 'fixtures', 'contracts']) collect(directory);
  return files.sort().map(file => ({ path: file, sha256: sha256(path.join(root, file)) }));
}

export function changedSources(before, after) {
  const a = new Map(before.map(file => [file.path, file.sha256]));
  const b = new Map(after.map(file => [file.path, file.sha256]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(file => a.get(file) !== b.get(file)).sort();
}

export function toolchainSnapshot(root = '.') {
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', cwd: root });
  if (npm.status !== 0) throw new Error('npm_version_unavailable');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const versions = {};
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).sort()) {
    versions[name] = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  return { node: process.version, npm: npm.stdout.trim(), platform: process.platform, arch: process.arch, packages: versions };
}

export function testCounts(output) {
  const count = name => [...output.matchAll(new RegExp(`(?:ℹ|#) ${name} (\\d+)`, 'g'))].reduce((sum, match) => sum + Number(match[1]), 0);
  return { total: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') };
}

export function assertValidation(evidence, root = '.') {
  if (evidence.schema_version !== 2 || !evidence.source_stable) throw new Error('validation_snapshot_incomplete');
  const changed = changedSources(evidence.source_files, sourceSnapshot(root));
  if (changed.length) throw new Error('validation_is_stale: ' + changed.join(', '));
  if (JSON.stringify(evidence.toolchain) !== JSON.stringify(toolchainSnapshot(root))) throw new Error('validation_toolchain_changed');
  if (JSON.stringify(evidence.checks.map(check => check.command)) !== JSON.stringify(validationCommands)) throw new Error('validation_commands_changed');
  if (evidence.checks.some(check => check.exit_code !== 0)) throw new Error('validation_has_failures');
  for (const check of evidence.checks) {
    if (sha256(path.join(root, check.log)) !== check.log_sha256) throw new Error('validation_log_changed: ' + check.log);
  }
  const check = evidence.checks.find(item => item.command === 'npm run test');
  const counts = testCounts(fs.readFileSync(path.join(root, check.log), 'utf8'));
  if (JSON.stringify(counts) !== JSON.stringify(check.tests) || !counts.total || counts.passed !== counts.total || counts.failed || counts.skipped || counts.cancelled) throw new Error('validation_tests_incomplete');
  return counts;
}
