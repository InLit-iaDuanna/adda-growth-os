import { JsonRepository } from '../packages/db/src/repository';
import { advanceBackgroundRuns } from '../packages/domain/src/control-runs';
import { processControlRunsOnce } from '../packages/adapters/src/control-worker';

async function main():Promise<void>{
  if(process.env.APP_MODE!=='test')throw new Error('test_mode_required');
  const repo=new JsonRepository(process.argv[2],'test');await repo.load();
  if(process.argv[3]==='interrupt'){
    await repo.mutate(state=>{advanceBackgroundRuns(state,new Date().toISOString());process.exit(77);});
  }else{await processControlRunsOnce(repo);}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
