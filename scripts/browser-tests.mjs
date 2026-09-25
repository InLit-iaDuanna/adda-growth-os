import {spawnSync} from 'node:child_process';
const python=process.env.PYTHON || (process.platform==='win32'?'python':'python3');
const r=spawnSync(python,['tests/browser_unified.py',...process.argv.slice(2)],{stdio:'inherit'});
if(r.error)console.error(r.error.message);
process.exitCode=r.status ?? 1;
