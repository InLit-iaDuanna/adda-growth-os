/** Local whole-repository evidence, independent of historical release records.
 * This is NOT a clean-install, live-channel or production-readiness verdict. */
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {sourceSnapshot, changedSources, testCounts, sha256} from './validation-evidence.mjs';
const directory='artifacts/unified-2026-09-25';fs.mkdirSync(directory+'/gates',{recursive:true});
const before=sourceSnapshot();
const version=name=>{try{return JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json','utf8')).version;}catch{return 'not_installed';}};
const toolchain={node:process.version,npm:spawnSync('npm',['--version'],{encoding:'utf8'}).stdout.trim(),typescript:version('typescript'),node_types:version('@types/node'),tsx:version('tsx'),platform:process.platform,arch:process.arch};
const checks=[];
for(const script of ['lint','typecheck','build','test','test:ai','fixtures:verify','security:scan']){
 const start=new Date().toISOString();const result=spawnSync('npm',['run',script],{encoding:'utf8',maxBuffer:32*1024*1024});
 const output=(result.stdout||'')+(result.stderr||'')+(result.error?String(result.error):'');
 const log=directory+'/gates/'+script.replaceAll(':','-')+'.log';fs.writeFileSync(log,output);
 const test=script==='test'?testCounts(output):undefined;
 const exit=result.status??1;const validTests=!test||Boolean(test.total&&test.passed===test.total&&!test.failed&&!test.skipped&&!test.cancelled);
 checks.push({command:'npm run '+script,started_at:start,finished_at:new Date().toISOString(),exit_code:exit,passed:exit===0&&validTests,log,log_sha256:sha256(log),...(test?{tests:test}:{})});
 console.log(script+': '+exit+(test?' ('+test.passed+'/'+test.total+')':''));
}
const changed=changedSources(before,sourceSnapshot());
const evidence={schema_version:1,scope:'whole uploaded application / local file-dev integration',recorded_at:new Date().toISOString(),toolchain,source_stable:changed.length===0,changed_during_run:changed,source_files:before,checks,
 limits:{clean_locked_install:false,native_browser_e2e:false,production_database:false,live_model:false,live_channels:false,production_ready:false},
 notes:['npm ci was attempted separately and failed with registry DNS EAI_AGAIN. Preinstalled actual TypeScript and Node types were used; this is not a lockfile clean-install claim.','npm test builds all source and runs all original/new TypeScript tests plus JavaScript evidence tests; no test.skip or fake success fallback.','Browser DOM + real HTTP bridge checks are recorded separately in browser-checks.json; native navigation was blocked by environment policy.']};
fs.writeFileSync(directory+'/validation.json',JSON.stringify(evidence,null,2)+'\n');
process.exitCode=changed.length===0&&checks.every(x=>x.passed)?0:1;
