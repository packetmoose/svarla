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

  /**
   * Provider call IDs of simulated inbound calls that are still "in progress"
   * (from most recent to oldest, appended in order). Used so a fake call can be
   * hung up from the provider side to test client remote-hangup handling.
   */
  private activeSimulatedCalls: string[] = [];

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

  /**
   * Initiate an outbound call. The dummy provider has no real carrier — the
   * call is routed to the MediaBridge echo leg by the orchestrator, so this
   * only needs to return a generated provider call ID. The audio URL argument
   * is unused (echo needs no external connection).
   */
  async makeCall(from: string, to: string, _audioUrl?: string): Promise<CallInitResult> {
    const callId = `dummy-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[DummyProvider] Outbound call: from=${from} to=${to} id=${callId} (echo bridge)`);
    return {
      callId,
      clientToken: null,
    };
  }

  /**
   * End a call. No external carrier state to tear down for the dummy provider;
   * the orchestrator handles MediaBridge session teardown.
   */
  async endCall(callId: string): Promise<void> {
    console.log(`[DummyProvider] Call ended: id=${callId}`);
    // Stop tracking a simulated call once it ends (e.g. client hangup routed
    // through the orchestrator), so it can't be hung up from the provider side
    // a second time.
    this.activeSimulatedCalls = this.activeSimulatedCalls.filter((id) => id !== callId);
  }

  /**
   * Answer an inbound call. The dummy provider has no carrier-side answer step;
   * audio flows once the client's WebRTC leg connects to the MediaBridge echo
   * leg, so this is a no-op that reports success.
   */
  async answerCall(callId: string, deviceId: string, _audioWsUrl?: string): Promise<CallAnswerResult> {
    console.log(`[DummyProvider] Call answered: id=${callId} device=${deviceId}`);
    return {
      success: true,
      clientToken: null,
      errorReason: null,
    };
  }

  onEvent(listener: (event: TelephonyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * The dummy provider simulates events internally and does not receive real
   * inbound HTTP webhooks, so it exposes no webhook endpoints.
   */
  getWebhookEndpoints(): string[] {
    return [];
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

  /**
   * Simulate an incoming call from `from` to this provider's own number.
   * Emits an `incoming_call` event which the server routes through the call
   * orchestrator (MediaBridge echo session + device notifications), letting
   * clients be tested against real inbound-call signaling. Returns the
   * generated provider call ID.
   */
  simulateIncomingCall(from: string): string {
    const to = this.numbers[0] ?? '+15550000001';
    const callId = `dummy-in-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const event: TelephonyEvent = {
      type: 'incoming_call',
      callId,
      from,
      to,
      timestamp: Date.now(),
    };

    this.activeSimulatedCalls.push(callId);

    for (const listener of this.eventListeners) {
      listener(event);
    }

    console.log(`[DummyProvider] Simulated incoming call: from=${from} to=${to} id=${callId}`);
    return callId;
  }

  /**
   * Hang up a simulated inbound call from the provider side, as if the remote
   * caller ended the call. Emits a `call_state_changed` (COMPLETED) event which
   * the server routes through the call orchestrator, tearing down the call and
   * notifying clients — the same path a real caller hangup takes. This lets
   * client remote-hangup handling be tested.
   *
   * When `callId` is omitted, the most recently started simulated call is used.
   * Returns the provider call ID that was hung up, or null if none was active.
   */
  hangupSimulatedCall(callId?: string): string | null {
    let target: string | undefined;
    if (callId) {
      target = this.activeSimulatedCalls.find((id) => id === callId);
    } else {
      target = this.activeSimulatedCalls[this.activeSimulatedCalls.length - 1];
    }

    if (!target) {
      return null;
    }

    this.activeSimulatedCalls = this.activeSimulatedCalls.filter((id) => id !== target);

    const event: TelephonyEvent = {
      type: 'call_state_changed',
      callId: target,
      state: 'COMPLETED',
      timestamp: Date.now(),
      durationSeconds: null,
    };

    for (const listener of this.eventListeners) {
      listener(event);
    }

    console.log(`[DummyProvider] Simulated caller hangup: id=${target}`);
    return target;
  }

  /** Whether any simulated inbound call is currently in progress. */
  hasActiveSimulatedCall(): boolean {
    return this.activeSimulatedCalls.length > 0;
  }

  /**
   * The dummy provider's own number (first configured number). Used as the
   * destination for simulated inbound SMS/calls.
   */
  getPrimaryNumber(): string {
    return this.numbers[0] ?? '+15550000001';
  }
}
