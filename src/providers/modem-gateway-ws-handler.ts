import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';

/**
 * Signaling message types sent from the Modem Gateway Binary to Svarla.
 */
export type InboundMessageType =
  | 'auth_pair'
  | 'auth_response'
  | 'status'
  | 'number_report'
  | 'incoming_call'
  | 'call_state'
  | 'incoming_sms'
  | 'sms_result'
  | 'dtmf_received'
  | 'dtmf_result'
  | 'ussd_response'
  | 'ussd_error'
  | 'missed_calls'
  | 'buffered_sms'
  | 'delivery_report'
  | 'call_ack'
  | 'answer_ack';

/**
 * Signaling message types sent from Svarla to the Modem Gateway Binary.
 */
export type OutboundMessageType =
  | 'auth_challenge'
  | 'auth_success'
  | 'auth_error'
  | 'make_call'
  | 'answer_call'
  | 'end_call'
  | 'send_sms'
  | 'send_dtmf'
  | 'ussd_request'
  | 'ussd_input'
  | 'ussd_cancel';

/**
 * Base signaling message with a `type` discriminator.
 */
export interface SignalingMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Events emitted by the WS handler for consumption by the provider.
 */
export type WsHandlerEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'authenticated' }
  | { type: 'status'; data: StatusData }
  | { type: 'number_report'; data: NumberReportData }
  | { type: 'incoming_call'; data: IncomingCallData }
  | { type: 'call_state'; data: CallStateData }
  | { type: 'incoming_sms'; data: IncomingSmsData }
  | { type: 'sms_result'; data: SmsResultData }
  | { type: 'dtmf_received'; data: DtmfReceivedData }
  | { type: 'dtmf_result'; data: DtmfResultData }
  | { type: 'ussd_response'; data: UssdResponseData }
  | { type: 'ussd_error'; data: UssdErrorData }
  | { type: 'missed_calls'; data: MissedCallsData }
  | { type: 'buffered_sms'; data: BufferedSmsData }
  | { type: 'delivery_report'; data: DeliveryReportData };

export interface StatusData {
  signal: number;
  network: string;
  operator: string;
  modemModel?: string;
  modemManufacturer?: string;
  firmware?: string;
  stale?: string[];
  modemUnsupportedWarning?: string;
}

export interface NumberReportData {
  number: string | null;
  capabilities: string[];
}

export interface IncomingCallData {
  callId: string;
  from: string;
}

export interface CallStateData {
  callId: string;
  state: string;
  reason?: string;
  durationSeconds?: number | null;
}

export interface IncomingSmsData {
  messageId: string;
  from: string;
  to: string;
  body: string;
  timestamp: number;
}

export interface SmsResultData {
  requestId: string;
  success: boolean;
  messageRef?: number;
  errorReason?: string;
}

export interface DtmfReceivedData {
  callId: string;
  digit: string;
}

export interface DtmfResultData {
  requestId: string;
  success: boolean;
  errorReason?: string;
}

export interface UssdResponseData {
  requestId: string;
  text: string;
  sessionActive: boolean;
}

export interface UssdErrorData {
  requestId: string;
  errorCode?: number;
  errorText: string;
}

export interface MissedCallsData {
  calls: Array<{ from: string; timestamp: number }>;
}

export interface BufferedSmsData {
  messages: Array<{
    messageId: string;
    from: string;
    to: string;
    body: string;
    timestamp: number;
  }>;
}

export interface DeliveryReportData {
  messageRef: number;
  status: string;
}

/**
 * Listener type for WS handler events.
 */
export type WsHandlerEventListener = (event: WsHandlerEvent) => void;

/**
 * Logger interface for the WS handler.
 */
export interface WsHandlerLogger {
  debug(msg: string): void;
  debug(obj: unknown, msg: string): void;
  info(msg: string): void;
  info(obj: unknown, msg: string): void;
  warn(msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(msg: string): void;
  error(obj: unknown, msg: string): void;
}

/**
 * Configuration for persisting pairing state.
 */
export interface WsHandlerPersistence {
  /** Load the current stored public key (base64) for this provider. */
  getPublicKey(): Promise<string | null>;
  /** Store the public key (base64) after successful pairing. */
  setPublicKey(key: string): Promise<void>;
  /** Delete the stored public key (for reset). */
  deletePublicKey(): Promise<void>;
  /** Load the current pairing secret. */
  getPairingSecret(): Promise<string | null>;
  /** Load the creation timestamp of the pairing secret. */
  getPairingSecretCreatedAt(): Promise<Date | null>;
  /** Store a new pairing secret with creation timestamp. */
  setPairingSecret(secret: string, createdAt: Date): Promise<void>;
  /** Clear the pairing secret (after use or reset). */
  clearPairingSecret(): Promise<void>;
}

/** 24 hours in milliseconds */
const PAIRING_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

/** Challenge nonce expiry: 30 seconds */
const CHALLENGE_EXPIRY_MS = 30_000;

/** Rate limit: minimum 1 second between auth attempts */
const AUTH_RATE_LIMIT_MS = 1_000;

/** Ping interval: 30 seconds */
const PING_INTERVAL_MS = 30_000;

/** Pong timeout: 60 seconds */
const PONG_TIMEOUT_MS = 60_000;

/** Global auth timeout: close connection if not authenticated within 30 seconds */
const AUTH_TIMEOUT_MS = 30_000;

/**
 * ModemGatewayWsHandler manages the signaling WebSocket connection for a single
 * modem-gateway provider instance.
 *
 * Responsibilities:
 * - Pairing flow: validate pairing secret, store public key, invalidate secret
 * - Challenge-response auth: issue 32-byte nonce, verify Ed25519 signature
 * - Rate limiting: 1-second minimum between auth attempts
 * - Message dispatch: route incoming messages by `type` field
 * - Ping/pong: send pings every 30s, close if no pong within 60s
 * - Pairing secret generation (6-8 alphanumeric chars, case-insensitive)
 * - Reset pairing: delete key, generate new secret, close active WS
 *
 * Requirements: 2.1-2.8, 1.2, 1.6, 3.5, 3.6
 */
export class ModemGatewayWsHandler {
  private readonly persistence: WsHandlerPersistence;
  private readonly logger: WsHandlerLogger;
  private readonly eventListeners: WsHandlerEventListener[] = [];
  private readonly messageCallbacks: Array<(msg: SignalingMessage) => void> = [];

  // Connection state
  private ws: WebSocket | null = null;
  private authenticated = false;

  // Auth state
  private pendingChallenge: { nonce: Buffer; expiresAt: number } | null = null;
  private lastAuthAttempt = 0;

  // Ping/pong state
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private pongReceived = true;

  // Auth timeout state
  private authTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(persistence: WsHandlerPersistence, logger: WsHandlerLogger) {
    this.persistence = persistence;
    this.logger = logger;
  }

  /**
   * Register a listener for handler events.
   */
  onEvent(listener: WsHandlerEventListener): void {
    this.eventListeners.push(listener);
  }

  /**
   * Register a callback for when the connection is lost.
   * Convenience method for provider integration.
   */
  onDisconnect(callback: () => void): void {
    this.onEvent((event) => {
      if (event.type === 'disconnected') {
        callback();
      }
    });
  }

  /**
   * Register a callback for all authenticated inbound messages.
   * The raw parsed message object is forwarded to the callback.
   * Convenience method for provider integration.
   */
  onMessage(callback: (msg: SignalingMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Handle a new incoming WebSocket connection from a modem-gateway binary.
   * Only one connection is allowed at a time; any existing connection is closed.
   */
  handleConnection(ws: WebSocket): void {
    // Close any existing connection
    if (this.ws) {
      this.logger.info('New connection received, closing existing connection');
      this.closeExisting();
    }

    this.ws = ws;
    this.authenticated = false;
    this.pendingChallenge = null;

    this.logger.info('Modem gateway binary connected');
    this.emit({ type: 'connected' });

    ws.on('message', (data: Buffer | string) => {
      this.handleMessage(data);
    });

    ws.on('close', () => {
      this.handleDisconnect();
    });

    ws.on('error', (err: Error) => {
      this.logger.error(err, 'WebSocket error');
      this.handleDisconnect();
    });

    ws.on('pong', () => {
      this.pongReceived = true;
      this.clearPongTimeout();
    });

    // Start ping/pong cycle
    this.startPingInterval();

    // Issue challenge or wait for pairing message
    void this.initiateAuth();

    // Global auth timeout: close connection if not authenticated within 30s.
    // This covers both the challenge-response and the unpaired "waiting for auth_pair" case.
    this.authTimeout = setTimeout(() => {
      if (!this.authenticated) {
        this.logger.warn('Authentication timeout, closing connection');
        this.sendMessage({ type: 'auth_error', reason: 'auth_timeout' });
        this.closeExisting();
      }
    }, AUTH_TIMEOUT_MS);
  }

  /**
   * Send a signaling message to the connected binary.
   * Returns false if not connected or not authenticated (except auth messages).
   */
  sendMessage(msg: SignalingMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1 /* WebSocket.OPEN */) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.logger.error(err, 'Failed to send message');
      return false;
    }
  }

  /**
   * Close the WebSocket connection and clean up resources.
   */
  close(): void {
    this.closeExisting();
  }

  /**
   * Returns whether a binary is currently connected and authenticated.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1 && this.authenticated;
  }

  /**
   * Returns whether a binary is connected (may not yet be authenticated).
   */
  isSocketConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  /**
   * Reset pairing: delete stored key, store provided secret, close active WS.
   * The secret is provided by the caller (generated client-side).
   */
  async resetPairing(secret: string): Promise<void> {
    this.logger.info('Resetting pairing');

    // Close any active connection
    this.closeExisting();

    // Delete stored public key
    await this.persistence.deletePublicKey();

    // Store the client-provided pairing secret
    await this.persistence.setPairingSecret(secret, new Date());

    this.logger.info('Pairing reset complete, new secret stored');
  }

  // --- Private methods ---

  /**
   * Initiate authentication after a new connection.
   * If the provider has a stored public key, issue a challenge.
   * Otherwise, wait for the binary to send an auth_pair message.
   */
  private async initiateAuth(): Promise<void> {
    const publicKey = await this.persistence.getPublicKey();

    if (publicKey) {
      // Provider is already paired - issue challenge
      this.issueChallenge();
    }
    // Otherwise, wait for auth_pair message from binary
  }

  /**
   * Issue a cryptographic challenge to the connected binary.
   * Generates 32 random bytes as a nonce with 30-second expiry.
   */
  private issueChallenge(): void {
    const nonce = randomBytes(32);
    this.pendingChallenge = {
      nonce,
      expiresAt: Date.now() + CHALLENGE_EXPIRY_MS,
    };

    this.sendMessage({
      type: 'auth_challenge',
      nonce: nonce.toString('base64'),
    });

    this.logger.debug('Issued auth challenge');

    // Set a timeout to close the connection if challenge is not answered
    setTimeout(() => {
      if (this.pendingChallenge && !this.authenticated) {
        this.logger.warn('Challenge expired without response, closing connection');
        this.sendMessage({ type: 'auth_error', reason: 'challenge_timeout' });
        this.closeExisting();
      }
    }, CHALLENGE_EXPIRY_MS);
  }

  /**
   * Handle an incoming WebSocket message (raw data).
   */
  private handleMessage(data: Buffer | string): void {
    let msg: SignalingMessage;
    try {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      msg = JSON.parse(text) as SignalingMessage;
    } catch {
      // Invalid JSON - ignore per protocol spec (Req 3.6)
      this.logger.warn('Received invalid JSON message, ignoring');
      return;
    }

    if (!msg.type || typeof msg.type !== 'string') {
      this.logger.warn('Received message without type field, ignoring');
      return;
    }

    // Authentication messages are handled regardless of auth state
    if (msg.type === 'auth_pair' || msg.type === 'auth_response') {
      void this.handleAuthMessage(msg);
      return;
    }

    // All other messages require authentication
    if (!this.authenticated) {
      this.logger.warn({ type: msg.type }, 'Received message before authentication, ignoring');
      return;
    }

    this.dispatchMessage(msg);
  }

  /**
   * Handle authentication messages (auth_pair and auth_response).
   */
  private async handleAuthMessage(msg: SignalingMessage): Promise<void> {
    // Rate limiting: enforce minimum 1-second delay between auth attempts
    const now = Date.now();
    if (now - this.lastAuthAttempt < AUTH_RATE_LIMIT_MS) {
      this.logger.warn('Auth attempt rate-limited');
      this.sendMessage({ type: 'auth_error', reason: 'rate_limited' });
      this.closeExisting();
      return;
    }
    this.lastAuthAttempt = now;

    if (msg.type === 'auth_pair') {
      await this.handleAuthPair(msg);
    } else if (msg.type === 'auth_response') {
      await this.handleAuthResponse(msg);
    }
  }

  /**
   * Handle initial pairing request from the binary.
   * Validates: secret not expired (<24h), not already used, no existing key.
   */
  private async handleAuthPair(msg: SignalingMessage): Promise<void> {
    const publicKeyB64 = msg.publicKey as string | undefined;
    const pairingSecret = msg.pairingSecret as string | undefined;

    if (!publicKeyB64 || !pairingSecret) {
      this.sendMessage({ type: 'auth_error', reason: 'missing_fields' });
      this.closeExisting();
      return;
    }

    // Check if provider already has a stored public key (already paired)
    const existingKey = await this.persistence.getPublicKey();
    if (existingKey) {
      this.logger.warn('Pairing attempted on already-paired provider');
      this.sendMessage({ type: 'auth_error', reason: 'already_paired' });
      this.closeExisting();
      return;
    }

    // Validate pairing secret
    const storedSecret = await this.persistence.getPairingSecret();
    if (!storedSecret) {
      this.logger.warn('Pairing attempted but no secret available (already used)');
      this.sendMessage({ type: 'auth_error', reason: 'secret_already_used' });
      this.closeExisting();
      return;
    }

    // Case-insensitive comparison
    if (storedSecret.toLowerCase() !== pairingSecret.toLowerCase()) {
      this.logger.warn('Invalid pairing secret provided');
      this.sendMessage({ type: 'auth_error', reason: 'invalid_secret' });
      this.closeExisting();
      return;
    }

    // Check expiry (24 hours)
    const createdAt = await this.persistence.getPairingSecretCreatedAt();
    if (createdAt && Date.now() - createdAt.getTime() > PAIRING_SECRET_TTL_MS) {
      this.logger.warn('Pairing secret expired');
      this.sendMessage({ type: 'auth_error', reason: 'secret_expired' });
      this.closeExisting();
      return;
    }

    // Validate public key format (Ed25519 public key is 32 bytes)
    let keyBuffer: Buffer;
    try {
      keyBuffer = Buffer.from(publicKeyB64, 'base64');
      if (keyBuffer.length !== 32) {
        throw new Error('Invalid key length');
      }
    } catch {
      this.sendMessage({ type: 'auth_error', reason: 'invalid_public_key' });
      this.closeExisting();
      return;
    }

    // Store the public key and invalidate the secret
    await this.persistence.setPublicKey(publicKeyB64);
    await this.persistence.clearPairingSecret();

    this.authenticated = true;
    this.clearAuthTimeout();
    this.logger.info('Pairing successful, public key stored');

    this.sendMessage({ type: 'auth_success' });
    this.emit({ type: 'authenticated' });
  }

  /**
   * Handle challenge-response authentication.
   * Verifies Ed25519 signature against stored public key.
   */
  private async handleAuthResponse(msg: SignalingMessage): Promise<void> {
    const signatureB64 = msg.signature as string | undefined;

    if (!signatureB64) {
      this.sendMessage({ type: 'auth_error', reason: 'missing_signature' });
      this.closeExisting();
      return;
    }

    // Verify we have a pending challenge
    if (!this.pendingChallenge) {
      this.sendMessage({ type: 'auth_error', reason: 'no_pending_challenge' });
      this.closeExisting();
      return;
    }

    // Check challenge expiry
    if (Date.now() > this.pendingChallenge.expiresAt) {
      this.pendingChallenge = null;
      this.sendMessage({ type: 'auth_error', reason: 'challenge_expired' });
      this.closeExisting();
      return;
    }

    // Load stored public key
    const publicKeyB64 = await this.persistence.getPublicKey();
    if (!publicKeyB64) {
      this.sendMessage({ type: 'auth_error', reason: 'not_paired' });
      this.closeExisting();
      return;
    }

    // Verify Ed25519 signature
    const signature = Buffer.from(signatureB64, 'base64');
    const publicKeyBuffer = Buffer.from(publicKeyB64, 'base64');
    const nonce = this.pendingChallenge.nonce;

    let valid: boolean;
    try {
      const keyObject = crypto.createPublicKey({
        key: Buffer.concat([
          // Ed25519 public key DER prefix (from RFC 8410)
          Buffer.from('302a300506032b6570032100', 'hex'),
          publicKeyBuffer,
        ]),
        format: 'der',
        type: 'spki',
      });
      valid = crypto.verify(null, nonce, keyObject, signature);
    } catch (err) {
      this.logger.error(err, 'Ed25519 signature verification error');
      valid = false;
    }

    this.pendingChallenge = null;

    if (!valid) {
      this.logger.warn('Invalid signature in auth response');
      this.sendMessage({ type: 'auth_error', reason: 'invalid_signature' });
      this.closeExisting();
      return;
    }

    this.authenticated = true;
    this.clearAuthTimeout();
    this.logger.info('Challenge-response authentication successful');

    this.sendMessage({ type: 'auth_success' });
    this.emit({ type: 'authenticated' });
  }

  /**
   * Dispatch an authenticated message to the appropriate handler.
   * Unknown message types are ignored per protocol spec (Req 3.6).
   */
  private dispatchMessage(msg: SignalingMessage): void {
    // Forward to raw message callbacks (used by provider for request-response correlation)
    for (const callback of this.messageCallbacks) {
      try {
        callback(msg);
      } catch (err) {
        this.logger.error(err, 'Error in message callback');
      }
    }

    switch (msg.type as InboundMessageType) {
      case 'status':
        this.emit({
          type: 'status',
          data: {
            signal: msg.signal as number,
            network: msg.network as string,
            operator: msg.operator as string,
            modemModel: msg.modemModel as string | undefined,
            modemManufacturer: msg.modemManufacturer as string | undefined,
            firmware: msg.firmware as string | undefined,
            stale: msg.stale as string[] | undefined,
            modemUnsupportedWarning: msg.modemUnsupportedWarning as string | undefined,
          },
        });
        break;

      case 'number_report':
        this.emit({
          type: 'number_report',
          data: {
            number: (msg.number as string) ?? null,
            capabilities: (msg.capabilities as string[]) ?? [],
          },
        });
        break;

      case 'incoming_call':
        this.emit({
          type: 'incoming_call',
          data: {
            callId: msg.callId as string,
            from: msg.from as string,
          },
        });
        break;

      case 'call_state':
        this.emit({
          type: 'call_state',
          data: {
            callId: msg.callId as string,
            state: msg.state as string,
            reason: msg.reason as string | undefined,
            durationSeconds: msg.durationSeconds as number | null | undefined,
          },
        });
        break;

      case 'incoming_sms':
        this.emit({
          type: 'incoming_sms',
          data: {
            messageId: msg.messageId as string,
            from: msg.from as string,
            to: msg.to as string,
            body: msg.body as string,
            timestamp: msg.timestamp as number,
          },
        });
        break;

      case 'sms_result':
        this.emit({
          type: 'sms_result',
          data: {
            requestId: msg.requestId as string,
            success: msg.success as boolean,
            messageRef: msg.messageRef as number | undefined,
            errorReason: msg.errorReason as string | undefined,
          },
        });
        break;

      case 'dtmf_received':
        this.emit({
          type: 'dtmf_received',
          data: {
            callId: msg.callId as string,
            digit: msg.digit as string,
          },
        });
        break;

      case 'dtmf_result':
        this.emit({
          type: 'dtmf_result',
          data: {
            requestId: msg.requestId as string,
            success: msg.success as boolean,
            errorReason: msg.errorReason as string | undefined,
          },
        });
        break;

      case 'ussd_response':
        this.emit({
          type: 'ussd_response',
          data: {
            requestId: msg.requestId as string,
            text: msg.text as string,
            sessionActive: msg.sessionActive as boolean,
          },
        });
        break;

      case 'ussd_error':
        this.emit({
          type: 'ussd_error',
          data: {
            requestId: msg.requestId as string,
            errorCode: msg.errorCode as number | undefined,
            errorText: msg.errorText as string,
          },
        });
        break;

      case 'missed_calls':
        this.emit({
          type: 'missed_calls',
          data: {
            calls: msg.calls as Array<{ from: string; timestamp: number }>,
          },
        });
        break;

      case 'buffered_sms':
        this.emit({
          type: 'buffered_sms',
          data: {
            messages: msg.messages as Array<{
              messageId: string;
              from: string;
              to: string;
              body: string;
              timestamp: number;
            }>,
          },
        });
        break;

      case 'delivery_report':
        this.emit({
          type: 'delivery_report',
          data: {
            messageRef: msg.messageRef as number,
            status: msg.status as string,
          },
        });
        break;

      case 'call_ack':
      case 'answer_ack':
        // Request-response acks are handled by the provider via the raw message
        // callback (messageCallbacks) above; no event emission needed here.
        break;

      default:
        // Unknown type: ignore per Req 3.6
        this.logger.debug({ type: msg.type }, 'Received unknown message type, ignoring');
        break;
    }
  }

  /**
   * Handle WebSocket disconnection.
   */
  private handleDisconnect(): void {
    this.stopPingInterval();
    this.clearPongTimeout();
    this.clearAuthTimeout();
    this.ws = null;
    this.authenticated = false;
    this.pendingChallenge = null;
    this.logger.info('Modem gateway binary disconnected');
    this.emit({ type: 'disconnected' });
  }

  /**
   * Close the existing WebSocket connection and clean up.
   */
  private closeExisting(): void {
    this.stopPingInterval();
    this.clearPongTimeout();
    this.clearAuthTimeout();
    this.authenticated = false;
    this.pendingChallenge = null;

    if (this.ws) {
      try {
        this.ws.close(1000, 'Connection replaced');
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  /**
   * Start the ping interval (send pings every 30 seconds).
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pongReceived = true;

    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) {
        this.stopPingInterval();
        return;
      }

      if (!this.pongReceived) {
        // No pong received since last ping - start pong timeout
        // The pong timeout will close the connection if no pong arrives within 60s
        this.startPongTimeout();
      }

      this.pongReceived = false;
      try {
        this.ws.ping();
      } catch {
        // Ping failed - connection is dead
        this.handleDisconnect();
      }
    }, PING_INTERVAL_MS);
  }

  /**
   * Stop the ping interval.
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Start the pong timeout. If no pong is received within 60 seconds, close.
   */
  private startPongTimeout(): void {
    this.clearPongTimeout();
    this.pongTimeout = setTimeout(() => {
      this.logger.warn('No pong received within 60s, closing connection');
      this.closeExisting();
      this.emit({ type: 'disconnected' });
    }, PONG_TIMEOUT_MS);
  }

  /**
   * Clear the pong timeout.
   */
  private clearPongTimeout(): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  /**
   * Clear the global auth timeout.
   */
  private clearAuthTimeout(): void {
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
  }

  /**
   * Emit an event to all registered listeners.
   */
  private emit(event: WsHandlerEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error(err, 'Error in event listener');
      }
    }
  }
}
