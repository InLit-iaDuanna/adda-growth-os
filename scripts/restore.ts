import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function main(): Promise<void> {
  const source = process.argv[2];
  const destination = process.argv[3];
  if (!source || !destination) throw new Error('usage: restore <backup.json> <new-db.json>');
  const content = await fs.readFile(source);
  const checksumPath = `${source}.sha256`;
  try {
    const checksum = (await fs.readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0];
    const actual = createHash('sha256').update(content).digest('hex');
    if (!checksum || checksum !== actual) throw new Error('backup_checksum_mismatch');
  } catch (error) {
    if (error instanceof Error && error.message === 'backup_checksum_mismatch') throw error;
    throw new Error('backup_checksum_missing');
  }
  const parsed = JSON.parse(content.toString('utf8')) as { schemaVersion?: number; sessions?: unknown[] };
  if (!Number.isSafeInteger(parsed.schemaVersion) || (parsed.schemaVersion || 0) < 1) throw new Error('backup_schema_invalid');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.restore.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, destination);
  console.log(JSON.stringify({ source, destination, restored: true, schema_version: parsed.schemaVersion, sessions_preserved: Array.isArray(parsed.sessions) ? parsed.sessions.length : 0 }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
