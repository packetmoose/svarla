import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { normalizeInboundNumber } from '../validators/phone-number-validator.js';
import type {
  TelephonyProvider,
  CallInitResult,
  CallAnswerResult,
  SmsResult,
  ProviderNumber,
  TelephonyEvent,
  CallState,
  SmsDeliveryStatus,
} from './telephony-provider.js';
import { buildOutboundCallNcco, buildSipConnectNcco } from './ncco-builder.js';
import type { NccoAction } from './ncco-builder.js';

/**
 * Configuration for the Vonage telephony provider.
 * Maps to the `telephony.vonage` section of server-config.yaml.
 */
export interface VonageProviderConfig {
  apiKey: string;
  apiSecret: string;
  applicationId: string;
  /** PEM private key content. Preferred over privateKeyPath. */
  privateKey?: string;
  /** Path to PEM private key file. Used as fallback if privateKey is not provided. */
  privateKeyPath?: string;
  webhookBaseUrl: string;
  /** Whether the provider supports encrypted SIP (sips:). Defaults to true for Vonage. */
  supportsSips?: boolean;
}

/**
 * Vonage call event status values received from webhooks.
 */
type VonageCallStatus =
  | 'started'
  | 'ringing'
  | 'answered'
  | 'completed'
  | 'failed'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'rejected'
  | 'unanswered';

/**
 * Maps Vonage webhook call status strings to internal CallState values.
 */
function mapVonageStatusToCallState(status: VonageCallStatus): CallState | null {
  switch (status) {
    case 'started':
    case 'ringing':
      return 'RINGING';
    case 'answered':
      return 'ANSWERED';
    case 'completed':
      return 'COMPLETED';
    case 'busy':
    case 'rejected':
      return 'BUSY';
    case 'failed':
    case 'cancelled':
    case 'timeout':
    case 'unanswered':
      return 'FAILED';
    default:
      return null;
  }
}

/**
 * Vonage implementation of the TelephonyProvider interface.
 *
 * Uses the Vonage Voice API for calls (via NCCO/webhooks),
 * Vonage Messages API for SMS, and Vonage Numbers API for number listing.
 */
export class VonageTelephonyProvider implements TelephonyProvider {
  readonly providerId = 'vonage';

  protected readonly config: VonageProviderConfig;
  private eventListeners: Array<(event: TelephonyEvent) => void> = [];
  private privateKey: string | null = null;
  private vonageClient: VonageVoiceClient | null = null;
  private messagesClient: VonageMessagesClient | null = null;

  constructor(config: VonageProviderConfig) {
    this.config = config;
  }

  /**
   * Whether this provider supports encrypted SIP (sips:).
   * Defaults to true for Vonage since it supports TLS SIP.
   */
  get supportsSips(): boolean {
    return this.config.supportsSips ?? true;
  }

  /**
   * Initialize the Vonage SDK client and load the private key.
   */
  async start(): Promise<void> {
    if (this.config.privateKey) {
      this.privateKey = this.config.privateKey;
    } else if (this.config.privateKeyPath) {
      this.privateKey = readFileSync(this.config.privateKeyPath, 'utf-8');
    } else {
      throw new Error('VonageTelephonyProvider requires either privateKey content or privateKeyPath');
    }
    // Lazily import @vonage/server-sdk to allow mocking in tests
    const { Vonage } = await import('@vonage/server-sdk');
    const client = new Vonage({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      applicationId: this.config.applicationId,
      privateKey: this.privateKey,
    });
    this.vonageClient = client.voice as unknown as VonageVoiceClient;
    this.messagesClient = client.messages as unknown as VonageMessagesClient;
  }

  async stop(): Promise<void> {
    this.vonageClient = null;
    this.messagesClient = null;
    this.privateKey = null;
  }

  /**
   * Initiate an outbound call using Vonage Voice API with inline NCCO.
   *
   * When sipUri is provided (new architecture), the NCCO connects Vonage to
   * the MediaBridge SIP endpoint. When sipUri is not provided (legacy mode),
   * the NCCO connects to the destination phone directly.
   */
  async makeCall(from: string, to: string, sipUri?: string): Promise<CallInitResult> {
    if (!this.vonageClient) {
      throw new Error('VonageTelephonyProvider not started. Call start() first.');
    }

    // Build NCCO: if sipUri is provided, route audio to MediaBridge SIP endpoint
    const ncco = sipUri
      ? buildSipConnectNcco(sipUri, from, `${this.config.webhookBaseUrl}/webhooks/event`)
      : buildOutboundCallNcco(
          to,
          from,
          `${this.config.webhookBaseUrl}/webhooks/event`
        );

    const result = await this.vonageClient.createOutboundCall({
      to: [{ type: 'phone', number: to }],
      from: { type: 'phone', number: from },
      ncco: ncco as unknown[],
      eventUrl: [`${this.config.webhookBaseUrl}/webhooks/event`],
    });

    return {
      callId: result.uuid,
      clientToken: null,
    };
  }

  /**
   * End an active call by hanging up via Vonage Voice API.
   */
  async endCall(callId: string): Promise<void> {
    if (!this.privateKey) {
      throw new Error('VonageTelephonyProvider not started. Call start() first.');
    }

    // Use REST API to hang up the call
    const jwt = this.generateApiToken();
    const response = await fetch(`https://api-eu-3.vonage.com/v1/calls/${callId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'hangup' }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[VonageProvider] Hangup failed: ${response.status} ${errorText}`);
      throw new Error(`Hangup failed: ${response.status}`);
    }
  }

  /**
   * Answer an incoming call on the specified device.
   * In the new architecture, call answering is handled by the CallOrchestrator
   * which manages the MediaBridge session. This method is a no-op.
   */
  async answerCall(_callId: string, _deviceId: string): Promise<CallAnswerResult> {
    // Call answering is now handled by CallOrchestrator via MediaBridge.
    // The provider doesn't need to transfer calls to app users anymore.
    return {
      success: true,
      clientToken: null,
      errorReason: null,
    };
  }

  /**
   * Send an SMS message using the Vonage Messages API.
   */
  async sendSms(from: string, to: string, body: string): Promise<SmsResult> {
    if (!this.messagesClient) {
      throw new Error('VonageTelephonyProvider not started. Call start() first.');
    }

    try {
      const result = await this.messagesClient.send({
        messageType: 'text',
        text: body,
        to,
        from,
        channel: 'sms',
      });

      return {
        messageId: result.messageUuid,
        success: true,
        errorReason: null,
      };
    } catch (error) {
      return {
        messageId: '',
        success: false,
        errorReason: error instanceof Error ? error.message : 'Failed to send SMS',
      };
    }
  }

  async listNumbers(): Promise<ProviderNumber[]> {
    const { Vonage } = await import('@vonage/server-sdk');
    const client = new Vonage({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
    });

    const response = await (client.numbers as any).getOwnedNumbers({
      application_id: this.config.applicationId,
    });
    const numbers = response?.numbers ?? [];

    return numbers.map((n: { msisdn: string; features?: string[] }) => ({
      number: `+${n.msisdn}`,
      capabilities: new Set(
        (n.features ?? []).map((f: string) => {
          if (f === 'SMS') return 'SMS';
          if (f === 'VOICE') return 'VOICE';
          if (f === 'MMS') return 'MMS';
          return f;
        }).filter((f: string) => ['SMS', 'VOICE', 'MMS'].includes(f))
      ) as Set<'SMS' | 'VOICE' | 'MMS'>,
    }));
  }

  onEvent(listener: (event: TelephonyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Return the webhook endpoint suffixes for the Vonage provider type.
   */
  getWebhookEndpoints(): string[] {
    return ['answer', 'event', 'inbound-sms', 'sms-status'];
  }

  /**
   * Handle an incoming webhook request by delegating to the appropriate handler
   * based on the endpoint suffix.
   *
   * The request parameter can optionally include a sipUri context for the 'answer'
   * endpoint, which is set by the CallOrchestrator for inbound calls routed through
   * the MediaBridge.
   */
  async handleWebhook(endpoint: string, body: unknown, _request: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'answer':
        return this.generateAnswerNccoFromWebhook(
          body as Record<string, unknown>,
          _request as { sipUri?: string } | undefined,
        );
      case 'event': {
        const eventBody = body as {
          uuid?: string;
          status?: string;
          from?: string;
          to?: string;
          direction?: string;
          duration?: string;
          timestamp?: string;
        };
        // Skip SDK leg events (legs connecting Vonage to app users).
        // These are internal events for the app-user delivery leg, not actual PSTN call state changes.
        // SDK legs are identified by the 'to' field starting with 'device-' (the provider_user_name pattern).
        const isInternalSdkLeg = eventBody.to?.startsWith('device-');
        if (!isInternalSdkLeg) {
          this.processCallEvent(eventBody);
        }
        return {};
      }
      case 'inbound-sms':
        this.processSmsEvent(body as {
          message_uuid?: string;
          from?: string;
          to?: string;
          text?: string;
          timestamp?: string;
        });
        return {};
      case 'sms-status':
        this.processSmsStatusEvent(body as {
          message_uuid?: string;
          status?: string;
        });
        return {};
      default:
        return {};
    }
  }

  /**
   * Emit an event to all registered listeners.
   * Used internally when processing webhooks/signals from Vonage.
   */
  protected emitEvent(event: TelephonyEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /**
   * Generate NCCO for the answer webhook, handling both SDK-initiated outbound
   * calls (which include custom_data) and inbound PSTN calls.
   *
   * When context.sipUri is provided (new MediaBridge architecture), inbound calls
   * are connected to the MediaBridge SIP endpoint instead of to an app user.
   */
  private generateAnswerNccoFromWebhook(
    body: Record<string, unknown>,
    context?: { sipUri?: string },
  ): NccoAction[] {
    const from = (body.from as string) ?? '';
    const to = (body.to as string) ?? '';
    const direction = body.direction as string | undefined;
    const customData = body.custom_data as string | undefined;
    const fromUser = body.from_user as string | undefined;

    // If sipUri is provided in context, route through MediaBridge
    const sipUri = context?.sipUri;

    // Detect SDK-initiated outbound call:
    // - has custom_data (app passes from/to as JSON)
    // - or has from_user (Client SDK identifies the caller as an app user)
    const isOutboundSdkCall = !!customData || !!fromUser;

    if (isOutboundSdkCall) {
      // SDK-initiated outbound call: parse custom_data for the real from/to
      let callFrom = from;
      let callTo = to;
      if (customData) {
        try {
          const parsed = JSON.parse(customData);
          callFrom = parsed.from || from;
          callTo = parsed.to || to;
        } catch {
          // custom_data wasn't valid JSON, use top-level from/to
        }
      }
      return this.generateAnswerNcco({ from: callFrom, to: callTo, direction: 'outbound', sipUri });
    }

    if (direction === 'outbound') {
      return this.generateAnswerNcco({ from, to, direction: 'outbound', sipUri });
    }

    // Inbound PSTN call — connect to MediaBridge SIP if sipUri provided
    return this.generateAnswerNcco({ from, to, sipUri });
  }

  /**
   * Generate NCCO for the answer webhook.
   * Determines whether the call is inbound or outbound based on the request parameters.
   *
   * When sipUri is provided, uses SIP connect action to route audio through
   * the MediaBridge instead of connecting to an app user or directly to a phone.
   */
  generateAnswerNcco(params: {
    from: string;
    to: string;
    direction?: string;
    sipUri?: string;
  }): NccoAction[] {
    // If sipUri is provided, always connect to MediaBridge via SIP
    if (params.sipUri) {
      return buildSipConnectNcco(params.sipUri, params.from);
    }

    if (params.direction === 'outbound') {
      return buildOutboundCallNcco(params.to, params.from);
    }
    // Inbound call: use SIP connect to MediaBridge (sipUri must be provided by CallOrchestrator)
    // If no sipUri is available, return a hold tone as a safe fallback
    return [{ action: 'talk', text: ' ', bargeIn: false, loop: 0 }];
  }

  /**
   * Process a Vonage call event webhook payload.
   * Emits appropriate TelephonyEvent based on the event data.
   */
  processCallEvent(eventData: {
    uuid?: string;
    status?: string;
    from?: string;
    to?: string;
    direction?: string;
    duration?: string;
    timestamp?: string;
  }): void {
    const callId = eventData.uuid;
    if (!callId) return;

    const status = eventData.status as VonageCallStatus | undefined;
    if (!status) return;

    const timestamp = eventData.timestamp
      ? new Date(eventData.timestamp).getTime()
      : Date.now();

    // Emit incoming_call event for new inbound calls
    if (status === 'started' && eventData.direction === 'inbound') {
      this.emitEvent({
        type: 'incoming_call',
        callId,
        from: eventData.from ?? '',
        to: eventData.to ?? '',
        timestamp,
      });
      return;
    }

    // Map status to internal call state and emit call_state_changed
    const callState = mapVonageStatusToCallState(status);
    if (callState) {
      const durationSeconds = eventData.duration
        ? parseInt(eventData.duration, 10)
        : null;

      this.emitEvent({
        type: 'call_state_changed',
        callId,
        state: callState,
        timestamp,
        durationSeconds: Number.isNaN(durationSeconds) ? null : durationSeconds,
      });
    }
  }

  /**
   * Process an inbound SMS webhook payload from Vonage.
   * Emits an incoming_sms TelephonyEvent.
   */
  processSmsEvent(eventData: {
    message_uuid?: string;
    from?: string;
    to?: string;
    text?: string;
    timestamp?: string;
  }): void {
    const messageId = eventData.message_uuid;
    if (!messageId) return;

    const rawFrom = eventData.from;
    if (!rawFrom) return;

    const rawTo = eventData.to;
    if (!rawTo) return;

    // Vonage sends numbers without + prefix — normalize to E.164
    // Non-numeric from values (custom sender names) should not get a + prefix
    // Short codes (≤6 digits, not starting with 0) should not get a + prefix
    const from = normalizeInboundNumber(rawFrom);
    const to = rawTo.startsWith('+') ? rawTo : `+${rawTo}`;

    const body = eventData.text ?? '';

    const timestamp = eventData.timestamp
      ? new Date(eventData.timestamp).getTime()
      : Date.now();

    this.emitEvent({
      type: 'incoming_sms',
      messageId,
      from,
      to,
      body,
      timestamp,
    });
  }

  /**
   * Process an SMS status webhook payload from Vonage (delivery receipts).
   * Emits an sms_status_update TelephonyEvent.
   */
  processSmsStatusEvent(eventData: {
    message_uuid?: string;
    status?: string;
  }): void {
    const messageId = eventData.message_uuid;
    if (!messageId) return;

    const status = eventData.status;
    if (!status) return;

    const deliveryStatus = mapVonageSmsStatus(status);
    if (!deliveryStatus) return;

    this.emitEvent({
      type: 'sms_status_update',
      messageId,
      status: deliveryStatus,
    });
  }

  /**
   * Generate a JWT for Vonage Voice REST API authentication.
   * This is simpler than the Client SDK token — no sub or ACL needed.
   */
  private generateApiToken(): string {
    if (!this.privateKey) {
      throw new Error('Private key not loaded');
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now,
      exp: now + 300, // 5 minute expiry is sufficient for API calls
      jti: `${now}-${Math.random().toString(36).slice(2)}`,
      application_id: this.config.applicationId,
    };

    return jwt.sign(payload, this.privateKey, { algorithm: 'RS256' });
  }
}

/**
 * Maps Vonage SMS status webhook values to internal SmsDeliveryStatus.
 */
function mapVonageSmsStatus(status: string): SmsDeliveryStatus | null {
  switch (status) {
    case 'delivered':
      return 'DELIVERED';
    case 'failed':
    case 'rejected':
    case 'undeliverable':
      return 'FAILED';
    default:
      return null;
  }
}

/**
 * Minimal interface for the Vonage Voice client methods we use.
 * This allows tests to mock without importing the full SDK.
 */
interface VonageVoiceClient {
  createOutboundCall(params: {
    to: Array<{ type: string; number: string }>;
    from: { type: string; number: string };
    ncco: unknown[];
    eventUrl?: string[];
  }): Promise<{ uuid: string; status: string; direction: string; conversationUUID: string }>;
  hangupCall(uuid: string): Promise<void>;
}

/**
 * Minimal interface for the Vonage Messages client methods we use.
 */
interface VonageMessagesClient {
  send(params: {
    messageType: string;
    text: string;
    to: string;
    from: string;
    channel: string;
  }): Promise<{ messageUuid: string }>;
}

export { mapVonageStatusToCallState, mapVonageSmsStatus };
export type { VonageCallStatus, VonageMessagesClient };
