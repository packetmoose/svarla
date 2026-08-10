import { lookup } from 'node:dns/promises';

/**
 * SSRF protection: validates that a push endpoint URL is safe to make requests to.
 *
 * Rules:
 * - Only HTTPS scheme is allowed
 * - Must not resolve to a private/reserved IP range
 * - Must not target localhost or link-local addresses
 */

/** Private and reserved IPv4 CIDR ranges that must be blocked. */
const BLOCKED_IPV4_RANGES = [
  { prefix: '127.', description: 'loopback' },
  { prefix: '10.', description: 'private class A' },
  { prefix: '192.168.', description: 'private class C' },
  { prefix: '169.254.', description: 'link-local' },
  { prefix: '0.', description: 'current network' },
];

/** Private 172.16.0.0/12 range requires numeric check. */
function isPrivate172(ip: string): boolean {
  const parts = ip.split('.');
  if (parts[0] !== '172') return false;
  const second = parseInt(parts[1], 10);
  return second >= 16 && second <= 31;
}

/** Check if an IPv6 address is in a blocked range. */
function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // Loopback
  if (normalized === '::1' || normalized === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // Link-local (fe80::/10)
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe80')) return true;
  // Unique local (fc00::/7 → fc and fd prefixes)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // Unspecified
  if (normalized === '::' || normalized === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  return false;
}

/**
 * Check if an IP address is in a private/reserved range.
 */
function isPrivateIP(ip: string): boolean {
  // IPv6 check
  if (ip.includes(':')) {
    return isBlockedIPv6(ip);
  }

  // IPv4 checks
  for (const range of BLOCKED_IPV4_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }
  if (isPrivate172(ip)) return true;

  return false;
}

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
}

export interface UrlValidationOptions {
  /** When true, skips HTTPS requirement and private IP checks. */
  skipSsrfProtection?: boolean;
}

/**
 * Validates a push endpoint URL for SSRF safety.
 * - Must be HTTPS (unless SSRF protection is disabled)
 * - Must resolve to a public IP address (unless SSRF protection is disabled)
 *
 * When skipSsrfProtection is true, only basic URL format validation is performed.
 * Use this when the UnifiedPush server is on the same private LAN as this server.
 */
export async function validatePushEndpointUrl(
  url: string,
  options?: UrlValidationOptions
): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Basic scheme check: must be http or https
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'Push endpoint URL must use HTTP or HTTPS' };
  }

  // If SSRF protection is disabled, allow any valid HTTP/HTTPS URL
  if (options?.skipSsrfProtection) {
    return { valid: true };
  }

  // Only allow HTTPS when SSRF protection is enabled
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Push endpoint URL must use HTTPS (set PUSH_ENDPOINT_SSRF_PROTECTION=false to allow HTTP for private LAN setups)' };
  }

  // Block common localhost hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return { valid: false, error: 'Push endpoint URL must not target localhost or internal hosts' };
  }

  // Resolve DNS and check the IP
  try {
    const result = await lookup(hostname, { all: true });
    for (const entry of result) {
      if (isPrivateIP(entry.address)) {
        return {
          valid: false,
          error: 'Push endpoint URL resolves to a private/reserved IP address',
        };
      }
    }
  } catch {
    return { valid: false, error: 'Push endpoint URL hostname could not be resolved' };
  }

  return { valid: true };
}
