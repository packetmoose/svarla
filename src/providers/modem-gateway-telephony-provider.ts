/**
 * ModemGatewayTelephonyProvider — implements the TelephonyProvider interface
 * for the modem-gateway provider type.
 *
 * Delegates all modem operations (calls, SMS, DTMF, USSD) to a connected
 * Modem_Gateway_Binary via the ModemGatewayWsHandler signaling WebSocket.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11
 */

import { randomUUID } from 'node:crypto';
import type {
  TelephonyProvider,
  CallInitResult,
  CallAnswerResult,
  SmsResult,
  ProviderNumber,
  TelephonyEvent,
  NumberCapability,
  CallState,
} from './telephony-provider.js';
import type { StatusData } from './modem-gateway-ws-handler.js';
import { ModemGatewayWsHandler } from './modem-gateway-ws-handler.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ModemGatewayProviderConfig {
  /** Provider registry ID used to identify this provider instance */
  registryId: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ProviderUnavailableError extends Error {
  constructor(message: string = 'Modem gateway is not connected') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Modem gateway operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PendingOperation<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS = 30_000;
const SMS_TIMEOUT_MS = 60_000;

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * ModemGatewayTelephonyProvider delegates telephony operations to a connected
 * Go binary via the signaling WebSocket managed by ModemGatewayWsHandler.
 */
export class ModemGatewayTelephonyProvider implements TelephonyProvider {
  readonly providerId = 'modem-gateway';
  readonly usesWebSocketAudio = true;

  private wsHandler: ModemGatewayWsHandler | null = null;
  private reportedNumber: string | null = null;
  private reportedCapabilities: Set<NumberCapability> = new Set();
  private eventListeners: Array<(event: TelephonyEvent) => void> = [];
  private pendingOperations: Map<string, PendingOperation> = new Map();
  private modemStatus: StatusData | null = null;
  private numberReportCallback: (() => void) | null = null;
  readonly registryId: string;

  constructor(config: ModemGatewayProviderConfig) {
    this.registryId = config.registryId;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start accepting WS connections from the paired Modem_Gateway_Binary.
   * The WS handler is set externally via setWsHandler() after the WebSocket
   * route is established.
   *
   * Requirements: 12.10
   */
  async start(): Promise<void> {
    // Handler is injected externally when the WS route is set up
  }

  /**
   * Stop the provider: close WS connection and reject all pending operations.
   *
   * Requirements: 12.11
   */
  async stop(): Promise<void> {
    this.rejectAllPending(new ProviderUnavailableError('Provider is stopping'));
    if (this.wsHandler) {
      this.wsHandler.close();
    }
  }

  // ─── TelephonyProvider Methods ─────────────────────────────────────────────

  /**
   * Initiate an outbound call via the connected Go binary.
   * Sends a `make_call` message with the audio WebSocket URL.
   *
   * Requirements: 12.2
   */
  async makeCall(_from: string, to: string, sipUri?: string): Promise<CallInitResult> {
    this.ensureConnected();

    const requestId = randomUUID();
    const callId = randomUUID();

    // For modem-gateway, the sipUri parameter carries the audioWsUrl
    // (the orchestrator passes the MediaBridge audio WS URL here)
    this.wsHandler!.sendMessage({
      type: 'make_call',
      requestId,
      callId,
      to,
      audioWsUrl: sipUri ?? '',
    });

    await this.waitForResponse<void>(requestId, CALL_TIMEOUT_MS, 'make_call');

    return {
      callId,
      clientToken: null,
    };
  }

  /**
   * End an active call by sending a hangup instruction to the Go binary.
   *
   * Requirements: 12.3
   */
  async endCall(callId: string): Promise<void> {
    this.ensureConnected();

    this.wsHandler!.sendMessage({
      type: 'end_call',
      callId,
    });
  }

  /**
   * Answer an incoming call. Sends the answer instruction with the audio WS URL.
   *
   * Requirements: 12.4
   */
  async answerCall(callId: string, _deviceId: string, audioWsUrl?: string): Promise<CallAnswerResult> {
    this.ensureConnected();

    const requestId = randomUUID();

    this.wsHandler!.sendMessage({
      type: 'answer_call',
      requestId,
      callId,
      audioWsUrl: audioWsUrl ?? '',
    });

    await this.waitForResponse<void>(requestId, CALL_TIMEOUT_MS, 'answer_call');

    return {
      success: true,
      clientToken: null,
      errorReason: null,
    };
  }

  /**
   * Send an SMS via the connected Go binary.
   *
   * Requirements: 12.5
   */
  async sendSms(from: string, to: string, body: string): Promise<SmsResult> {
    this.ensureConnected();

    const requestId = randomUUID();

    this.wsHandler!.sendMessage({
      type: 'send_sms',
      requestId,
      from,
      to,
      body,
    });

    const result = await this.waitForResponse<{ messageId: string; success: boolean; errorReason: string | null }>(
      requestId,
      SMS_TIMEOUT_MS,
      'send_sms',
    );

    return {
      messageId: result.messageId,
      success: result.success,
      errorReason: result.errorReason,
    };
  }

  /**
   * List phone numbers reported by the connected Go binary.
   * Returns the single reported number with its capabilities, or empty array.
   *
   * Requirements: 12.6, 12.7
   */
  async listNumbers(): Promise<ProviderNumber[]> {
    if (!this.reportedNumber) {
      return [];
    }

    return [
      {
        number: this.reportedNumber,
        capabilities: new Set(this.reportedCapabilities),
      },
    ];
  }

  /**
   * Register a listener for inbound telephony events.
   */
  onEvent(listener: (event: TelephonyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Register a callback invoked whenever a number_report message is received.
   * Used to trigger an automatic number sync when the gateway reports a new number.
   */
  onNumberReport(callback: () => void): void {
    this.numberReportCallback = callback;
  }

  /**
   * Modem-gateway does not use HTTP webhooks.
   *
   * Requirements: 12.8
   */
  getWebhookEndpoints(): string[] {
    return [];
  }

  /**
   * Modem-gateway does not use HTTP webhooks.
   *
   * Requirements: 12.9
   */
  async handleWebhook(_endpoint: string, _body: unknown, _request: unknown): Promise<unknown> {
    return {};
  }

  // ─── WS Handler Integration ────────────────────────────────────────────────

  /**
   * Set the WS handler for this provider. Called when the signaling WebSocket
   * connection route is established.
   */
  setWsHandler(handler: ModemGatewayWsHandler): void {
    this.wsHandler = handler;

    handler.onDisconnect(() => {
      this.rejectAllPending(new ProviderUnavailableError('Modem gateway disconnected'));
      // Clear the reported number so listNumbers() returns empty while disconnected.
      // Fire the callback to trigger an automatic sync that deactivates the number.
      this.reportedNumber = null;
      this.reportedCapabilities = new Set();
      if (this.numberReportCallback) {
        this.numberReportCallback();
      }
    });

    handler.onMessage((msg) => {
      this.handleInboundMessage(msg);
    });
  }

  /**
   * Get the WS handler (used by server routes for connection management).
   */
  getWsHandler(): ModemGatewayWsHandler | null {
    return this.wsHandler;
  }

  // ─── Inbound Message Handling ──────────────────────────────────────────────

  private handleInboundMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    switch (type) {
      case 'number_report':
        this.handleNumberReport(msg);
        break;

      case 'call_state':
        this.handleCallState(msg);
        break;

      case 'incoming_call':
        this.handleIncomingCall(msg);
        break;

      case 'incoming_sms':
        this.handleIncomingSms(msg);
        break;

      case 'sms_result':
        this.handleSmsResult(msg);
        break;

      case 'delivery_report':
        this.handleDeliveryReport(msg);
        break;

      case 'call_ack':
        this.resolveRequest(msg.requestId as string, undefined);
        break;

      case 'answer_ack':
        this.resolveRequest(msg.requestId as string, undefined);
        break;

      case 'status':
        this.handleStatus(msg);
        break;

      default:
        // Ignore unrecognized messages per protocol spec (Requirement 3.6)
        break;
    }
  }

  private handleNumberReport(msg: Record<string, unknown>): void {
    const number = msg.number as string | undefined;
    const capabilities = msg.capabilities as string[] | undefined;

    if (number) {
      this.reportedNumber = number;
      this.reportedCapabilities = new Set(
        (capabilities ?? []).filter((c): c is NumberCapability =>
          c === 'VOICE' || c === 'SMS' || c === 'MMS',
        ),
      );
    } else {
      // number_unavailable
      this.reportedNumber = null;
      this.reportedCapabilities = new Set();
    }

    // Trigger automatic number sync so the new number is persisted immediately.
    if (this.numberReportCallback) {
      this.numberReportCallback();
    }
  }

  private handleCallState(msg: Record<string, unknown>): void {
    const callId = msg.callId as string;
    const state = msg.state as string;
    const durationSeconds = (msg.durationSeconds as number) ?? null;

    // Resolve pending make_call request on first state change (RINGING confirms initiation)
    if (state === 'RINGING' || state === 'ANSWERED' || state === 'FAILED' || state === 'BUSY') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        if (state === 'FAILED' || state === 'BUSY') {
          this.rejectRequest(requestId, new Error(`Call failed: ${msg.reason ?? state}`));
        } else {
          this.resolveRequest(requestId, undefined);
        }
      }
    }

    this.emitEvent({
      type: 'call_state_changed',
      callId,
      state: state as CallState,
      timestamp: Date.now(),
      durationSeconds,
    });
  }

  private handleIncomingCall(msg: Record<string, unknown>): void {
    const callId = msg.callId as string;
    const from = msg.from as string;

    this.emitEvent({
      type: 'incoming_call',
      callId,
      from,
      to: this.reportedNumber ?? '',
      timestamp: Date.now(),
    });
  }

  private handleIncomingSms(msg: Record<string, unknown>): void {
    this.emitEvent({
      type: 'incoming_sms',
      messageId: msg.messageId as string,
      from: msg.from as string,
      to: msg.to as string,
      body: msg.body as string,
      timestamp: (msg.timestamp as number) ?? Date.now(),
    });
  }

  private handleSmsResult(msg: Record<string, unknown>): void {
    const requestId = msg.requestId as string;
    const success = msg.success as boolean;
    const errorReason = (msg.errorReason as string) ?? null;

    // NOTE: The modem's messageRef (+CMGS: <ref>) is a small integer (0-255)
    // that the modem reuses across messages. It is NOT globally unique, so we
    // must not use it as provider_message_id (which has a UNIQUE constraint).
    // Use the per-send requestId (a UUID) as the unique message identifier.
    const messageId = requestId;

    if (success) {
      this.resolveRequest(requestId, { messageId, success: true, errorReason: null });
    } else {
      this.resolveRequest(requestId, { messageId, success: false, errorReason });
    }
  }

  private handleDeliveryReport(msg: Record<string, unknown>): void {
    const messageRef = msg.messageRef as string;
    const status = msg.status as string;

    this.emitEvent({
      type: 'sms_status_update',
      messageId: messageRef,
      status: status === 'DELIVERED' ? 'DELIVERED' : 'FAILED',
    });
  }

  private handleStatus(msg: Record<string, unknown>): void {
    this.modemStatus = {
      signal: msg.signal as number,
      network: msg.network as string,
      operator: msg.operator as string,
      modemModel: msg.modemModel as string | undefined,
      modemManufacturer: msg.modemManufacturer as string | undefined,
      firmware: msg.firmware as string | undefined,
      stale: msg.stale as string[] | undefined,
      modemUnsupportedWarning: msg.modemUnsupportedWarning as string | undefined,
    };
  }

  // ─── Public Status Access ──────────────────────────────────────────────────

  /**
   * Get the current modem status as last reported by the Go binary.
   * Returns null if no status has been reported yet.
   *
   * Requirements: 9.3, 25.3
   */
  getModemStatus(): StatusData | null {
    return this.modemStatus;
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.wsHandler || !this.wsHandler.isConnected()) {
      throw new ProviderUnavailableError('Modem gateway is not connected');
    }
  }

  private emitEvent(event: TelephonyEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private waitForResponse<T>(requestId: string, timeoutMs: number, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOperations.delete(requestId);
        reject(new ProviderTimeoutError(operation, timeoutMs));
      }, timeoutMs);

      this.pendingOperations.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  private resolveRequest(requestId: string, value: unknown): void {
    const pending = this.pendingOperations.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingOperations.delete(requestId);
      pending.resolve(value);
    }
  }

  private rejectRequest(requestId: string, error: Error): void {
    const pending = this.pendingOperations.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingOperations.delete(requestId);
      pending.reject(error);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingOperations) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingOperations.delete(requestId);
    }
  }
}
