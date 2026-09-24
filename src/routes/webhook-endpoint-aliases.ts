/**
 * Cross-provider webhook endpoint normalization.
 *
 * Different telephony providers historically use different suffixes for the
 * same logical webhook. Vonage uses `inbound-sms` / `sms-status` / `answer` /
 * `event`, while 46elks uses `sms_incoming` / `voice_start` / `voice_event`.
 *
 * This module lets a request use either the provider's native suffix OR a
 * canonical/alias name, and resolves it to the suffix the provider actually
 * implements. Existing configurations that use the native suffix keep working
 * unchanged (they match directly, before any alias resolution runs), so this
 * is fully backward compatible.
 *
 * See: https://github.com/packetmoose/svarla/issues/31
 */

/**
 * Alias groups: every entry in a group is considered equivalent. When a
 * requested endpoint is not directly supported by a provider, we look up the
 * group it belongs to and try to resolve it to one of the provider's supported
 * endpoints within the same group.
 *
 * Matching is case-insensitive and treats `-` and `_` as interchangeable, so
 * `sms_incoming`, `sms-incoming`, and `SMS_INCOMING` all resolve identically.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  // Inbound SMS
  ['inbound-sms', 'sms-incoming', 'sms_incoming', 'incoming-sms'],
  // SMS delivery status
  ['sms-status', 'sms_status'],
  // Inbound/answer voice webhook (call setup)
  ['answer', 'voice-answer', 'voice-start', 'voice_start'],
  // Voice call lifecycle events
  ['event', 'voice-event', 'voice_event'],
];

/**
 * Endpoints a provider type accepts even though they are not returned by
 * `getWebhookEndpoints()`. 46elks' `voice_event` is set per-call as the
 * `whenhangup` URL rather than statically configured, so it is intentionally
 * absent from the provider's listed endpoints but must still be accepted.
 */
const EXTRA_SUPPORTED_ENDPOINTS: Record<string, readonly string[]> = {
  '46elks': ['voice_event'],
};

/** Normalize a suffix for comparison: lowercased, `_` and `-` unified. */
function canonicalKey(endpoint: string): string {
  return endpoint.trim().toLowerCase().replace(/_/g, '-');
}

/** Find the alias group (as a set of canonical keys) an endpoint belongs to. */
function findAliasGroupKeys(endpoint: string): Set<string> | undefined {
  const key = canonicalKey(endpoint);
  for (const group of ALIAS_GROUPS) {
    if (group.some((member) => canonicalKey(member) === key)) {
      return new Set(group.map(canonicalKey));
    }
  }
  return undefined;
}

/**
 * Resolve a requested webhook endpoint to the suffix the provider implements.
 *
 * Resolution order:
 * 1. Exact match against a supported endpoint (native names — no behavior change).
 * 2. Alias match: if the requested endpoint shares an alias group with one of
 *    the provider's supported endpoints, resolve to that supported endpoint.
 *
 * @param requestedEndpoint  The suffix from the incoming webhook URL.
 * @param supportedEndpoints The provider's endpoints (from getWebhookEndpoints()),
 *                           plus any provider-type extras (e.g. 46elks voice_event).
 * @returns The resolved supported endpoint, or `undefined` if unsupported.
 */
export function resolveWebhookEndpoint(
  requestedEndpoint: string,
  supportedEndpoints: readonly string[],
): string | undefined {
  if (!requestedEndpoint) return undefined;

  // 1. Exact match (case-sensitive) — native names behave exactly as before.
  if (supportedEndpoints.includes(requestedEndpoint)) {
    return requestedEndpoint;
  }

  // 2. Alias resolution within the same logical group.
  const groupKeys = findAliasGroupKeys(requestedEndpoint);
  if (groupKeys) {
    for (const supported of supportedEndpoints) {
      if (groupKeys.has(canonicalKey(supported))) {
        return supported;
      }
    }
  }

  return undefined;
}

/**
 * Return the full set of endpoints a provider accepts: the statically listed
 * endpoints plus any provider-type extras that are valid but not listed.
 */
export function getAcceptedEndpoints(
  providerType: string,
  listedEndpoints: readonly string[],
): string[] {
  const extras = EXTRA_SUPPORTED_ENDPOINTS[providerType] ?? [];
  return [...listedEndpoints, ...extras];
}
