import { describe, it, expect } from 'vitest';
import { envSchema, serverConfigFileSchema } from './config.js';

describe('envSchema', () => {
  it('should validate a complete set of environment variables', () => {
    const env = {
      NODE_ENV: 'production',
      PORT: '3000',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      VONAGE_API_KEY: 'abc123',
      VONAGE_API_SECRET: 'secret',
      VONAGE_APP_ID: '550e8400-e29b-41d4-a716-446655440000',
      VONAGE_PRIVATE_KEY_PATH: './private.key',
      BASE_URL: 'https://example.com',
      CONFIG_PATH: './server-config.yaml',
      LOG_LEVEL: 'info',
    };

    const result = envSchema.parse(env);
    expect(result.PORT).toBe(3000);
    expect(result.NODE_ENV).toBe('production');
  });

  it('should apply default values for optional fields', () => {
    const env = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      VONAGE_API_KEY: 'abc123',
      VONAGE_API_SECRET: 'secret',
      VONAGE_APP_ID: '550e8400-e29b-41d4-a716-446655440000',
      VONAGE_PRIVATE_KEY_PATH: './private.key',
      BASE_URL: 'https://example.com',
    };

    const result = envSchema.parse(env);
    expect(result.PORT).toBe(3000);
    expect(result.HOST).toBe('0.0.0.0');
    expect(result.NODE_ENV).toBe('production');
    expect(result.LOG_LEVEL).toBe('info');
  });

  it('should reject invalid DATABASE_URL', () => {
    const env = {
      DATABASE_URL: 'not-a-url',
      VONAGE_API_KEY: 'abc123',
      VONAGE_API_SECRET: 'secret',
      VONAGE_APP_ID: '550e8400-e29b-41d4-a716-446655440000',
      VONAGE_PRIVATE_KEY_PATH: './private.key',
      BASE_URL: 'https://example.com',
    };

    expect(() => envSchema.parse(env)).toThrow();
  });

  it('should reject invalid NODE_ENV values', () => {
    const env = {
      NODE_ENV: 'staging',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      VONAGE_API_KEY: 'abc123',
      VONAGE_API_SECRET: 'secret',
      VONAGE_APP_ID: '550e8400-e29b-41d4-a716-446655440000',
      VONAGE_PRIVATE_KEY_PATH: './private.key',
      BASE_URL: 'https://example.com',
    };

    expect(() => envSchema.parse(env)).toThrow();
  });

  it('should coerce PORT from string to number', () => {
    const env = {
      PORT: '8080',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      VONAGE_API_KEY: 'abc123',
      VONAGE_API_SECRET: 'secret',
      VONAGE_APP_ID: '550e8400-e29b-41d4-a716-446655440000',
      VONAGE_PRIVATE_KEY_PATH: './private.key',
      BASE_URL: 'https://example.com',
    };

    const result = envSchema.parse(env);
    expect(result.PORT).toBe(8080);
    expect(typeof result.PORT).toBe('number');
  });
});

describe('serverConfigFileSchema', () => {
  it('should validate a complete config file structure', () => {
    const config = {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      log: {
        level: 'info',
        json: true,
      },
      database: {
        url: 'postgresql://user:pass@localhost:5432/db',
        maxConnections: 10,
      },
      mediabridge: {
        url: 'http://localhost:9090',
        healthCheckInterval: 5000,
      },
    };

    const result = serverConfigFileSchema.parse(config);
    expect(result.server.port).toBe(3000);
    expect(result.log.level).toBe('info');
    expect(result.log.json).toBe(true);
    expect(result.database.maxConnections).toBe(10);
    expect(result.mediabridge.url).toBe('http://localhost:9090');
    expect(result.mediabridge.healthCheckInterval).toBe(5000);
  });

  it('should apply defaults for optional sections', () => {
    const config = {
      database: {
        url: 'postgresql://user:pass@localhost:5432/db',
      },
    };

    const result = serverConfigFileSchema.parse(config);
    expect(result.server.port).toBe(3000);
    expect(result.server.host).toBe('0.0.0.0');
    expect(result.log.level).toBe('info');
    expect(result.log.json).toBe(false);
    expect(result.database.maxConnections).toBe(10);
    expect(result.server.sessionExpiryDays).toBe(30);
    expect(result.mediabridge.url).toBe('http://localhost:9090');
    expect(result.mediabridge.healthCheckInterval).toBe(5000);
  });

  it('should allow custom mediabridge settings', () => {
    const config = {
      database: {
        url: 'postgresql://user:pass@localhost:5432/db',
      },
      mediabridge: {
        url: 'http://mediabridge:9090',
        healthCheckInterval: 10000,
      },
    };

    const result = serverConfigFileSchema.parse(config);
    expect(result.mediabridge.url).toBe('http://mediabridge:9090');
    expect(result.mediabridge.healthCheckInterval).toBe(10000);
  });
});
