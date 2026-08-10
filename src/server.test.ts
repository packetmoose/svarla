import { describe, it, expect, vi } from 'vitest';
import { buildServer } from './server.js';
import type { AppConfig } from './config.js';

// Mock the database module to avoid real PostgreSQL connections
vi.mock('./database.js', () => ({
  createDatabase: () => ({
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          execute: async () => [],
        }),
      }),
    }),
  }),
}));

function createTestConfig(): AppConfig {
  return {
    env: {
      NODE_ENV: 'test',
      PORT: 3000,
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
      BASE_URL: 'https://test.example.com',
      CONFIG_PATH: './server-config.yaml',
      LOG_LEVEL: 'info',
      CORS_ORIGIN: '',
      CONFIG_ENCRYPTION_KEY: '',
      MEDIA_BRIDGE_URL: '',
    },
    file: {
      server: {
        port: 3000,
        host: '127.0.0.1',
        baseUrl: 'https://test.example.com',
        sessionExpiryDays: 30,
        web: { enabled: true },
      },
      log: {
        level: 'error',
        json: true,
      },
      database: {
        url: 'postgresql://user:pass@localhost:5432/test',
        maxConnections: 10,
      },
      mediabridge: {
        url: 'http://localhost:9090',
        healthCheckInterval: 5000,
        sip: { tls: true },
      },
    } as AppConfig['file'],
    port: 3000,
    host: '127.0.0.1',
    logLevel: 'error',
    logJson: true,
    databaseUrl: 'postgresql://user:pass@localhost:5432/test',
    baseUrl: 'https://test.example.com',
    sessionExpiryDays: 30,
    webInterfaceEnabled: true,
    corsOrigin: '',
    pushAllowPrivateEndpoints: false,
    configEncryptionKey: '',
    mediaBridge: {
      url: 'http://localhost:9090',
      eventWebSocketUrl: 'ws://localhost:9090/events',
      healthCheckInterval: 5000,
      sip: { tls: true },
    },
  };
}

describe('buildServer', () => {
  it('should create a Fastify server instance', async () => {
    const config = createTestConfig();
    const server = await buildServer(config);

    expect(server).toBeDefined();
    expect(server.log).toBeDefined();
    await server.close();
  });

  it('should respond to health check', async () => {
    const config = createTestConfig();
    const server = await buildServer(config);

    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    await server.close();
  });

  it('should return 404 for unknown routes', async () => {
    const config = createTestConfig();
    const server = await buildServer(config);

    // Use a public prefix path (/webhooks/) that won't be intercepted by auth middleware
    const response = await server.inject({
      method: 'GET',
      url: '/webhooks/nonexistent',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Not Found');
    await server.close();
  });
});
