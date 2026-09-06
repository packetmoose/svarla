import { normalizeInboundNumber } from '../validators/phone-number-validator.js';
import type {
  TelephonyProvider,
  CallInitResult,
  CallAnswerResult,
  SmsResult,
  ProviderNumber,
  TelephonyEvent,
  CallState,
} from './telephony-provider.js';

/**
 * Configuration for the 46elks telephony provider.
 * Maps to the provider config stored in the database.
 *
 * Requirements: 7.9
 */
export interface Elks46ProviderConfig {
  apiUsername: string;
  apiPassword: string;
  webhookBaseUrl: string;
  /** Registry-assigned ID used to construct webhook URLs (defaults to '46elks') */
  registryId?: string;
  /** 46elks WebSocket number (e.g. +4600...) used for audio routing */
  websocketNumber?: string;
}

/**
 * 46elks call status values received from webhooks.
 */
type Elks46CallStatus = 'ongoing' | 'success' | 'failed' | 'busy' | 'no-answer';

/**
 * Maps 46elks webhook call status strings to internal CallState values.
 */
function mapElks46StatusToCallState(status: Elks46CallStatus): CallState | null {
  switch (status) {
    case 'ongoing':
      return 'ANSWERED';
    case 'success':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'busy':
      return 'BUSY';
    case 'no-answer':
      return 'FAILED';
    default:
      return null;
  }
}

/**
 * 46elks implementation of the TelephonyProvider interface.
 *
 * Uses the 46elks REST API for calls and SMS with HTTP Basic Authentication.
 * Call audio is routed through the MediaBridge via SIP URI using the
 * voice_start webhook response.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9
 */
export class Elks46TelephonyProvider implements TelephonyProvider {
  readonly providerId = '46elks';

  private readonly config: Elks46ProviderConfig;
  private eventListeners: Array<(event: TelephonyEvent) => void> = [];
  private authHeader: string;

  /** Maps 46elks call ID → MediaBridge SIP URI for voice_start webhook responses */
  private readonly pendingCallSipUris = new Map<string, string>();

  constructor(config: Elks46ProviderConfig) {
    this.config = config;
    // HTTP Basic Authentication: base64(apiUsername:apiPassword)
    this.authHeader = `Basic ${btoa(`${config.apiUsername.trim()}:${config.apiPassword.trim()}`)}`;
  }

  async start(): Promise<void> {
    // No SDK initialization needed — 46elks uses simple REST with Basic Auth
  }

  async stop(): Promise<void> {
    // No resources to release
  }

  /**
   * Initiate an outbound call via 46elks Calls API.
   *
   * POST https://api.46elks.com/a1/calls
   * Body (form-encoded): from, to, voice_start (webhook URL)
   *
   * The voice_start webhook URL points to this provider's voice_start endpoint,
   * which will return JSON instructing 46elks to connect the call to the
   * MediaBridge SIP URI.
   *
   * Requirements: 7.2, 7.6, 7.7
   */
  async makeCall(from: string, to: string, sipUri?: string): Promise<CallInitResult> {
    const webhookProviderId = this.config.registryId ?? this.providerId;
    const voiceStartUrl = `${this.config.webhookBaseUrl}/webhooks/${webhookProviderId}/voice_start`;
    const voiceEventUrl = `${this.config.webhookBaseUrl}/webhooks/${webhookProviderId}/voice_event`;

    const body = new URLSearchParams({
      from,
      to,
      voice_start: voiceStartUrl,
      whenhangup: voiceEventUrl,
    });

    const response = await fetch('https://api.46elks.com/a1/calls', {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`46elks makeCall failed: ${response.status} ${errorText}`);
    }

    const result = await response.json() as { id: string };

    // Store the SIP URI so the voice_start webhook can return it
    if (sipUri) {
      this.pendingCallSipUris.set(result.id, sipUri);
    }

    return {
      callId: result.id,
      clientToken: null,
    };
  }

  /**
   * End an active call.
   *
   * For WebSocket-based calls: the MediaBridge sends {"t":"bye"} on the
   * WebSocket connection, which signals 46elks to end the call.
   *
   * For API-initiated calls that haven't connected to WebSocket yet:
   * DELETE https://api.46elks.com/a1/calls/{callId}
   *
   * Requirements: 7.2
   */
  async endCall(callId: string): Promise<void> {
    const response = await fetch(`https://api.46elks.com/a1/calls/${callId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': this.authHeader,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 404 means call already ended — not an error
      if (response.status === 404) {
        return;
      }
      console.error(`[Elks46Provider] Hangup failed: ${response.status} ${errorText}`);
      throw new Error(`Hangup failed: ${response.status}`);
    }
  }

  /**
   * Answer an incoming call.
   *
   * For 46elks, answering is handled by the voice_start webhook response
   * returning a "connect" action pointing to the MediaBridge SIP URI.
   * This method is a no-op since the webhook handler does the work.
   *
   * Requirements: 7.3, 7.7
   */
  async answerCall(_callId: string, _deviceId: string): Promise<CallAnswerResult> {
    // Answering is handled via the voice_start webhook response
    // which connects the call to the MediaBridge SIP URI.
    return {
      success: true,
      clientToken: null,
      errorReason: null,
    };
  }

  /**
   * Send an SMS via 46elks SMS API.
   *
   * POST https://api.46elks.com/a1/sms
   * Body (form-encoded): from, to, message
   *
   * Requirements: 7.4, 7.6
   */
  async sendSms(from: string, to: string, body: string): Promise<SmsResult> {
    const params = new URLSearchParams({
      from,
      to,
      message: body,
    });

    try {
      const response = await fetch('https://api.46elks.com/a1/sms', {
        method: 'POST',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          messageId: '',
          success: false,
          errorReason: `46elks SMS failed: ${response.status} ${errorText}`,
        };
      }

      const result = await response.json() as { id: string };

      return {
        messageId: result.id,
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

  /**
   * List available numbers from 46elks Numbers API.
   *
   * GET https://api.46elks.com/a1/numbers
   * Maps capabilities (voice, sms) to ProviderNumber format.
   *
   * Requirements: 7.8
   */
  async listNumbers(): Promise<ProviderNumber[]> {
    const response = await fetch('https://api.46elks.com/a1/numbers', {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`[Elks46Provider] Failed to list numbers: ${response.status} ${response.statusText} — ${body}`);
    }

    const result = await response.json() as {
      data: Array<{
        number: string;
        active: string;
        capabilities: string[];
      }>;
    };

    return (result.data ?? [])
      .filter((n) => n.active === 'yes')
      .filter((n) => n.number !== this.config.websocketNumber)
      .filter((n) => !n.number.startsWith('+4600'))
      .map((n) => ({
        number: n.number,
        capabilities: new Set(
          (n.capabilities ?? [])
            .map((cap: string) => {
              if (cap === 'voice') return 'VOICE';
              if (cap === 'sms') return 'SMS';
              if (cap === 'mms') return 'MMS';
              return null;
            })
            .filter((cap): cap is 'VOICE' | 'SMS' | 'MMS' => cap !== null),
        ),
      }));
  }

  onEvent(listener: (event: TelephonyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Return the webhook endpoint suffixes for the 46elks provider.
   *
   * Requirements: 7.10
   */
  getWebhookEndpoints(): string[] {
    return ['voice_start', 'voice_event', 'sms_incoming'];
  }

  /**
   * Build the absolute `whenhangup` webhook URL for this provider.
   *
   * 46elks calls this URL (via POST) when a call leg ends, including when the
   * remote CALLER hangs up. Both outbound (via {@link makeCall}) and inbound
   * (via the voice_start connect response) calls must register it so the server
   * receives a control-plane hangup signal in addition to the media-plane
   * WebSocket close. Without it, an inbound call that hangs up while the audio
   * WebSocket lingers would never be torn down.
   *
   * The URL targets this provider's `voice_event` endpoint, which flows through
   * {@link handleVoiceEvent} → `call_state_changed` → CallOrchestrator.endCall.
   */
  getHangupWebhookUrl(): string {
    const webhookProviderId = this.config.registryId ?? this.providerId;
    return `${this.config.webhookBaseUrl}/webhooks/${webhookProviderId}/voice_event`;
  }

  /**
   * Handle an incoming webhook request from 46elks.
   *
   * - voice_start: Incoming call or outbound call connected — return SIP connect JSON
   * - voice_event: Call status update (ongoing/success/failed)
   * - sms_incoming: Incoming SMS message
   *
   * Requirements: 7.3, 7.5, 7.7, 7.10
   */
  async handleWebhook(endpoint: string, body: unknown, _request: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'voice_start':
        return this.handleVoiceStart(body as Record<string, unknown>);
      case 'voice_event':
        this.handleVoiceEvent(body as Record<string, unknown>);
        return {};
      case 'sms_incoming':
        this.handleSmsIncoming(body as Record<string, unknown>);
        return {};
      default:
        return {};
    }
  }

  /**
   * Handle the voice_start webhook.
   *
   * For inbound calls: emits incoming_call event and returns JSON instructing
   * 46elks to connect the caller to the MediaBridge SIP URI.
   *
   * For outbound calls (initiated via makeCall): returns the SIP connect action
   * so 46elks bridges PSTN audio to the MediaBridge.
   *
   * The returned JSON format for 46elks:
   * { "connect": "+sipUri", "callerid": from }
   *
   * Requirements: 7.3, 7.7
   */
  private handleVoiceStart(body: Record<string, unknown>): unknown {
    const callId = body.callid as string ?? '';
    const from = body.from as string ?? '';
    const to = body.to as string ?? '';
    const direction = body.direction as string ?? '';

    if (direction === 'incoming') {
      // Emit incoming_call event so CallOrchestrator can handle it
      this.emitEvent({
        type: 'incoming_call',
        callId,
        from: normalizeInboundNumber(from),
        to,
        timestamp: Date.now(),
      });
    }

    // For both inbound and outbound calls, connect to the WebSocket number
    // so that audio is routed via the 46elks Realtime Voice API.
    const wsNumber = this.config.websocketNumber;
    if (wsNumber) {
      // Clean up any stored SIP URI (no longer needed with WS approach)
      this.pendingCallSipUris.delete(callId);
      return {
        connect: wsNumber,
        callerid: from || to,
      };
    }

    // Fallback: try SIP URI if no WebSocket number configured
    const sipUri = this.pendingCallSipUris.get(callId);
    if (sipUri) {
      this.pendingCallSipUris.delete(callId);
      return {
        connect: sipUri,
        callerid: from,
      };
    }

    // Last fallback
    return {
      connect: to,
      callerid: from,
    };
  }

  /**
   * Handle voice_event webhook — call status updates from 46elks.
   *
   * Status values: ongoing (call answered), success (call completed), failed,
   * busy (remote declined/busy), no-answer (remote didn't pick up)
   *
   * Note: 46elks uses both "status" and "state" field names depending on the
   * event type (whenhangup uses "state", voice_start events use "status").
   *
   * Requirements: 7.10
   */
  private handleVoiceEvent(body: Record<string, unknown>): void {
    const callId = body.callid as string ?? body.id as string ?? '';
    if (!callId) return;

    const status = (body.status ?? body.state) as Elks46CallStatus | undefined;
    if (!status) return;

    const duration = body.duration as number | undefined;
    const callState = mapElks46StatusToCallState(status);

    if (callState) {
      this.emitEvent({
        type: 'call_state_changed',
        callId,
        state: callState,
        timestamp: Date.now(),
        durationSeconds: duration ?? null,
      });
    }
  }

  /**
   * Handle incoming SMS webhook from 46elks.
   *
   * Requirements: 7.5
   */
  private handleSmsIncoming(body: Record<string, unknown>): void {
    const messageId = body.id as string ?? '';
    if (!messageId) return;

    const from = body.from as string ?? '';
    const to = body.to as string ?? '';
    const message = body.message as string ?? '';

    if (!from || !to) return;

    this.emitEvent({
      type: 'incoming_sms',
      messageId,
      from: normalizeInboundNumber(from),
      to,
      body: message,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit an event to all registered listeners.
   */
  private emitEvent(event: TelephonyEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

export { mapElks46StatusToCallState };
export type { Elks46CallStatus };
