import path from 'node:path';

export type AppMode = 'production' | 'demo' | 'test';
export type AiProviderMode = 'deterministic_offline' | 'codebuddy_cli';

export interface AppConfig {
  mode: AppMode;
  host: string;
  port: number;
  dataFile: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  workerHeartbeatSeconds: number;
  allowTestOutbox: boolean;
  databaseAdapter: 'file-dev' | 'postgres';
  whatsappAppSecret?: string;
  whatsappVerifyToken?: string;
  whatsappAccessToken?: string;
  whatsappPhoneNumberId?: string;
  whatsappGraphVersion?: string;
  externalWritesEnabled?: boolean;
  /** The deterministic provider is the safe default. Live CLI calls are opt-in. */
  aiProvider: AiProviderMode;
  codebuddyBin: string;
  codebuddyModel: string;
  codebuddyTimeoutMs: number;
  codebuddyMaxOutputBytes: number;
}

function asMode(value: string | undefined): AppMode {
  if (value === 'demo' || value === 'test' || value === 'production') return value;
  return 'production';
}

function asPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function asAiProvider(value: string | undefined): AiProviderMode {
  return value === 'codebuddy_cli' ? 'codebuddy_cli' : 'deterministic_offline';
}

/**
 * Read configuration without silently enabling demo data or external writes.
 * A development fallback secret is intentionally available only outside production.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = asMode(env.APP_MODE);
  const dataDir = env.ADDA_DATA_DIR || path.resolve(process.cwd(), 'data');
  const sessionSecret = env.SESSION_SECRET || (mode === 'production' ? '' : 'local-only-development-secret-change-me');
  const databaseAdapter = env.DATABASE_URL ? 'postgres' : 'file-dev';
  return {
    mode,
    host: env.HOST || '127.0.0.1',
    port: asPositiveInt(env.PORT, 3000),
    dataFile: env.ADDA_DATA_FILE || path.join(dataDir, `${mode}-db.json`),
    sessionSecret,
    sessionTtlSeconds: asPositiveInt(env.SESSION_TTL_SECONDS, 8 * 60 * 60),
    workerHeartbeatSeconds: asPositiveInt(env.WORKER_HEARTBEAT_SECONDS, 10),
    allowTestOutbox: mode === 'test' && env.ALLOW_TEST_OUTBOX === 'true',
    databaseAdapter,
    whatsappAppSecret: env.WHATSAPP_APP_SECRET || '',
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappGraphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
    externalWritesEnabled: env.LIVE_EXTERNAL_WRITES === 'true',
    aiProvider: asAiProvider(env.AI_PROVIDER),
    codebuddyBin: env.CODEBUDDY_BIN || 'codebuddy',
    codebuddyModel: env.CODEBUDDY_MODEL || 'deepseek-v4.1-flash',
    codebuddyTimeoutMs: asPositiveInt(env.CODEBUDDY_TIMEOUT_MS, 120_000),
    codebuddyMaxOutputBytes: asPositiveInt(env.CODEBUDDY_MAX_OUTPUT_BYTES, 2_000_000)
  };
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];
  if (config.mode === 'production' && config.sessionSecret.length < 32) {
    errors.push('SESSION_SECRET must be at least 32 characters in production');
  }
  if (config.mode === 'production' && config.allowTestOutbox) {
    errors.push('test outbox is disabled in production');
  }
  if (config.databaseAdapter === 'postgres') errors.push('postgres_adapter_not_implemented_use_file_dev_explicitly');
  if (!config.codebuddyBin.trim()) errors.push('codebuddy_binary_required');
  if (!config.codebuddyModel.trim()) errors.push('codebuddy_model_required');
  if (config.codebuddyTimeoutMs < 1_000 || config.codebuddyTimeoutMs > 600_000) errors.push('codebuddy_timeout_out_of_range');
  if (config.codebuddyMaxOutputBytes < 16_384 || config.codebuddyMaxOutputBytes > 10_000_000) errors.push('codebuddy_output_limit_out_of_range');
  if (config.mode === 'production' && config.externalWritesEnabled && (!config.whatsappAppSecret || !config.whatsappAccessToken || !config.whatsappPhoneNumberId)) errors.push('live_external_writes_require_whatsapp_credentials');
  return errors;
}

export function connectorSnapshot(config: AppConfig): Record<string, unknown> {
  return {
    whatsapp: { mode: 'unconfigured', enabled: false, reason: 'credentials_and_approved_template_required' },
    ai: { mode: config.aiProvider, enabled: config.aiProvider === 'codebuddy_cli', provider: config.aiProvider === 'codebuddy_cli' ? 'codebuddy-cli' : 'deterministic-fake', model: config.aiProvider === 'codebuddy_cli' ? config.codebuddyModel : null, external_call: config.aiProvider === 'codebuddy_cli' },
    pos: { mode: 'manual', enabled: true, reason: 'CSV import adapter is available; live connector not configured' },
    testOutbox: { mode: config.allowTestOutbox ? 'demo' : 'disabled', enabled: config.allowTestOutbox }
  };
}
