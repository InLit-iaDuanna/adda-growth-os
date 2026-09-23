import { readConfig, validateConfig } from '../packages/adapters/src/config';
import { JsonRepository } from '../packages/db/src/repository';

async function main(): Promise<void> {
  const config = readConfig();
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`invalid_configuration:${errors.join(',')}`);
  if (config.mode !== 'demo' && config.mode !== 'test') throw new Error('refusing_demo_seed_in_production');
  const repository = new JsonRepository(config.dataFile, config.mode);
  await repository.ensure();
  await repository.migrate();
  const result = await repository.seedDemo();
  console.log(JSON.stringify({ ok: true, demo: true, tenant_id: result.tenant.id, store_id: result.store.id, login: { email: result.owner.email, password: 'demo-only-password', warning: 'DEMO ONLY — never use in production' } }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
