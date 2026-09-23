import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validationDirectory as directory, validationCommands, sourceSnapshot, changedSources, toolchainSnapshot, testCounts, sha256 } from './validation-evidence.mjs';

fs.mkdirSync(directory, { recursive: true });
const sourceFiles = sourceSnapshot();
const toolchain = toolchainSnapshot();
const checks = [];
for (const command of validationCommands) {
  const script = command.split(' ')[2];
  const args = ['run', script];
  const started = new Date().toISOString();
  const result = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = (result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) : '');
  const log = `${directory}/${script.replaceAll(':', '-')}.log`;
  fs.writeFileSync(log, output);
  const check = { command, started_at: started, finished_at: new Date().toISOString(), exit_code: result.status ?? 1, log, log_sha256: sha256(log) };
  if (script === 'test') {
    check.tests = testCounts(output);
    if (!check.tests.total || check.tests.failed || check.tests.skipped || check.tests.cancelled || check.tests.passed !== check.tests.total) check.exit_code = check.exit_code || 1;
  }
  checks.push(check);
  console.log(`${check.command}: exit ${check.exit_code}`);
}
const changed = changedSources(sourceFiles, sourceSnapshot());
const sourceStable = !changed.length && JSON.stringify(toolchain) === JSON.stringify(toolchainSnapshot());
if (!sourceStable) console.error('validation_changed_during_run: ' + changed.join(', '));
const evidence = { schema_version: 2, recorded_at: new Date().toISOString(), node: process.version, toolchain, source_stable: sourceStable, changed_during_run: changed, source_files: sourceFiles, checks, limitations: ['No clean dependency installation was attempted in this validation run; existing node_modules was used.', 'The validation commands run HTTP tests and do not include browser interaction acceptance.', 'The validation commands did not exercise a production database, live model, external message or customer UAT.'] };
fs.writeFileSync(`${directory}/validation.json`, JSON.stringify(evidence, null, 2) + '\n');
process.exitCode = sourceStable && checks.every(check => check.exit_code === 0) ? 0 : 1;
