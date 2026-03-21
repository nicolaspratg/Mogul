/**
 * Application configuration — validated and frozen at startup.
 * All environment variables are accessed exclusively through this module.
 * The process exits immediately (exit code 1) if any required variable is
 * missing or malformed, so the rest of the codebase can treat `config` as
 * always-valid.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Environment variable "${name}" must be an integer, got: "${raw}"`,
    );
  }
  return parsed;
}

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  /** HMAC-SHA256 secret used to verify Meta webhook request signatures. */
  readonly metaAppSecret: string;
  /** Verification token sent by Meta when registering the webhook endpoint. */
  readonly metaWebhookVerifyToken: string;
  readonly nodeEnv: 'development' | 'production' | 'test';
  /** Sliding-window conversation TTL in hours (default: 24). */
  readonly conversationTtlHours: number;
  /** How often the in-process cleanup job fires, in milliseconds (default: 15 min). */
  readonly cleanupIntervalMs: number;
}

function buildConfig(): AppConfig {
  const nodeEnvRaw = optionalEnv('NODE_ENV', 'development');
  if (
    nodeEnvRaw !== 'development' &&
    nodeEnvRaw !== 'production' &&
    nodeEnvRaw !== 'test'
  ) {
    throw new Error(
      `NODE_ENV must be "development", "production", or "test", got: "${nodeEnvRaw}"`,
    );
  }

  return {
    port: optionalEnvInt('PORT', 3000),
    databaseUrl: requireEnv('DATABASE_URL'),
    metaAppSecret: requireEnv('META_APP_SECRET'),
    metaWebhookVerifyToken: requireEnv('META_WEBHOOK_VERIFY_TOKEN'),
    nodeEnv: nodeEnvRaw,
    conversationTtlHours: optionalEnvInt('CONVERSATION_TTL_HOURS', 24),
    cleanupIntervalMs: optionalEnvInt('CLEANUP_INTERVAL_MS', 15 * 60 * 1000),
  };
}

let _config: AppConfig;

try {
  _config = buildConfig();
} catch (err) {
  console.error(
    '[config] Fatal startup error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}

export const config: AppConfig = _config!;
