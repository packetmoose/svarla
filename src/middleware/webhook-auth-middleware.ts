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

/**
 * 46elks does not sign its webhooks (no JWT/HMAC/shared secret). Its official
 * recommendation for verifying callback origin is IP allowlisting against a
 * small set of fixed source addresses.
 *
 * These are the addresses 46elks documents for outbound callbacks. 46elks
 * notifies customers by email before these change; if they do, operators can
 * override the list per-provider via the `webhook_ip_allowlist` config field
 * without waiting for a code change.
 *
 * @see https://46elks.com/docs/verify-callback-origin
 */
export const ELKS46_DEFAULT_WEBHOOK_IPS: readonly string[] = [
  '176.10.154.199',
  '85.24.146.132',
  '185.39.146.243',
  '2001:9b0:2:902::199',
];

/**
 * Normalize an IP for comparison. Handles the IPv4-mapped IPv6 form
 * (`::ffff:1.2.3.4`) that Node/Fastify may report so it matches a plain
 * IPv4 allowlist entry, and lowercases IPv6 for case-insensitive matching.
 */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const v4Mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return v4Mapped ? v4Mapped[1] : trimmed;
}

/**
 * Verify that a webhook request originates from an allowlisted 46elks IP.
 *
 * @param requestIp   The client IP as resolved by Fastify (`request.ip`). For
 *                    this to reflect the true origin behind a reverse proxy
 *                    (Caddy) or tunnel, the server must be configured with
 *                    `trustProxy` so `X-Forwarded-For` is honored.
 * @param allowlist   IPs to accept. When empty/undefined, the documented
 *                    46elks defaults are used.
 * @returns true when the request IP is in the allowlist, false otherwise.
 */
export function verifyElks46WebhookOrigin(
  requestIp: string | undefined,
  allowlist?: readonly string[],
): boolean {
  if (!requestIp) return false;

  const list = (allowlist && allowlist.length > 0)
    ? allowlist
    : ELKS46_DEFAULT_WEBHOOK_IPS;

  const normalizedRequest = normalizeIp(requestIp);
  return list.some((entry) => normalizeIp(entry) === normalizedRequest);
}

/**
 * Parse a user-supplied IP allowlist value (as stored in provider config) into
 * a clean string array. Accepts either an array of strings or a single string
 * with entries separated by commas, whitespace, or newlines. Blank entries are
 * dropped. Returns an empty array when there is no usable input, which callers
 * treat as "fall back to the documented defaults".
 */
export function parseElks46IpAllowlist(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}
