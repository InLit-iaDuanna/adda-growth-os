import { randomUUID } from 'node:crypto';
import { readConfig, validateConfig } from '../../../packages/adapters/src/config';
import { JsonRepository, nowIso } from '../../../packages/db/src/repository';

export async function runWorkerOnce(): Promise<{ instanceId: string; heartbeatAt: string }> {
  const config = readConfig();
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`invalid_configuration:${errors.join(',')}`);
  const repository = new JsonRepository(config.dataFile, config.mode);
  await repository.ensure();
  await repository.migrate();
  const instanceId = `worker-${randomUUID()}`;
  // Allow missed heartbeats before another worker can recover the job.
  const leaseSeconds = Math.max(config.workerHeartbeatSeconds * 3, 30);
  await repository.heartbeat(instanceId);
  const recoveredJobs = await repository.recoverInterruptedJobs();
  const job = await repository.claimNextJob(instanceId, leaseSeconds);
  if (job) await repository.finishJob(job.id, job.type === 'maintenance' ? 'succeeded' : 'failed', job.type === 'maintenance' ? null : 'worker_handler_unimplemented', instanceId, job.leaseToken || undefined);
  const heartbeatAt = nowIso();
  console.log(JSON.stringify({ service: 'adda-worker', event: 'heartbeat', instance_id: instanceId, heartbeat_at: heartbeatAt, mode: config.mode, recovered_jobs: recoveredJobs, processed_job_id: job?.id || null }));
  return { instanceId, heartbeatAt };
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = readConfig();
  await runWorkerOnce();
  if (once) return;
  const timer = setInterval(() => { runWorkerOnce().catch((error) => console.error(JSON.stringify({ service: 'adda-worker', error: 'heartbeat_failed', detail: error instanceof Error ? error.message : String(error) }))); }, config.workerHeartbeatSeconds * 1000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
