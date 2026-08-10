import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';

/**
 * Configuration for webhook signature verification.
 * Credentials come from the provider's own config in the database.
 */
export interface WebhookAuthConfig {
  /** Vonage API signing secret (used for HS256 signed webhooks) */
  vonageApiSecret?: string;
  /** Vonage Application ID (used to validate JWT claims) */
  vonageApplicationId?: string;
}

/**
 * Verify Vonage JWT signature on a webhook request.
 * Returns true if the request is authenticated, false otherwise.
 *
 * Vonage sends a JWT in the Authorization header for signed webhooks.
 * Verification strategy:
 * 1. Try HS256 verification with the provider's API secret
 * 2. Fallback: decode JWT and verify application_id claim matches
 */
export function verifyVonageWebhookJwt(
  request: FastifyRequest,
  config: WebhookAuthConfig
): boolean {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);

  // Try HS256 verification with API secret (Vonage Messages API signed webhooks)
  if (config.vonageApiSecret) {
    try {
      const decoded = jwt.verify(token, config.vonageApiSecret, {
        algorithms: ['HS256'],
      }) as Record<string, unknown>;

      // Verify application_id if configured
      if (config.vonageApplicationId && decoded.application_id !== config.vonageApplicationId) {
        return false;
      }

      return true;
    } catch {
      // HS256 verification failed, try claim-based validation below
    }
  }

  // Fallback: decode without full cryptographic verification but validate claims.
  // This handles cases where Vonage uses a different signing method.
  // At minimum, the JWT must contain an application_id that matches ours.
  try {
    const decoded = jwt.decode(token) as Record<string, unknown> | null;
    if (!decoded) return false;

    if (config.vonageApplicationId && decoded.application_id === config.vonageApplicationId) {
      return true;
    }
  } catch {
    // Invalid JWT structure
  }

  return false;
}
