import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../../adapters/src/config';
import { JsonRepository } from '../../db/src/repository';
import { createAppServer, type AppServer } from '../../../apps/web/src/server';

export interface RunningTestApp extends AppServer {
  baseUrl: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function startTestApp(options: { mode?: 'test' | 'production' | 'demo'; seedDemo?: boolean; dataFile?: string; config?: Partial<AppConfig> } = {}): Promise<RunningTestApp> {
  const dataDir = options.dataFile ? path.dirname(options.dataFile) : await fs.mkdtemp(path.join(process.cwd(), '.tmp-g00-'));
  const dataFile = options.dataFile || path.join(dataDir, 'db.json');
  const mode = options.mode || 'test';
  const config: AppConfig = {
    mode,
    host: '127.0.0.1',
    port: 0,
    dataFile,
    sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
    sessionTtlSeconds: 3600,
    workerHeartbeatSeconds: 10,
    allowTestOutbox: mode === 'test',
    databaseAdapter: 'file-dev',
    aiProvider: 'deterministic_offline',
    codebuddyBin: 'codebuddy',
    codebuddyModel: 'deepseek-v4.1-flash',
    codebuddyTimeoutMs: 120_000,
    codebuddyMaxOutputBytes: 2_000_000,
    ...options.config
  };
  const repository = new JsonRepository(dataFile, mode);
  await repository.ensure();
  await repository.migrate();
  if (options.seedDemo) await repository.seedDemo();
  const app = await createAppServer({ config, repository });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  return {
    ...app,
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    async close() { await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve())); }
  };
}

export class TestClient {
  cookie = '';
  csrf = '';
  constructor(readonly baseUrl: string) {}

  async request(pathname: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    if (this.csrf && init.method && init.method !== 'GET') headers.set('x-csrf-token', this.csrf);
    const response = await fetch(`${this.baseUrl}${pathname}`, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  }

  async login(email: string, password = 'demo-only-password'): Promise<any> {
    const result = await this.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    this.csrf = result.body.csrf_token || '';
    return result;
  }
}
