/**
 * Capability guard.
 *
 * Load-time feature detection for the browser calling stack. Calling requires
 * two independent preconditions:
 *
 *   1. A Secure_Context (HTTPS, or localhost/127.0.0.1) so the browser exposes
 *      the powerful media-capture and WebRTC APIs. Reflected by
 *      `window.isSecureContext`.
 *   2. The required WebRTC APIs (`RTCPeerConnection` and `getUserMedia`).
 *
 * When either precondition fails, `callingSupported` is false and the UI
 * disables calling and shows the corresponding message (see `capabilityMessage`).
 *
 * This module is pure and dependency-free so it is trivially testable against
 * jsdom globals.
 *
 * See Requirements 15.1 (detect), 15.2 (insecure context), 15.3 (missing WebRTC).
 */

/** The reason calling cannot be supported in the current environment. */
export type CapabilityMessageKey =
  /** Not a Secure_Context (page is not served over HTTPS/localhost). */
  | "requires a secure (HTTPS) connection"
  /** Required WebRTC APIs are missing. */
  | "unsupported browser";

export interface CapabilityReport {
  /** `window.isSecureContext` — HTTPS or localhost/127.0.0.1. */
  secureContext: boolean;
  /** Whether `RTCPeerConnection` is available. */
  hasRTCPeerConnection: boolean;
  /** Whether `navigator.mediaDevices.getUserMedia` is available. */
  hasGetUserMedia: boolean;
  /** True only when every precondition above is satisfied. */
  callingSupported: boolean;
}

/**
 * Detect whether the current browsing context can support calling.
 *
 * Safe to call at module load / boot time; performs no side effects.
 */
export function detectCapabilities(): CapabilityReport {
  const secureContext =
    typeof window !== "undefined" && window.isSecureContext === true;

  const hasRTCPeerConnection =
    typeof window !== "undefined" &&
    typeof window.RTCPeerConnection === "function";

  const hasGetUserMedia =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function";

  const callingSupported =
    secureContext && hasRTCPeerConnection && hasGetUserMedia;

  return {
    secureContext,
    hasRTCPeerConnection,
    hasGetUserMedia,
    callingSupported,
  };
}

/**
 * Choose the message key the UI shows when calling is disabled.
 *
 * The insecure-context precondition takes priority: an insecure context also
 * hides the WebRTC APIs in many browsers, so citing HTTPS is the more
 * actionable guidance. Returns `null` when calling is supported.
 */
export function capabilityMessage(
  report: CapabilityReport,
): CapabilityMessageKey | null {
  if (report.callingSupported) return null;
  if (!report.secureContext) return "requires a secure (HTTPS) connection";
  return "unsupported browser";
}
