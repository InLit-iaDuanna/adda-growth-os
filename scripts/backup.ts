import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readConfig, validateConfig } from '../packages/adapters/src/config';

async function main(): Promise<void> {
  const config = readConfig();
  const errors = validateConfig(config).filter((error) => !error.startsWith('postgres_adapter_not_implemented'));
  if (errors.length) throw new Error(`invalid_configuration:${errors.join(',')}`);
  const source = process.argv[2] || config.dataFile;
  const destination = process.argv[3] || `${source}.${new Date().toISOString().replace(/[:.]/g, '-')}.backup.json`;
  const content = await fs.readFile(source);
  const parsed = JSON.parse(content.toString('utf8')) as { schemaVersion?: number };
  if (!Number.isSafeInteger(parsed.schemaVersion) || (parsed.schemaVersion || 0) < 1) throw new Error('backup_schema_invalid');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, { mode: 0o600 });
  const digest = createHash('sha256').update(content).digest('hex');
  await fs.writeFile(`${destination}.sha256`, `${digest}  ${path.basename(destination)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ source, destination, sha256: digest, schema_version: parsed.schemaVersion, bytes: content.byteLength }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
