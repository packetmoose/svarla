import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerSessionMiddleware } from './session-middleware.js';
import type { AuthService } from '../services/auth-service.js';

function createMockAuthService() {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    validateSession: vi.fn(),
    hashPassword: vi.fn(),
  } as unknown as AuthService;
}

describe('Session Middleware', () => {
  let server: FastifyInstance;
  let mockAuthService: ReturnType<typeof createMockAuthService>;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    mockAuthService = createMockAuthService();
    registerSessionMiddleware(server, mockAuthService as unknown as AuthService);

    // Add a test protected route
    server.get('/api/test', async (request) => {
      return {
        deviceId: request.deviceId,
        deviceName: request.deviceName,
      };
    });

    // Add the login route (public)
    server.post('/api/auth/login', async () => {
      return { message: 'login' };
    });

    await server.ready();
  });

  it('should allow access to /health without auth', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    // Health route isn't registered here, but the middleware should not block it
    // It will return 404 since we didn't register it, but not 401
    expect(response.statusCode).not.toBe(401);
  });

  it('should allow access to /api/auth/login without auth', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  it('should allow access to webhook routes without auth', async () => {
    // Create a separate server with webhook route registered before ready
    const webhookServer = Fastify({ logger: false });
    registerSessionMiddleware(webhookServer, mockAuthService as unknown as AuthService);
    webhookServer.post('/webhooks/answer', async () => ({ ncco: [] }));
    await webhookServer.ready();

    const response = await webhookServer.inject({
      method: 'POST',
      url: '/webhooks/answer',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  it('should reject protected routes without authorization header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/test',
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Authentication required');
  });

  it('should reject protected routes with invalid token format', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/test',
      headers: {
        authorization: 'Basic token123',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should reject protected routes with invalid session token', async () => {
    (mockAuthService.validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/test',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Invalid or expired session');
  });

  it('should allow access with valid session token and attach device info', async () => {
    (mockAuthService.validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
      deviceId: 'device-uuid-123',
      deviceName: 'My Phone',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/test',
      headers: {
        authorization: 'Bearer valid-session-token',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.deviceId).toBe('device-uuid-123');
    expect(body.deviceName).toBe('My Phone');
  });
});
