/** Start Web + worker against the complete synthetic fixture on an isolated port. */
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.join(root, 'artifacts', 'test-data', 'complete-demo.json');
const runtime = path.join(root, 'data', 'complete-demo-runtime.json');
const entry = path.join(root, 'dist', 'apps', 'web', 'src', 'server.js');
const worker = path.join(root, 'dist', 'apps', 'worker', 'src', 'index.js');
if (!existsSync(entry) || !existsSync(worker)) throw new Error('先运行 npm run build');
if (!existsSync(artifact)) throw new Error('先运行 npm run data:seed');
if (existsSync(runtime)) {
  const current = JSON.parse(readFileSync(runtime, 'utf8'));
  if (current.tenants?.some((tenant) => tenant.mode !== 'demo') || !current.auditEvents?.some((event) => event.action === 'test_data.fixture_seeded')) throw new Error('refusing_non_demo_runtime_database');
} else {
  copyFileSync(artifact, runtime);
}
const port = process.env.PORT || '3111';
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, APP_MODE: 'demo', HOST: '127.0.0.1', PORT: port,
  ADDA_DATA_FILE: runtime, SESSION_SECRET: 'local-complete-test-secret-change-me', AI_PROVIDER: 'deterministic_offline',
  LIVE_EXTERNAL_WRITES: 'false', ALLOW_TEST_OUTBOX: 'false', WORKER_HEARTBEAT_SECONDS: '1'
};
console.log(`ADDA 完整合成数据\n运营 http://127.0.0.1:${port}/admin\n审核 http://127.0.0.1:${port}/review\n收银 http://127.0.0.1:${port}/staff\n顾客入口：使用 artifacts/test-data/manifest.json 的 source token 组成 /s/du-gate-demo/c/<token>\n真实外发已关闭；Ctrl+C 同时退出 Web 与 worker。`);
const children = [entry, worker].map((file) => spawn(process.execPath, [file], { cwd: root, env, stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); process.exitCode = code; }
for (const child of children) child.on('error', () => stop(1)).on('exit', (code) => { if (!stopping && code !== 0) stop(code || 1); });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
