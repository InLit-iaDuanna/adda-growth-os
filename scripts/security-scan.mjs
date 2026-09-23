import fs from 'node:fs/promises';
import path from 'node:path';

const roots = ['apps', 'packages', 'scripts', 'tests'];
const files = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.startsWith('.tmp-')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full); else if (/\.(ts|tsx|js|mjs|json|yml|yaml|env)$/.test(entry.name)) files.push(full);
  }
}
for (const root of roots) await walk(root);
const findings = [];
const patterns = [
  ['private_key', /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/],
  ['access_token_assignment', /(?:ACCESS_TOKEN|API_KEY|CLIENT_SECRET)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/],
  ['phone_literal', /(?<![\d.])\+(?:880|86|1)(?:[ ()-]*\d){8,14}(?!\d)/]
];
for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  for (const [name, pattern] of patterns) if (pattern.test(text) && !file.startsWith('tests/')) findings.push({ name, file });
}
console.log(JSON.stringify({ scanned_files: files.length, findings, status: findings.length ? 'review_required' : 'clean' }));
if (findings.length) process.exitCode = 2;
