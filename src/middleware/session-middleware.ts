import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthService } from '../services/auth-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId?: string;
    deviceName?: string;
    sessionToken?: string;
  }
}

/**
 * Register the session validation middleware for all protected routes.
 * This hook runs before route handlers and validates the session token
 * from the Authorization header. Public routes (login, health, webhooks)
 * are excluded.
 */
export function registerSessionMiddleware(
  server: FastifyInstance,
  authService: AuthService,
  options?: { webInterfaceEnabled?: boolean }
): void {
  const webInterfaceEnabled = options?.webInterfaceEnabled ?? false;

  const publicPaths = new Set([
    '/health',
    '/api/auth/login',
    '/api/version',
  ]);

  const publicPrefixes = [
    '/webhooks/',
    '/public/',
    '/ws',
  ];

  // Static file extensions served by the web interface
  const staticExtensions = ['.html', '.js', '.css', '.map', '.ico', '.png', '.svg', '.jpg', '.woff', '.woff2', '.ttf'];

  server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip public routes
    if (publicPaths.has(request.url)) {
      return;
    }

    // Skip routes with public prefixes (webhooks)
    for (const prefix of publicPrefixes) {
      if (request.url.startsWith(prefix)) {
        return;
      }
    }

    // When web interface is enabled, allow unauthenticated GET requests
    // for static assets and SPA routes (non-API paths)
    if (webInterfaceEnabled && request.method === 'GET') {
      const url = request.url.split('?')[0];
      if (!url.startsWith('/api/')) {
        const hasExtension = staticExtensions.some(ext => url.endsWith(ext));
        if (hasExtension || url === '/' || (!url.includes('.') && !url.startsWith('/api/'))) {
          return;
        }
      }
    }

    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: 'Authentication required',
        statusCode: 401,
      });
    }

    const sessionToken = authHeader.slice(7);
    const session = await authService.validateSession(sessionToken);

    if (!session.valid) {
      return reply.status(401).send({
        error: 'Invalid or expired session',
        statusCode: 401,
      });
    }

    // Attach session info to the request for downstream handlers
    request.deviceId = session.deviceId;
    request.deviceName = session.deviceName;
    request.sessionToken = sessionToken;
  });
}
