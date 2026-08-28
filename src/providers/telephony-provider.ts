/**
 * Core telephony provider types and interface.
 *
 * The TelephonyProvider is the abstraction layer between the server's core logic
 * and the underlying telephony backend. All call and SMS operations flow through
 * this interface. The active provider is selected via server configuration at startup.
 *
 * Implementations handle the specifics of a telephony backend (Vonage, 46elks, etc.)
 * The server core never directly calls vendor-specific APIs — it always goes through this interface.
 */

// --- Capability and state types ---

export type NumberCapability = "VOICE" | "SMS" | "MMS";

export type CallState = "RINGING" | "ANSWERED" | "COMPLETED" | "FAILED" | "BUSY";

export type SmsDeliveryStatus = "DELIVERED" | "FAILED";

// --- Result types ---

export interface CallInitResult {
  /** Provider-specific call ID */
  callId: string;
  /** Token for client SDK connection (e.g., Vonage JWT), null if not applicable */
  clientToken: string | null;
}

export interface CallAnswerResult {
  success: boolean;
  /** Token for WebRTC/SIP connection on the answering device */
  clientToken: string | null;
  errorReason: string | null;
}

export interface SmsResult {
  /** Provider-specific message ID */
  messageId: string;
  success: boolean;
  errorReason: string | null;
}

export interface ProviderNumber {
  /** Phone number in E.164 format */
  number: string;
  /** Set of capabilities this number supports */
  capabilities: Set<NumberCapability>;
}

// --- Event types ---

export type TelephonyEvent =
  | { type: "incoming_call"; callId: string; from: string; to: string; timestamp: number }
  | { type: "call_state_changed"; callId: string; state: CallState; timestamp: number; durationSeconds: number | null }
  | { type: "incoming_sms"; messageId: string; from: string; to: string; body: string; timestamp: number }
  | { type: "sms_status_update"; messageId: string; status: SmsDeliveryStatus };

// --- Provider interface ---

export interface TelephonyProvider {
  /** Unique identifier for this provider (e.g., "vonage", "46elks") */
  readonly providerId: string;

  /** Whether this provider supports encrypted SIP (sips:). Defaults to false if not implemented. */
  readonly supportsSips?: boolean;

  /** Whether this provider uses WebSocket audio to connect to MediaBridge (instead of SIP). */
  readonly usesWebSocketAudio?: boolean;

  /** Initiate an outbound call from the given source number to the destination. */
  makeCall(from: string, to: string, sipUri?: string): Promise<CallInitResult>;

  /** End an active call by its provider-specific call ID. */
  endCall(callId: string): Promise<void>;

  /** Answer an incoming call on the specified device. Returns connection details for the client. */
  answerCall(callId: string, deviceId: string, audioWsUrl?: string): Promise<CallAnswerResult>;

  /** Send an SMS message from the given source number. */
  sendSms(from: string, to: string, body: string): Promise<SmsResult>;

  /** List all available phone numbers from the telephony backend. */
  listNumbers(): Promise<ProviderNumber[]>;

  /** Register a listener for inbound events (incoming calls, SMS, call state changes). */
  onEvent(listener: (event: TelephonyEvent) => void): void;

  /** Start the provider (connect to APIs, start listening for webhooks/signals). */
  start(): Promise<void>;

  /** Stop the provider and release resources. */
  stop(): Promise<void>;

  /** Return the webhook endpoint suffixes this provider type requires. */
  getWebhookEndpoints(): string[];

  /**
   * Handle an incoming webhook request for a given endpoint.
   * Returns a response body to send back to the caller.
   */
  handleWebhook(endpoint: string, body: unknown, request: unknown): Promise<unknown>;
}
