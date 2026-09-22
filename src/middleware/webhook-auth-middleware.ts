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
 * Why a webhook verification attempt failed. `ok` means the request is
 * authentic. All other values are non-authentic and carry enough detail to
 * diagnose misconfiguration without leaking the secret itself.
 */
export type VonageVerifyReason =
  | 'ok'
  | 'no_auth_header'
  | 'not_bearer'
  | 'no_secret'
  | 'signature_invalid'
  | 'app_id_mismatch';

export interface VonageVerifyResult {
  ok: boolean;
  reason: VonageVerifyReason;
  /** JWT header alg, when the token could be decoded (for diagnostics). */
  alg?: string;
  /** api_key claim from the token, when present (for diagnostics). */
  tokenApiKey?: string;
  /** Whether an application_id claim was present on the token. */
  hasAppIdClaim?: boolean;
}

/**
 * Verify the Vonage JWT on a webhook request and explain the outcome.
 *
 * Vonage signs webhook JWTs (HS256) with the account "signature secret". We
 * verify that signature with the provider's configured secret. The
 * `application_id` claim, when configured, is checked as an additional guard —
 * but it is NOT a substitute for signature verification: `application_id` is a
 * public, non-secret value, so trusting the claim alone would let a forged
 * token through.
 *
 * Fails closed: if the signing secret is not configured, the request is
 * rejected. There is deliberately no unverified-decode fallback.
 */
export function verifyVonageWebhookJwtDetailed(
  request: FastifyRequest,
  config: WebhookAuthConfig
): VonageVerifyResult {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return { ok: false, reason: 'no_auth_header' };
  }
  if (!authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'not_bearer' };
  }

  const token = authHeader.slice(7);

  // Decode (without verifying) purely to surface diagnostic metadata. This is
  // NOT used for any authorization decision.
  let alg: string | undefined;
  let tokenApiKey: string | undefined;
  let hasAppIdClaim: boolean | undefined;
  try {
    const complete = jwt.decode(token, { complete: true }) as {
      header?: { alg?: string };
      payload?: Record<string, unknown>;
    } | null;
    alg = complete?.header?.alg;
    tokenApiKey = complete?.payload?.api_key as string | undefined;
    hasAppIdClaim = complete?.payload?.application_id !== undefined;
  } catch {
    // ignore — diagnostics only
  }

  if (!config.vonageApiSecret) {
    return { ok: false, reason: 'no_secret', alg, tokenApiKey, hasAppIdClaim };
  }

  try {
    // Accept both HS256 (Messages/Voice signed webhooks) and RS256, matching
    // the algorithms Vonage's own SDK allows. With a shared-secret string,
    // only HS256 can actually verify; RS256 is included for parity/future use.
    const decoded = jwt.verify(token, config.vonageApiSecret, {
      algorithms: ['HS256', 'RS256'],
    }) as Record<string, unknown>;

    if (config.vonageApplicationId && decoded.application_id !== config.vonageApplicationId) {
      return { ok: false, reason: 'app_id_mismatch', alg, tokenApiKey, hasAppIdClaim: true };
    }

    return { ok: true, reason: 'ok', alg, tokenApiKey, hasAppIdClaim };
  } catch {
    return { ok: false, reason: 'signature_invalid', alg, tokenApiKey, hasAppIdClaim };
  }
}

/**
 * Boolean convenience wrapper around {@link verifyVonageWebhookJwtDetailed}.
 * Returns true only if the JWT's signature is cryptographically valid.
 */
export function verifyVonageWebhookJwt(
  request: FastifyRequest,
  config: WebhookAuthConfig
): boolean {
  return verifyVonageWebhookJwtDetailed(request, config).ok;
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
