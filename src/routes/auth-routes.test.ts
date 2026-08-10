import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth-routes.js';
import type { AuthService, LoginResult } from '../services/auth-service.js';

function createMockAuthService() {
  return {
    login: vi.fn<[string, string, string], Promise<LoginResult>>(),
    logout: vi.fn<[string], Promise<boolean>>(),
    validateSession: vi.fn(),
    hashPassword: vi.fn<[string], Promise<string>>().mockResolvedValue('new-hash-value'),
    getAuth: vi.fn<[], Promise<{ passwordHash: string } | null>>(),
    updatePasswordHash: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
  } as unknown as AuthService;
}

describe('Auth Routes', () => {
  let server: FastifyInstance;
  let mockAuthService: ReturnType<typeof createMockAuthService>;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    mockAuthService = createMockAuthService();
    registerAuthRoutes(server, mockAuthService as unknown as AuthService);
    await server.ready();
  });

  describe('POST /api/auth/login', () => {
    it('should return 200 with session token on successful login', async () => {
      (mockAuthService.login as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        sessionToken: 'abc123token',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          password: 'ValidPass123!',
          deviceName: 'My Phone',
          pushTopicId: 'topic-id-123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.sessionToken).toBe('abc123token');
    });

    it('should return 401 on invalid credentials', async () => {
      (mockAuthService.login as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Invalid password',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          password: 'WrongPass123!',
          deviceName: 'My Phone',
          pushTopicId: 'topic-id-123',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Invalid password');
    });

    it('should return 423 when account is locked', async () => {
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      (mockAuthService.login as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Account is locked due to too many failed attempts',
        lockedUntil,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          password: 'WrongPass123!',
          deviceName: 'My Phone',
          pushTopicId: 'topic-id-123',
        },
      });

      expect(response.statusCode).toBe(423);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('locked');
      expect(body.lockedUntil).toBeDefined();
    });

    it('should return 400 for missing required fields', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          password: 'SomePassword',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 for empty password', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          password: '',
          deviceName: 'My Phone',
          pushTopicId: 'topic-id-123',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return 200 on successful logout', async () => {
      (mockAuthService.logout as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          authorization: 'Bearer valid-token-123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe('Logged out successfully');
    });

    it('should return 401 without authorization header', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 401 with invalid token format', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          authorization: 'InvalidFormat token',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 401 when logout fails (invalid token)', async () => {
      (mockAuthService.logout as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/change-password', () => {
    // bcrypt hash of 'CurrentPass1!' generated with salt rounds 12
    const MOCK_HASH = '$2b$12$LJ3m4ys0qpNvLiQlMJyTrOFEOQAlB8r8wPmjR/0AOYfNxTFVNGAem';

    beforeEach(() => {
      (mockAuthService.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
        passwordHash: MOCK_HASH,
      });
    });

    it('should return 200 on successful password change', async () => {
      // Use bcrypt to produce a hash that will match 'CurrentPass1!'
      const bcrypt = await import('bcrypt');
      const realHash = await bcrypt.hash('CurrentPass1!', 12);
      (mockAuthService.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
        passwordHash: realHash,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: 'CurrentPass1!',
          newPassword: 'NewSecure1234!',
          confirmPassword: 'NewSecure1234!',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.message).toBe('Password changed successfully');
      expect(mockAuthService.updatePasswordHash).toHaveBeenCalled();
    });

    it('should return 401 when current password is incorrect', async () => {
      const bcrypt = await import('bcrypt');
      const realHash = await bcrypt.hash('ActualPassword1!', 12);
      (mockAuthService.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
        passwordHash: realHash,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: 'WrongPassword1!',
          newPassword: 'NewSecure1234!',
          confirmPassword: 'NewSecure1234!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Current password is incorrect');
    });

    it('should return 400 when new password is too short', async () => {
      const bcrypt = await import('bcrypt');
      const realHash = await bcrypt.hash('CurrentPass1!', 12);
      (mockAuthService.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
        passwordHash: realHash,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: 'CurrentPass1!',
          newPassword: 'Short1!',
          confirmPassword: 'Short1!',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('12 characters');
    });

    it('should return 400 when new password has no uppercase', async () => {
      const bcrypt = await import('bcrypt');
      const realHash = await bcrypt.hash('CurrentPass1!', 12);
      (mockAuthService.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
        passwordHash: realHash,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: 'CurrentPass1!',
          newPassword: 'alllowercase1!',
          confirmPassword: 'alllowercase1!',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('uppercase');
    });

    it('should return 400 when passwords do not match', async () => {
      const bcrypt = await import('bcrypt');
      const realHash = await bcrypt.hash('CurrentPass1!', 12);
      (mockAuthService.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
        passwordHash: realHash,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: 'CurrentPass1!',
          newPassword: 'NewSecure1234!',
          confirmPassword: 'DifferentPass1!',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Passwords do not match');
    });

    it('should return 400 when required fields are missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: 'CurrentPass1!',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 500 when auth is not configured', async () => {
      (mockAuthService.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: 'CurrentPass1!',
          newPassword: 'NewSecure1234!',
          confirmPassword: 'NewSecure1234!',
        },
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Authentication not configured');
    });
  });
});
