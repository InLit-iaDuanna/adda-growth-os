import { readConfig, validateConfig } from '../packages/adapters/src/config';
import { JsonRepository } from '../packages/db/src/repository';

async function main(): Promise<void> {
  const config = readConfig();
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`invalid_configuration:${errors.join(',')}`);
  const repository = new JsonRepository(config.dataFile, config.mode);
  await repository.ensure();
  const state = await repository.migrate();
  console.log(JSON.stringify({ ok: true, mode: config.mode, adapter: config.databaseAdapter, schema_version: state.schemaVersion, data_file: config.dataFile }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
