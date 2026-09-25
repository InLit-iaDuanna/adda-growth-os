/** Local demo only: initialize a dedicated file, start web + worker together.
 * Never reads .env, never enables outbound connectors, never overwrites an
 * existing production/test database. No runtime npm dependencies are required
 * after building (or when using the included verified dist/). */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const database=path.join(root,'data','local-demo.json');
const entry='dist/apps/web/src/server.js';
if(!existsSync(entry)) {console.error('先运行 npm ci && npm run build，或使用含 dist/ 的完整交付包。');process.exit(1);}
if(existsSync(database)){
  const db=JSON.parse(readFileSync(database,'utf8'));
  if(!Array.isArray(db.tenants) || db.tenants.some(t=>t.mode!=='demo'))throw new Error('refusing_non_demo_database');
}
// Explicit environment: do not inherit provider credentials or DATABASE_URL.
const env={PATH:process.env.PATH,HOME:process.env.HOME,SystemRoot:process.env.SystemRoot,
  APP_MODE:'demo',HOST:'127.0.0.1',PORT:process.env.PORT||'3000',
  ADDA_DATA_FILE:database,SESSION_SECRET:'local-demo-only-do-not-use-this-secret-in-production',
  WORKER_HEARTBEAT_SECONDS:'1',ALLOW_TEST_OUTBOX:'false',LIVE_EXTERNAL_WRITES:'false'};
const seed=spawnSync(process.execPath,['dist/scripts/seed-demo.js'],{cwd:root,env,stdio:'inherit'});
if(seed.error || seed.status!==0){console.error(seed.error||'demo_seed_failed');process.exit(1);}
console.log(`\nADDA — SUIWU 随物旗下品牌\n运营 http://127.0.0.1:${env.PORT}/admin\n审核 http://127.0.0.1:${env.PORT}/review\n收银 http://127.0.0.1:${env.PORT}/staff\n顾客入口：在活动中生成来源链接。\n仅本机演示；真实外发关闭；Ctrl+C 同时退出 web 与 worker。\n`);
const children=[];let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;process.exitCode=code;for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');}
for(const file of [entry,'dist/apps/worker/src/index.js']){
  const child=spawn(process.execPath,[file],{cwd:root,env,stdio:'inherit'});children.push(child);
  child.on('error',error=>{console.error(error.message);stop(1);});
  child.on('exit',(code,signal)=>{if(!stopping){console.error(`子进程退出 ${file}: ${code??signal}`);stop(code||1);}});
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
