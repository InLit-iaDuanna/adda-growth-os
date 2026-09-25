/** Execute every TS test after compilation, plus the original JS evidence tests.
 * This avoids requiring a second transpiler at test runtime. It does not skip
 * originals or treat fixture checks as application verification. */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const compiled = readdirSync('dist/tests').filter(f => f.endsWith('.test.js')).sort().map(f=>'dist/tests/'+f);
const source = readdirSync('tests').filter(f => f.endsWith('.test.mjs')).sort().map(f=>'tests/'+f);
if (!compiled.length || !source.length) throw new Error('test_files_missing_run_npm_run_build_first');
const result=spawnSync(process.execPath,['--test',...compiled,...source],{stdio:'inherit'});
if(result.error) throw result.error;
process.exitCode=result.status ?? 1;
