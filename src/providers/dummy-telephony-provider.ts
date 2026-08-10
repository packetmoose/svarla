import type {
  TelephonyProvider,
  CallInitResult,
  CallAnswerResult,
  SmsResult,
  ProviderNumber,
  TelephonyEvent,
} from './telephony-provider.js';

/**
 * Configuration for the dummy telephony provider.
 */
export interface DummyProviderConfig {
  /** Phone numbers to simulate. Defaults to ["+15550000001"] if not provided. */
  numbers?: string[];
}

/**
 * Dummy implementation of the TelephonyProvider interface.
 *
 * Used for development and testing without any real telephony backend.
 * - listNumbers() returns configured dummy numbers
 * - sendSms() always succeeds (logs to console)
 * - Voice methods throw "not available"
 * - No incoming events are generated (use WebSocket/API to test manually)
 */
export class DummyTelephonyProvider implements TelephonyProvider {
  readonly providerId = 'dummy';

  private readonly numbers: string[];
  private eventListeners: Array<(event: TelephonyEvent) => void> = [];

  constructor(config: DummyProviderConfig = {}) {
    this.numbers = config.numbers ?? ['+15550000001'];
  }

  async start(): Promise<void> {
    console.log(`[DummyProvider] Started with numbers: ${this.numbers.join(', ')}`);
  }

  async stop(): Promise<void> {
    console.log('[DummyProvider] Stopped');
  }

  async listNumbers(): Promise<ProviderNumber[]> {
    return this.numbers.map((number) => ({
      number,
      capabilities: new Set(['SMS', 'VOICE'] as const),
    }));
  }

  async sendSms(from: string, to: string, body: string): Promise<SmsResult> {
    const messageId = `dummy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[DummyProvider] SMS sent: from=${from} to=${to} body="${body.slice(0, 50)}..." id=${messageId}`);

    // Echo back a reply after a short delay to generate demo data
    setTimeout(() => {
      this.simulateIncomingSms(to, from, `Echo: ${body}`);
    }, 1500);

    return {
      messageId,
      success: true,
      errorReason: null,
    };
  }

  async makeCall(_from: string, _to: string): Promise<CallInitResult> {
    throw new Error('Voice calls are not available in the dummy provider');
  }

  async endCall(_callId: string): Promise<void> {
    throw new Error('Voice calls are not available in the dummy provider');
  }

  async answerCall(_callId: string, _deviceId: string): Promise<CallAnswerResult> {
    throw new Error('Voice calls are not available in the dummy provider');
  }

  onEvent(listener: (event: TelephonyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Return the webhook endpoint suffixes for the dummy provider type.
   */
  getWebhookEndpoints(): string[] {
    return ['inbound-sms', 'event'];
  }

  /**
   * Handle an incoming webhook request. For the dummy provider, this simply
   * acknowledges receipt and can simulate events.
   */
  async handleWebhook(endpoint: string, body: unknown, _request: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'inbound-sms': {
        const data = body as { from?: string; to?: string; text?: string };
        if (data.from && data.to) {
          this.simulateIncomingSms(data.from, data.to, data.text ?? '');
        }
        return { status: 'accepted' };
      }
      case 'event':
        return { status: 'accepted' };
      default:
        return { status: 'accepted' };
    }
  }

  /**
   * Simulate an incoming SMS. Useful for testing from an API endpoint or script.
   */
  simulateIncomingSms(from: string, to: string, body: string): void {
    const event: TelephonyEvent = {
      type: 'incoming_sms',
      messageId: `dummy-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from,
      to,
      body,
      timestamp: Date.now(),
    };

    for (const listener of this.eventListeners) {
      listener(event);
    }

    console.log(`[DummyProvider] Simulated incoming SMS: from=${from} to=${to}`);
  }
}
