import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Environment variable schema validated at startup.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  BASE_URL: z.string().optional().default(''),
  CONFIG_PATH: z.string().default('./server-config.yaml'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().optional().default(''),
  CONFIG_ENCRYPTION_KEY: z.string().optional().default(''),
  MEDIA_BRIDGE_URL: z.string().optional().default(''),
  MEDIA_BRIDGE_HEALTH_CHECK_INTERVAL: z.coerce.number().int().positive().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * YAML config file schema for server-config.yaml.
 */
export const serverConfigFileSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(3000),
    host: z.string().default('0.0.0.0'),
    baseUrl: z.string().optional().default(''),
    sessionExpiryDays: z.number().int().positive().default(30),
    web: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
  }).default({}),
  log: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    json: z.boolean().default(false),
  }).default({}),
  database: z.object({
    url: z.string().url(),
    maxConnections: z.number().int().positive().default(10),
  }),
  push: z.object({
    allowPrivateEndpoints: z.boolean().default(false),
  }).default({}),
  mediabridge: z.object({
    url: z.string().default('http://localhost:9090'),
    healthCheckInterval: z.number().int().positive().default(5000),
    sip: z.object({
      tls: z.boolean().default(true),
    }).default({}),
  }).default({}),
});

export type ServerConfigFile = z.infer<typeof serverConfigFileSchema>;

/**
 * Combined application configuration resolved from both env vars and config file.
 */
export interface AppConfig {
  env: EnvConfig;
  file: ServerConfigFile;
  port: number;
  host: string;
  logLevel: string;
  logJson: boolean;
  databaseUrl: string;
  baseUrl: string;
  sessionExpiryDays: number;
  webInterfaceEnabled: boolean;
  corsOrigin: string;
  pushAllowPrivateEndpoints: boolean;
  configEncryptionKey: string;
  mediaBridge: {
    url: string;
    eventWebSocketUrl: string;
    healthCheckInterval: number;
    sip: { tls: boolean };
  };
}

/**
 * Resolves environment variable placeholders in YAML config values.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvPlaceholders(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Recursively resolve environment variable placeholders in an object.
 */
function resolveConfigPlaceholders(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvPlaceholders(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveConfigPlaceholders);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveConfigPlaceholders(value);
    }
    return result;
  }
  return obj;
}

/**
 * Load and validate server configuration from environment and YAML config file.
 */
export function loadConfig(): AppConfig {
  // Validate environment variables
  const env = envSchema.parse(process.env);

  // Load and parse YAML config file
  let fileConfig: ServerConfigFile;
  try {
    const rawYaml = readFileSync(env.CONFIG_PATH, 'utf-8');
    const parsed = parseYaml(rawYaml);
    const resolved = resolveConfigPlaceholders(parsed);
    fileConfig = serverConfigFileSchema.parse(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config file is optional in development; use env vars as fallback
      fileConfig = serverConfigFileSchema.parse({
        database: {
          url: env.DATABASE_URL,
        },
      });
    } else {
      throw error;
    }
  }

  return {
    env,
    file: fileConfig,
    port: env.PORT ?? fileConfig.server.port,
    host: env.HOST ?? fileConfig.server.host,
    logLevel: env.LOG_LEVEL ?? fileConfig.log.level,
    logJson: fileConfig.log.json,
    databaseUrl: env.DATABASE_URL ?? fileConfig.database.url,
    baseUrl: env.BASE_URL || fileConfig.server.baseUrl || '',
    sessionExpiryDays: fileConfig.server.sessionExpiryDays,
    webInterfaceEnabled: fileConfig.server.web.enabled,
    corsOrigin: env.CORS_ORIGIN || '',
    pushAllowPrivateEndpoints: fileConfig.push.allowPrivateEndpoints,
    configEncryptionKey: env.CONFIG_ENCRYPTION_KEY || '',
    mediaBridge: {
      url: env.MEDIA_BRIDGE_URL || fileConfig.mediabridge.url,
      eventWebSocketUrl: (env.MEDIA_BRIDGE_URL || fileConfig.mediabridge.url).replace(/^http/, 'ws') + '/events',
      healthCheckInterval: env.MEDIA_BRIDGE_HEALTH_CHECK_INTERVAL ?? fileConfig.mediabridge.healthCheckInterval,
      sip: { tls: fileConfig.mediabridge.sip.tls },
    },
  };
}
