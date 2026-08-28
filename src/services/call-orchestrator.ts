/**
 * CallOrchestrator — Coordinates the full call lifecycle between clients,
 * the MediaBridge sidecar, and telephony providers.
 *
 * Replaces direct provider call logic with a unified flow:
 * - Outbound: create MediaBridge session → provider.makeCall → patch session → return callId
 * - Inbound: create MediaBridge session → notify devices via push + WS → return sipUri
 * - Answer: mark answered → notify other devices (answered_elsewhere)
 * - WebRTC offer: submit SDP to MediaBridge → return SDP answer
 * - End call: destroy session → provider.endCall → notify clients → update call history
 * - Media events: route provider/client disconnect → endCall, DTMF → forward
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 8.2, 8.3, 8.5
 */

import { randomUUID } from 'node:crypto';
import type {
  MediaBridgeClient,
  OfferResult,
  SessionInfo,
} from './media-bridge-client.js';
import { MediaBridgeUnavailableError } from './media-bridge-client.js';
import type { MediaBridgeSessionEvent } from './media-bridge-event-listener.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { NumberManagementService } from './number-management-service.js';
import type { CallHistoryService } from './call-history-service.js';
import type { WebSocketBroadcaster } from '../websocket/broadcaster.js';
import type { DeviceRegistryManager } from './device-registry-manager.js';
import type { WakeSignalPublisher } from '../notifications/wake-signal-publisher.js';
import type { TelephonyProvider } from '../providers/telephony-provider.js';
import type { NotificationService } from './notification-service.js';
import { selectSipUri } from './sip-uri-selector.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OutboundCallResult {
  callId: string;
  from: string;
  to: string;
}

export interface InboundCallResult {
  sipUri: string;
  callId: string;
}

export interface AnswerResult {
  success: boolean;
  errorReason?: string;
}

/**
 * Internal state for an active call managed by the orchestrator.
 */
interface ActiveCall {
  /** Internal call ID (UUID) */
  callId: string;
  /** MediaBridge session ID (same as callId for simplicity) */
  sessionId: string;
  /** Provider-specific call ID returned by makeCall or webhook */
  providerCallId: string;
  /** Provider instance handling this call */
  provider: TelephonyProvider;
  /** Provider registry entry ID */
  providerId: string;
  /** Caller/source number (E.164) */
  from: string;
  /** Destination number (E.164) */
  to: string;
  /** Direction of the call */
  direction: 'outbound' | 'inbound';
  /** Whether the call has been answered */
  answered: boolean;
  /** Device that answered (if any) */
  answeredByDevice: string | null;
  /** When the call started */
  startedAt: Date;
  /** When the call was answered (for duration calculation) */
  answeredAt: Date | null;
  /** Whether endCall has already been called (prevents double cleanup) */
  ended: boolean;
  /** MediaBridge audio WebSocket URL for providers using WebSocket audio (modem-gateway) */
  audioWsUrl: string | null;
}

/**
 * Logger interface compatible with Fastify/Pino logger.
 */
export interface CallOrchestratorLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Dependencies injected into CallOrchestrator.
 */
export interface CallOrchestratorDeps {
  mediaBridgeClient: MediaBridgeClient;
  providerRegistry: ProviderRegistry;
  numberManagementService: NumberManagementService;
  callHistoryService: CallHistoryService;
  wsBroadcaster: WebSocketBroadcaster;
  deviceRegistryManager: DeviceRegistryManager;
  wakeSignalPublisher: WakeSignalPublisher;
  notificationService: NotificationService;
  logger: CallOrchestratorLogger;
  /** Whether SIP TLS is enabled in the server config (mediaBridge.sip.tls). Defaults to true. */
  sipTlsEnabled?: boolean;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class CallOrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallOrchestratorError';
  }
}

export class CallNotFoundError extends CallOrchestratorError {
  constructor(callId: string) {
    super(`Call ${callId} not found`);
    this.name = 'CallNotFoundError';
  }
}

export class ProviderNotAvailableError extends CallOrchestratorError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotAvailableError';
  }
}

// ─── CallOrchestrator ────────────────────────────────────────────────────────

export class CallOrchestrator {
  private readonly mediaBridge: MediaBridgeClient;
  private readonly providerRegistry: ProviderRegistry;
  private readonly numberManagement: NumberManagementService;
  private readonly callHistory: CallHistoryService;
  private readonly wsBroadcaster: WebSocketBroadcaster;
  private readonly notificationService: NotificationService;
  private readonly logger: CallOrchestratorLogger;
  private readonly sipTlsEnabled: boolean;

  /** Active calls tracked by callId */
  private readonly activeCalls = new Map<string, ActiveCall>();

  /** Maps MediaBridge sessionId → callId for event routing */
  private readonly sessionToCall = new Map<string, string>();

  /** Maps provider callId → internal callId for webhook correlation */
  private readonly providerCallToInternal = new Map<string, string>();

  constructor(deps: CallOrchestratorDeps) {
    this.mediaBridge = deps.mediaBridgeClient;
    this.providerRegistry = deps.providerRegistry;
    this.numberManagement = deps.numberManagementService;
    this.callHistory = deps.callHistoryService;
    this.wsBroadcaster = deps.wsBroadcaster;
    this.notificationService = deps.notificationService;
    this.logger = deps.logger;
    this.sipTlsEnabled = deps.sipTlsEnabled ?? true;
  }

  /**
   * PATCH a MediaBridge session to expect a WebSocket provider connection.
   * Called when a provider uses WebSocket audio (e.g. 46elks Realtime Voice API).
   */
  async patchSessionForWebsocketProvider(sessionId: string, protocol: string, expectedCallId: string): Promise<void> {
    await this.mediaBridge.updateSession(sessionId, {
      providerLeg: { type: 'websocket', protocol, expectedCallId },
    });
  }

  // ─── Outbound Call ───────────────────────────────────────────────────────

  /**
   * Initiate an outbound call.
   *
   * Flow:
   * 1. Look up provider for the "from" number via ProviderRegistry
   * 2. Create MediaBridge session with providerLeg: pending, ringback: true
   * 3. Call provider.makeCall(from, to) to initiate the PSTN leg
   * 4. PATCH MediaBridge session with the provider's SIP leg info
   * 5. Record outbound call in history
   * 6. Return callId to client
   *
   * Requirements: 5.1, 5.4, 8.2
   */
  async initiateOutbound(deviceId: string, from: string, to: string): Promise<OutboundCallResult> {
    // 1. Find the provider for the "from" number
    const providerEntry = await this.numberManagement.requireProviderForNumber(from);
    const provider = providerEntry.instance!;

    // 2. Create MediaBridge session with pending provider leg and ringback
    const callId = randomUUID();
    const sessionId = callId;

    let sessionInfo: SessionInfo;
    try {
      sessionInfo = await this.mediaBridge.createSession({
        sessionId,
        providerLeg: { type: 'pending' },
        options: { ringback: true },
      });
    } catch (err) {
      if (err instanceof MediaBridgeUnavailableError) {
        throw new CallOrchestratorError('Media service is unavailable');
      }
      throw err;
    }

    // Select the appropriate SIP URI (sips: when TLS enabled and provider supports it)
    const selectedSipUri = selectSipUri({
      sipUri: sessionInfo.sipUri,
      sipsUri: sessionInfo.sipsUri ?? sessionInfo.sipUri,
      supportsSips: provider.supportsSips ?? false,
      sipTlsEnabled: this.sipTlsEnabled,
    });

    // 3. Initiate the call via the provider, passing the audio connection URL.
    // WebSocket audio providers connect directly to MediaBridge via WebSocket;
    // SIP-based providers connect via the SIP URI.
    const makeCallAudioUrl = provider.usesWebSocketAudio ? sessionInfo.audioWsUrl : selectedSipUri;
    const makeCallResult = await provider.makeCall(from, to, makeCallAudioUrl);

    // 4. PATCH session with provider leg info.
    // For providers using WebSocket audio, tell the MediaBridge to expect
    // a WebSocket connection identified by the provider's callId.
    // For SIP-based providers, set the SIP URI.
    try {
      const isWebsocketProvider = provider.usesWebSocketAudio || providerEntry.type === '46elks';
      if (isWebsocketProvider) {
        await this.mediaBridge.updateSession(sessionId, {
          providerLeg: { type: 'websocket', protocol: provider.providerId, expectedCallId: makeCallResult.callId },
        });
      } else {
        await this.mediaBridge.updateSession(sessionId, {
          providerLeg: { type: 'sip', uri: selectedSipUri },
        });
      }
    } catch (err) {
      this.logger.warn(
        { err, sessionId } as Record<string, unknown>,
        'Failed to patch MediaBridge session with provider leg',
      );
    }

    // 5. Track the active call
    const activeCall: ActiveCall = {
      callId,
      sessionId,
      providerCallId: makeCallResult.callId,
      provider,
      providerId: providerEntry.id,
      from,
      to,
      direction: 'outbound',
      answered: false,
      answeredByDevice: deviceId,
      startedAt: new Date(),
      answeredAt: null,
      ended: false,
      audioWsUrl: sessionInfo.audioWsUrl,
    };

    this.activeCalls.set(callId, activeCall);
    this.sessionToCall.set(sessionId, callId);
    this.providerCallToInternal.set(makeCallResult.callId, callId);

    // 6. Record in call history
    this.callHistory
      .recordCall({
        phone_number: to,
        provider_number: from,
        call_type: 'OUTGOING',
        provider_call_id: makeCallResult.callId,
      })
      .catch((err) => {
        this.logger.error(
          { err, callId } as Record<string, unknown>,
          'Failed to record outbound call in history',
        );
      });

    this.logger.info(
      { callId, from, to, providerCallId: makeCallResult.callId } as Record<string, unknown>,
      'Outbound call initiated',
    );

    return { callId, from, to };
  }

  // ─── Inbound Call ────────────────────────────────────────────────────────

  /**
   * Handle an inbound call from a telephony provider webhook.
   *
   * Flow:
   * 1. Create MediaBridge session with providerLeg: sip
   * 2. Track the call
   * 3. Record as incoming in call history
   * 4. Notify all devices via push + WebSocket
   * 5. Return sipUri for the webhook response (provider connects audio here)
   *
   * Requirements: 5.2, 5.4, 8.3
   */
  async handleInbound(
    providerId: string,
    providerCallId: string,
    from: string,
    to: string,
  ): Promise<InboundCallResult> {
    const providerEntry = this.providerRegistry.getProvider(providerId);
    if (!providerEntry || !providerEntry.instance) {
      throw new ProviderNotAvailableError(`Provider ${providerId} is not available`);
    }

    // Register the provider-to-internal mapping immediately so that concurrent
    // event webhook processing can detect this call is already being handled.
    // This prevents duplicate notifications with the wrong callId.
    const callId = randomUUID();
    const sessionId = callId;
    this.providerCallToInternal.set(providerCallId, callId);

    // 1. Create MediaBridge session — provider leg is 'pending' because
    // Vonage will send a SIP INVITE to the MediaBridge after receiving
    // the SIP connect NCCO. The MediaBridge plays ringback to the WebRTC
    // client while waiting for the provider SIP connection.
    let sessionInfo: SessionInfo;
    try {
      sessionInfo = await this.mediaBridge.createSession({
        sessionId,
        providerLeg: { type: 'pending' },
        options: { ringback: true },
      });
    } catch (err) {
      // Clean up the early mapping on failure
      this.providerCallToInternal.delete(providerCallId);
      if (err instanceof MediaBridgeUnavailableError) {
        throw new CallOrchestratorError('Media service is unavailable');
      }
      throw err;
    }

    // Select the appropriate SIP URI (sips: when TLS enabled and provider supports it)
    const provider = providerEntry.instance!;
    const selectedSipUri = selectSipUri({
      sipUri: sessionInfo.sipUri,
      sipsUri: sessionInfo.sipsUri ?? sessionInfo.sipUri,
      supportsSips: provider.supportsSips ?? false,
      sipTlsEnabled: this.sipTlsEnabled,
    });

    // 2. Track the active call
    const activeCall: ActiveCall = {
      callId,
      sessionId,
      providerCallId,
      provider: providerEntry.instance,
      providerId,
      from,
      to,
      direction: 'inbound',
      answered: false,
      answeredByDevice: null,
      startedAt: new Date(),
      answeredAt: null,
      ended: false,
      audioWsUrl: sessionInfo.audioWsUrl,
    };

    this.activeCalls.set(callId, activeCall);
    this.sessionToCall.set(sessionId, callId);

    // 3. Record incoming call in history
    this.callHistory
      .recordCall({
        id: callId,
        phone_number: from,
        provider_number: to,
        call_type: 'INCOMING',
        provider_call_id: providerCallId,
      })
      .catch((err) => {
        this.logger.error(
          { err, callId } as Record<string, unknown>,
          'Failed to record inbound call in history',
        );
      });

    // 4. Create notification for incoming call (handles WS broadcast + wake signal delivery)
    const numberRecord = (await this.numberManagement.getNumbers()).find((n) => n.number === to);
    this.notificationService
      .createNotification({
        type: 'incoming_call',
        sourceEntityId: callId,
        sourceEntityType: 'call_history',
        payload: {
          callerNumber: from,
          providerNumber: to,
          providerLabel: numberRecord?.label ?? undefined,
          contactName: null,
          timestamp: new Date().toISOString(),
        },
      })
      .catch((err) => {
        this.logger.error(
          { err, callId } as Record<string, unknown>,
          'Failed to create incoming call notification',
        );
      });

    this.logger.info(
      { callId, from, to, providerCallId, providerId } as Record<string, unknown>,
      'Inbound call received — devices notified',
    );

    return { sipUri: selectedSipUri, callId };
  }

  // ─── Answer Call ─────────────────────────────────────────────────────────

  /**
   * Answer a call from a specific device.
   *
   * Flow:
   * 1. Mark call as answered
   * 2. Tell the provider to answer (passing audioWsUrl for WebSocket audio providers)
   * 3. PATCH MediaBridge session with provider leg for WebSocket audio providers
   * 4. Notify other devices with "answered_elsewhere"
   * 5. Mark answered in call history
   *
   * Requirements: 5.2, 8.5
   */
  async answerCall(callId: string, deviceId: string): Promise<AnswerResult> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      return { success: false, errorReason: 'Call not found or already ended' };
    }

    if (activeCall.answered) {
      return { success: false, errorReason: 'Call already answered by another device' };
    }

    // Mark as answered
    activeCall.answered = true;
    activeCall.answeredByDevice = deviceId;
    activeCall.answeredAt = new Date();

    // Tell the provider to answer the inbound call.
    // Providers that manage their own call state (e.g. modem-gateway) will
    // use this to send the answer command. SIP-based providers where audio
    // is already flowing can treat this as a no-op.
    if (activeCall.direction === 'inbound' && activeCall.provider) {
      const audioUrl = activeCall.provider.usesWebSocketAudio
        ? (activeCall.audioWsUrl ?? undefined)
        : undefined;

      try {
        await activeCall.provider.answerCall(activeCall.providerCallId, deviceId, audioUrl);
      } catch (err) {
        activeCall.answered = false;
        activeCall.answeredByDevice = null;
        activeCall.answeredAt = null;
        this.logger.error({ err, callId } as Record<string, unknown>, 'Provider answerCall failed');
        return { success: false, errorReason: 'Failed to answer call' };
      }

      // For WebSocket audio providers, tell MediaBridge to expect the connection
      if (activeCall.provider.usesWebSocketAudio) {
        this.mediaBridge.updateSession(activeCall.sessionId, {
          providerLeg: { type: 'websocket', protocol: activeCall.provider.providerId, expectedCallId: activeCall.providerCallId },
        }).catch((err) => {
          this.logger.warn({ err, callId } as Record<string, unknown>, 'Failed to patch MediaBridge session for provider answer');
        });
      }
    }

    // Notify other devices (answered_elsewhere)
    this.wsBroadcaster.broadcastExcept(deviceId, {
      type: 'call_cancelled',
      data: {
        callId,
        reason: 'answered_elsewhere',
      },
    });

    // Mark answered in call history
    this.callHistory
      .markAnswered(activeCall.providerCallId, deviceId)
      .catch((err) => {
        this.logger.error(
          { err, callId } as Record<string, unknown>,
          'Failed to mark call as answered in history',
        );
      });

    // Mark notification as resolved (read)
    this.notificationService.markCallResolved(callId).catch((err) => {
      this.logger.error(
        { err, callId } as Record<string, unknown>,
        'Failed to mark call notification as resolved',
      );
    });

    this.logger.info(
      { callId, deviceId } as Record<string, unknown>,
      'Call answered',
    );

    return { success: true };
  }

  // ─── WebRTC Offer ────────────────────────────────────────────────────────

  /**
   * Handle a WebRTC SDP offer from a client device.
   *
   * Submits the offer to the MediaBridge and returns the SDP answer.
   *
   * Requirements: 5.1, 5.2
   */
  async handleWebRtcOffer(
    callId: string,
    _deviceId: string,
    sdpOffer: string,
  ): Promise<OfferResult> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      throw new CallNotFoundError(callId);
    }

    try {
      const result = await this.mediaBridge.submitOffer(activeCall.sessionId, sdpOffer);
      return result;
    } catch (err) {
      if (err instanceof MediaBridgeUnavailableError) {
        throw new CallOrchestratorError('Media service is unavailable');
      }
      throw err;
    }
  }

  // ─── ICE Candidate Relay ─────────────────────────────────────────────────

  /**
   * Handle an ICE candidate from a client, routed to the correct MediaBridge session.
   *
   * Since the MediaBridge uses ICE Lite (all candidates are bundled in the
   * SDP answer), trickle ICE from clients is typically a no-op. However, this
   * method validates the call exists and logs the candidate for completeness
   * and for future non-ICE-Lite scenarios.
   *
   * Requirements: 3.2, 6.2
   */
  handleIceCandidate(
    callId: string,
    _deviceId: string,
    candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number },
  ): void {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      this.logger.debug(
        { callId } as Record<string, unknown>,
        'ICE candidate received for unknown call — ignoring',
      );
      return;
    }

    // ICE Lite: MediaBridge bundles all candidates in the SDP answer.
    // Log for debugging; no forwarding needed with current ICE Lite setup.
    this.logger.debug(
      { callId, sessionId: activeCall.sessionId, sdpMid: candidate.sdpMid } as Record<string, unknown>,
      'ICE candidate received from client (ICE Lite — no trickle forwarding needed)',
    );
  }

  /**
   * Relay an ICE candidate from the MediaBridge to the client device.
   *
   * Called when the MediaBridge sends an ice_candidate event via the event
   * WebSocket. Routes the candidate to the device that owns the call.
   *
   * Requirements: 3.2, 6.2
   */
  relayIceCandidateToClient(
    callId: string,
    candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number },
  ): void {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      return;
    }

    // Send to the device that owns this call
    const deviceId = activeCall.answeredByDevice;
    if (deviceId) {
      this.wsBroadcaster.broadcastToDevice(deviceId, {
        type: 'ice_candidate',
        data: {
          callId,
          candidate,
        },
      });
    } else {
      // Outbound call before answer — broadcast to all connected devices
      this.wsBroadcaster.broadcast({
        type: 'ice_candidate',
        data: {
          callId,
          candidate,
        },
      });
    }
  }

  // ─── End Call ────────────────────────────────────────────────────────────

  /**
   * End a call (from any party: client hangup, remote hangup, media disconnect).
   *
   * Flow:
   * 1. Destroy MediaBridge session
   * 2. End call via provider
   * 3. Notify clients via WebSocket
   * 4. Update call history with duration
   * 5. Clean up tracking state
   *
   * Requirements: 5.3, 5.5, 5.6
   */
  async endCall(callId: string, trigger?: string): Promise<void> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      return; // Already ended or not found — no-op
    }

    // Guard against double-end
    if (activeCall.ended) {
      return;
    }
    activeCall.ended = true;

    // Log the call stack to identify what triggered endCall
    this.logger.info(
      { callId, direction: activeCall.direction, providerCallId: activeCall.providerCallId, stack: new Error().stack } as Record<string, unknown>,
      'endCall triggered',
    );

    // 1. Notify clients via WebSocket FIRST — so they know the call ended
    // before the WebRTC connection drops.
    this.wsBroadcaster.broadcast({
      type: 'call_event',
      data: {
        callId,
        status: 'disconnected',
      },
    });

    // 2. Destroy MediaBridge session (best-effort).
    // When triggered by provider disconnect, add a short delay so the signaling
    // message arrives at the client before the WebRTC connection is torn down.
    const destroySession = () => {
      this.mediaBridge.destroySession(activeCall.sessionId).catch((err) => {
        this.logger.warn(
          { err, sessionId: activeCall.sessionId } as Record<string, unknown>,
          'Failed to destroy MediaBridge session',
        );
      });
    };

    if (trigger === 'provider_disconnected') {
      setTimeout(destroySession, 200);
    } else {
      destroySession();
    }

    // 3. End call via provider (best-effort)
    activeCall.provider.endCall(activeCall.providerCallId).catch((err) => {
      this.logger.warn(
        { err, providerCallId: activeCall.providerCallId } as Record<string, unknown>,
        'Failed to end call via provider',
      );
    });

    // 4. Update call history
    const durationSeconds = activeCall.answeredAt
      ? Math.round((Date.now() - activeCall.answeredAt.getTime()) / 1000)
      : null;

    if (activeCall.direction === 'inbound' && !activeCall.answered) {
      if (trigger === 'declined') {
        // User explicitly declined → mark as DECLINED in history and resolve notification
        this.callHistory
          .updateCallTypeByProviderCallId(activeCall.providerCallId, 'DECLINED')
          .catch((err) => {
            this.logger.error(
              { err, callId } as Record<string, unknown>,
              'Failed to update call history to DECLINED',
            );
          });

        this.notificationService.markCallResolved(callId).catch((err) => {
          this.logger.error(
            { err, callId } as Record<string, unknown>,
            'Failed to mark declined call notification as resolved',
          );
        });
      } else {
        // Caller hung up or timeout → mark as MISSED and transition notification
        this.callHistory
          .updateCallTypeByProviderCallId(activeCall.providerCallId, 'MISSED')
          .catch((err) => {
            this.logger.error(
              { err, callId } as Record<string, unknown>,
              'Failed to update call history to MISSED',
            );
          });

        this.notificationService.transitionToMissed(callId).catch((err) => {
          this.logger.error(
            { err, callId } as Record<string, unknown>,
            'Failed to transition call notification to missed',
          );
        });
      }
    } else if (durationSeconds != null && durationSeconds > 0) {
      // Answered call with duration → update duration
      this.callHistory
        .updateDurationByProviderCallId(activeCall.providerCallId, durationSeconds)
        .catch((err) => {
          this.logger.error(
            { err, callId } as Record<string, unknown>,
            'Failed to update call duration in history',
          );
        });
    } else if (activeCall.direction === 'outbound' && !activeCall.answered) {
      // Outbound call never answered → mark as UNANSWERED
      this.callHistory
        .markOutboundUnanswered(activeCall.providerCallId)
        .catch((err) => {
          this.logger.error(
            { err, callId } as Record<string, unknown>,
            'Failed to mark outbound call as UNANSWERED',
          );
        });
    }

    // 5. Clean up tracking state
    this.activeCalls.delete(callId);
    this.sessionToCall.delete(activeCall.sessionId);
    this.providerCallToInternal.delete(activeCall.providerCallId);

    this.logger.info(
      { callId, direction: activeCall.direction, durationSeconds } as Record<string, unknown>,
      'Call ended',
    );
  }

  // ─── Media Bridge Events ─────────────────────────────────────────────────

  /**
   * Handle a media bridge session event.
   *
   * Routes events to appropriate actions:
   * - provider_disconnected → endCall
   * - client_disconnected → endCall
   * - dtmf → forward to provider (if applicable)
   * - client_connected / provider_connected → update call state / notify clients
   *
   * Requirements: 5.3, 5.6
   */
  handleMediaEvent(event: MediaBridgeSessionEvent): void {
    const callId = this.sessionToCall.get(event.sessionId);
    if (!callId) {
      this.logger.debug(
        { sessionId: event.sessionId, event: event.event } as Record<string, unknown>,
        'Received media event for unknown session — ignoring',
      );
      return;
    }

    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      return;
    }

    switch (event.event) {
      case 'provider_disconnected':
        this.logger.info(
          { callId, reason: event.reason } as Record<string, unknown>,
          'Provider disconnected — ending call',
        );
        void this.endCall(callId, 'provider_disconnected');
        break;

      case 'client_disconnected':
        this.logger.info(
          { callId, reason: event.reason } as Record<string, unknown>,
          'Client disconnected — ending call',
        );
        void this.endCall(callId);
        break;

      case 'provider_connected':
        // Provider audio connected — notify client (call is now active)
        if (!activeCall.answered && activeCall.direction === 'outbound') {
          activeCall.answered = true;
          activeCall.answeredAt = new Date();
        }
        this.wsBroadcaster.broadcast({
          type: 'call_event',
          data: {
            callId,
            status: 'connected',
          },
        });
        break;

      case 'client_connected':
        this.logger.debug(
          { callId } as Record<string, unknown>,
          'Client WebRTC connected',
        );
        break;

      case 'dtmf':
        // Forward DTMF digit — currently logged; can be extended to forward to provider
        if (event.digit) {
          this.logger.debug(
            { callId, digit: event.digit } as Record<string, unknown>,
            'DTMF received from provider',
          );
          // Notify client of DTMF if needed (for IVR feedback etc.)
          this.wsBroadcaster.broadcast({
            type: 'call_event',
            data: {
              callId,
              status: 'dtmf',
              digit: event.digit,
            },
          });
        }
        break;

      case 'ice_candidate':
        // Relay ICE candidate from MediaBridge to the correct client
        if (event.candidate) {
          this.relayIceCandidateToClient(callId, event.candidate);
        }
        break;
    }
  }

  // ─── Utility Methods ─────────────────────────────────────────────────────

  /**
   * Look up internal callId by provider call ID.
   * Used by webhook handlers to correlate provider events with internal calls.
   */
  getCallIdByProviderCallId(providerCallId: string): string | undefined {
    return this.providerCallToInternal.get(providerCallId);
  }

  /**
   * Get active call info by callId. Returns null if not found.
   */
  getActiveCall(callId: string): { callId: string; from: string; to: string; direction: string; answered: boolean } | null {
    const call = this.activeCalls.get(callId);
    if (!call) return null;
    return {
      callId: call.callId,
      from: call.from,
      to: call.to,
      direction: call.direction,
      answered: call.answered,
    };
  }

  /**
   * Get all active calls. Used by GET /api/calls/active.
   */
  getAllActiveCalls(): Array<{ callId: string; from: string; to: string; direction: string; status: string; providerNumber: string; startedAt: number }> {
    const calls: Array<{ callId: string; from: string; to: string; direction: string; status: string; providerNumber: string; startedAt: number }> = [];
    for (const call of this.activeCalls.values()) {
      if (call.ended) continue;
      calls.push({
        callId: call.callId,
        from: call.direction === 'inbound' ? call.from : call.to,
        to: call.direction === 'inbound' ? call.to : call.from,
        direction: call.direction,
        status: call.answered ? 'connected' : 'ringing',
        providerNumber: call.direction === 'inbound' ? call.to : call.from,
        startedAt: call.startedAt.getTime(),
      });
    }
    return calls;
  }

  /**
   * End all active calls. Used during MediaBridge failure detection or shutdown.
   */
  async endAllCalls(reason: string): Promise<void> {
    const callIds = Array.from(this.activeCalls.keys());
    this.logger.warn(
      { count: callIds.length, reason } as Record<string, unknown>,
      'Ending all active calls',
    );

    for (const callId of callIds) {
      await this.endCall(callId);
    }
  }

  /**
   * Clean up resources. Call on server shutdown.
   */
  dispose(): void {
    this.activeCalls.clear();
    this.sessionToCall.clear();
    this.providerCallToInternal.clear();
  }
}
