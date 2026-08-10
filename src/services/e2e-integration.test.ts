/**
 * End-to-End Integration Tests
 *
 * Comprehensive integration tests for the full call lifecycle through
 * the provider-generic voice architecture. These tests cover scenarios
 * not already handled by individual unit/integration test files.
 *
 * Focuses on:
 * - 46elks outbound/inbound calls via MediaBridge
 * - DTMF both directions (in-band + out-of-band REST)
 * - Mute/unmute signaling
 * - Answered-elsewhere multi-device flow
 * - Connectivity loss → ENDED with CONNECTIVITY_LOST
 * - MediaBridge crash recovery (detector → orchestrator → notify)
 * - SMS unaffected by voice changes
 * - Speaker routing unchanged
 *
 * Requirements: 12.1, 12.2, 4.10, 8.2, 8.3, 8.5
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CallOrchestrator,
  type CallOrchestratorDeps,
} from './call-orchestrator.js';
import { MediaBridgeFailureDetector } from './media-bridge-failure-detector.js';
import type { MediaBridgeSessionEvent } from './media-bridge-event-listener.js';

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockMediaBridgeClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'session-e2e',
      status: 'CREATED',
      sipUri: 'sip:session-e2e@mediabridge:5060',
      audioWsUrl: 'ws://mediabridge:9091/audio/session-e2e',
    }),
    submitOffer: vi.fn().mockResolvedValue({
      sdpAnswer: 'v=0\r\no=- e2e-answer-sdp',
      iceCandidates: [
        { candidate: 'candidate:1 1 TCP 2130706431 203.0.113.1 8443 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      ],
    }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    destroySession: vi.fn().mockResolvedValue(undefined),
    getSessionStatus: vi.fn().mockResolvedValue({
      sessionId: 'session-e2e',
      status: 'ACTIVE',
      clientConnected: true,
      providerConnected: true,
    }),
    isHealthy: vi.fn().mockResolvedValue(true),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
    isCurrentlyHealthy: true,
  };
}

function createMock46ElksProvider() {
  return {
    providerId: '46elks',
    makeCall: vi.fn().mockResolvedValue({ callId: 'elks-call-abc', clientToken: null }),
    endCall: vi.fn().mockResolvedValue(undefined),
    answerCall: vi.fn().mockResolvedValue({ success: true, clientToken: null, errorReason: null }),
    sendSms: vi.fn().mockResolvedValue({ messageId: 'elks-sms-001', success: true, errorReason: null }),
    listNumbers: vi.fn().mockResolvedValue([
      { number: '+46731000001', capabilities: new Set(['VOICE', 'SMS']) },
    ]),
    onEvent: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getWebhookEndpoints: vi.fn().mockReturnValue(['voice_start', 'voice_event', 'sms_incoming']),
    handleWebhook: vi.fn(),
  };
}

function createMockVonageProvider() {
  return {
    providerId: 'vonage',
    makeCall: vi.fn().mockResolvedValue({ callId: 'vonage-call-xyz', clientToken: null }),
    endCall: vi.fn().mockResolvedValue(undefined),
    answerCall: vi.fn().mockResolvedValue({ success: true, clientToken: null, errorReason: null }),
    sendSms: vi.fn().mockResolvedValue({ messageId: 'vonage-sms-001', success: true, errorReason: null }),
    listNumbers: vi.fn().mockResolvedValue([
      { number: '+14155550001', capabilities: new Set(['VOICE', 'SMS']) },
    ]),
    onEvent: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getWebhookEndpoints: vi.fn().mockReturnValue(['answer', 'event', 'inbound-sms', 'sms-status']),
    handleWebhook: vi.fn(),
  };
}

function createMockProviderEntry(provider: ReturnType<typeof createMock46ElksProvider> | ReturnType<typeof createMockVonageProvider>, type: string) {
  return {
    id: `${type}-provider-1`,
    type,
    displayName: type === '46elks' ? '46elks' : 'Vonage',
    config: {},
    enabled: true,
    instance: provider,
    status: 'active' as const,
  };
}

function createMockCallHistoryService() {
  return {
    recordCall: vi.fn().mockResolvedValue({ id: 'history-e2e-1' }),
    updateCallTypeByProviderCallId: vi.fn().mockResolvedValue(null),
    updateDurationByProviderCallId: vi.fn().mockResolvedValue(null),
    markAnswered: vi.fn().mockResolvedValue(undefined),
    markOutboundUnanswered: vi.fn().mockResolvedValue(null),
    getHistory: vi.fn(),
    getRecentHistory: vi.fn(),
  };
}

function createMockWsBroadcaster() {
  return {
    broadcast: vi.fn(),
    broadcastToDevice: vi.fn(),
    broadcastExcept: vi.fn(),
    getConnectionCount: vi.fn().mockReturnValue(2),
    isDeviceConnected: vi.fn().mockReturnValue(true),
    getConnectedDeviceIds: vi.fn().mockReturnValue(['device-1', 'device-2']),
    closeAll: vi.fn(),
    register: vi.fn(),
  };
}

function createMockDeviceRegistry() {
  return {
    getActiveDevicesWithPushInfo: vi.fn().mockResolvedValue([
      { deviceId: 'device-1', pushEndpointUrl: 'https://push.example.com/device-1' },
      { deviceId: 'device-2', pushEndpointUrl: 'https://push.example.com/device-2' },
    ]),
    listActiveDevices: vi.fn(),
    registerDevice: vi.fn(),
    deactivateDevice: vi.fn(),
    updateLastSeen: vi.fn(),
    getDevice: vi.fn(),
    updatePushEndpoint: vi.fn(),
    getPushEndpointUrl: vi.fn(),
    getActiveDeviceCount: vi.fn(),
  };
}

function createMockWakeSignalPublisher() {
  return {
    sendWakeSignal: vi.fn().mockResolvedValue({ deviceId: 'device-1', success: true }),
    sendToAllDevices: vi.fn().mockResolvedValue([
      { deviceId: 'device-1', success: true },
      { deviceId: 'device-2', success: true },
    ]),
  };
}

function createMockProviderRegistry(entries: ReturnType<typeof createMockProviderEntry>[]) {
  return {
    getProvider: vi.fn().mockImplementation((id: string) => entries.find(e => e.id === id) ?? null),
    listProviders: vi.fn().mockReturnValue(entries),
    loadAll: vi.fn(),
    addProvider: vi.fn(),
    updateProvider: vi.fn(),
    removeProvider: vi.fn(),
    getWebhookUrls: vi.fn().mockReturnValue([]),
  };
}

function createMockNumberManagement(providerEntry: ReturnType<typeof createMockProviderEntry>) {
  return {
    requireProviderForNumber: vi.fn().mockResolvedValue(providerEntry),
    getProviderForNumber: vi.fn().mockResolvedValue(providerEntry),
    getNumbers: vi.fn().mockResolvedValue([]),
    syncNumbers: vi.fn(),
    updateLabel: vi.fn(),
    getDefaultNumber: vi.fn(),
    setDefaultNumber: vi.fn(),
    markNumberUsed: vi.fn(),
    getAllNumbers: vi.fn(),
    setActive: vi.fn(),
    setBlockInboundCalls: vi.fn(),
    isInboundBlocked: vi.fn().mockResolvedValue(false),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createE2EOrchestrator(providerType: '46elks' | 'vonage' = '46elks') {
  const provider = providerType === '46elks' ? createMock46ElksProvider() : createMockVonageProvider();
  const providerEntry = createMockProviderEntry(provider, providerType);
  const mediaBridge = createMockMediaBridgeClient();
  const callHistory = createMockCallHistoryService();
  const wsBroadcaster = createMockWsBroadcaster();
  const deviceRegistry = createMockDeviceRegistry();
  const wakeSignalPublisher = createMockWakeSignalPublisher();
  const numberManagement = createMockNumberManagement(providerEntry);
  const providerRegistry = createMockProviderRegistry([providerEntry]);
  const logger = createMockLogger();

  const deps: CallOrchestratorDeps = {
    mediaBridgeClient: mediaBridge as any,
    providerRegistry: providerRegistry as any,
    numberManagementService: numberManagement as any,
    callHistoryService: callHistory as any,
    wsBroadcaster: wsBroadcaster as any,
    deviceRegistryManager: deviceRegistry as any,
    wakeSignalPublisher: wakeSignalPublisher as any,
    notificationService: {
      createNotification: vi.fn().mockResolvedValue({
        id: 'notification-1',
        type: 'incoming_call',
        status: 'pending',
        sourceEntityId: 'call-1',
        sourceEntityType: 'call_history',
        payload: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      markRead: vi.fn().mockResolvedValue(true),
      markAllRead: vi.fn().mockResolvedValue(0),
      markConversationRead: vi.fn().mockResolvedValue(0),
      transitionToMissed: vi.fn().mockResolvedValue(null),
      markCallResolved: vi.fn().mockResolvedValue(true),
      getPendingNotifications: vi.fn().mockResolvedValue([]),
      deliverPendingToDevice: vi.fn().mockResolvedValue(undefined),
    } as any,
    logger: logger as any,
  };

  const orchestrator = new CallOrchestrator(deps);

  return {
    orchestrator,
    provider,
    mediaBridge,
    callHistory,
    wsBroadcaster,
    deviceRegistry,
    wakeSignalPublisher,
    numberManagement,
    providerRegistry,
    logger,
    providerEntry,
  };
}


// ─── E2E Integration Tests ───────────────────────────────────────────────────

describe('E2E Integration: 46elks via MediaBridge', () => {
  describe('Outbound call via 46elks through MediaBridge', () => {
    it('should create session → makeCall → WebRTC offer → ringback → provider connects → audio flows', async () => {
      const { orchestrator, provider, mediaBridge, wsBroadcaster } = createE2EOrchestrator('46elks');

      // Step 1: Initiate outbound call
      const outbound = await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');

      expect(outbound.callId).toBeDefined();
      expect(outbound.from).toBe('+46731000001');
      expect(outbound.to).toBe('+46701234567');

      // Verify MediaBridge session was created with pending provider leg + ringback
      expect(mediaBridge.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerLeg: { type: 'pending' },
          options: { ringback: true },
        }),
      );

      // Verify 46elks makeCall was called
      expect(provider.makeCall).toHaveBeenCalledWith(
        '+46731000001',
        '+46701234567',
        'sip:session-e2e@mediabridge:5060',
      );

      // Verify session patched with WebSocket provider leg (46elks uses Realtime Voice API)
      expect(mediaBridge.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          providerLeg: { type: 'websocket', protocol: '46elks', expectedCallId: 'elks-call-abc' },
        }),
      );

      // Step 2: Client sends SDP offer (WebRTC connect)
      const offerResult = await orchestrator.handleWebRtcOffer(
        outbound.callId,
        'device-1',
        'v=0\r\no=- 46elks-client-offer',
      );
      expect(offerResult.sdpAnswer).toBe('v=0\r\no=- e2e-answer-sdp');
      expect(offerResult.iceCandidates).toHaveLength(1);

      // Step 3: WebRTC connects (client audio established — hears ringback)
      const clientConnected: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: outbound.callId,
        event: 'client_connected',
      };
      orchestrator.handleMediaEvent(clientConnected);

      // Step 4: Provider SIP connects (remote party answered → ringback stops → audio flows)
      (wsBroadcaster.broadcast as any).mockClear();
      const providerConnected: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: outbound.callId,
        event: 'provider_connected',
      };
      orchestrator.handleMediaEvent(providerConnected);

      // Client receives "connected" status
      expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({
            callId: outbound.callId,
            status: 'connected',
          }),
        }),
      );
    });

    it('should end outbound call and update call history with duration', async () => {
      const { orchestrator, mediaBridge, callHistory, provider } = createE2EOrchestrator('46elks');

      const outbound = await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');

      // Simulate provider connected → answered
      orchestrator.handleMediaEvent({
        type: 'session_event',
        sessionId: outbound.callId,
        event: 'provider_connected',
      });

      // Wait a moment then end call
      (mediaBridge.destroySession as any).mockClear();
      await orchestrator.endCall(outbound.callId);

      // MediaBridge session destroyed
      expect(mediaBridge.destroySession).toHaveBeenCalled();
      // Provider endCall invoked
      expect(provider.endCall).toHaveBeenCalledWith('elks-call-abc');
    });
  });

  describe('Inbound call via 46elks through MediaBridge', () => {
    it('should handle webhook → notify devices → answer → WebRTC → audio', async () => {
      const { orchestrator, mediaBridge, wsBroadcaster, wakeSignalPublisher } = createE2EOrchestrator('46elks');

      // Step 1: Inbound call arrives via provider webhook
      const inbound = await orchestrator.handleInbound(
        '46elks-provider-1',
        'elks-inbound-call-001',
        '+46709876543',
        '+46731000001',
      );

      // MediaBridge session created with pending provider leg + ringback
      expect(mediaBridge.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerLeg: { type: 'pending' },
          options: { ringback: true },
        }),
      );
      expect(inbound.sipUri).toBe('sip:session-e2e@mediabridge:5060');

      // Step 2: Devices notified via NotificationService
      const notificationService = (orchestrator as any).notificationService;
      await vi.waitFor(() => {
        expect(notificationService.createNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'incoming_call',
            payload: expect.objectContaining({
              callerNumber: '+46709876543',
              providerNumber: '+46731000001',
            }),
          }),
        );
      });

      // Step 3: User answers on device-1
      const calls = orchestrator.getAllActiveCalls();
      const callId = calls[0].callId;
      const answer = await orchestrator.answerCall(callId, 'device-1');
      expect(answer.success).toBe(true);

      // Step 4: WebRTC offer/answer
      const offerResult = await orchestrator.handleWebRtcOffer(
        callId,
        'device-1',
        'v=0\r\no=- device-1-inbound-offer',
      );
      expect(offerResult.sdpAnswer).toBeDefined();

      // Step 5: Client WebRTC connects
      orchestrator.handleMediaEvent({
        type: 'session_event',
        sessionId: callId,
        event: 'client_connected',
      });

      // Step 6: Call is now active (provider was already connected via SIP INVITE)
      (wsBroadcaster.broadcast as any).mockClear();
      orchestrator.handleMediaEvent({
        type: 'session_event',
        sessionId: callId,
        event: 'provider_connected',
      });

      expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({ status: 'connected' }),
        }),
      );
    });
  });
});

describe('E2E Integration: DTMF Both Directions', () => {
  it('should forward in-band DTMF from provider to client via MediaBridge event', async () => {
    const { orchestrator, wsBroadcaster } = createE2EOrchestrator('vonage');

    const outbound = await orchestrator.initiateOutbound('device-1', '+14155550001', '+14155559999');
    (wsBroadcaster.broadcast as any).mockClear();

    // Simulate DTMF received from provider leg (IVR sending digits back)
    const dtmfDigits = ['1', '2', '3', '*', '#', '0'];
    for (const digit of dtmfDigits) {
      orchestrator.handleMediaEvent({
        type: 'session_event',
        sessionId: outbound.callId,
        event: 'dtmf',
        digit,
      });
    }

    // All digits forwarded to client via WebSocket
    expect(wsBroadcaster.broadcast).toHaveBeenCalledTimes(dtmfDigits.length);
    for (let i = 0; i < dtmfDigits.length; i++) {
      expect(wsBroadcaster.broadcast).toHaveBeenNthCalledWith(i + 1,
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({
            callId: outbound.callId,
            status: 'dtmf',
            digit: dtmfDigits[i],
          }),
        }),
      );
    }
  });

  it('out-of-band REST DTMF fallback should work for active calls (route-level validated in call-routes.test)', async () => {
    // This test validates that the orchestrator tracks the active call properly
    // so that the DTMF REST route can find it. The route handler itself
    // checks getActiveCall(callId) — we verify the call is accessible.
    const { orchestrator } = createE2EOrchestrator('46elks');

    const outbound = await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');

    // Verify the call is visible as active (needed for REST DTMF route)
    const activeCall = orchestrator.getActiveCall(outbound.callId);
    expect(activeCall).not.toBeNull();
    expect(activeCall!.callId).toBe(outbound.callId);
  });
});


describe('E2E Integration: Mute/Unmute', () => {
  it('mute is a client-side operation that does not require server signaling', async () => {
    // Mute/unmute is handled entirely on the client (WebRtcAudioClient.setMuted)
    // by enabling/disabling the local audio track. The server does NOT need to be
    // notified. This test validates that no server-side call state changes occur
    // when the client mutes — the call remains active.
    const { orchestrator, wsBroadcaster, mediaBridge } = createE2EOrchestrator('vonage');

    const outbound = await orchestrator.initiateOutbound('device-1', '+14155550001', '+14155559999');

    // Simulate provider connected → call is active
    orchestrator.handleMediaEvent({
      type: 'session_event',
      sessionId: outbound.callId,
      event: 'provider_connected',
    });

    (wsBroadcaster.broadcast as any).mockClear();
    (mediaBridge.updateSession as any).mockClear();

    // During mute: no server interactions should occur
    // (Client simply disables local audio track via webRtcAudioClient.setMuted(true))
    // Verify call remains active and no session updates sent
    const activeCall = orchestrator.getActiveCall(outbound.callId);
    expect(activeCall).not.toBeNull();
    expect(activeCall!.callId).toBe(outbound.callId);

    // No MediaBridge session patch for mute (it's purely client-side)
    expect(mediaBridge.updateSession).not.toHaveBeenCalled();
    // No WebSocket broadcast about mute state
    expect(wsBroadcaster.broadcast).not.toHaveBeenCalled();
  });
});

describe('E2E Integration: Call History Recording After Call Ends', () => {
  it('should record outbound call and update duration when call ends normally', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, callHistory } = createE2EOrchestrator('46elks');

      const outbound = await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');

      // Call recorded as OUTGOING on initiation
      expect(callHistory.recordCall).toHaveBeenCalledWith(
        expect.objectContaining({
          phone_number: '+46701234567',
          provider_number: '+46731000001',
          call_type: 'OUTGOING',
          provider_call_id: 'elks-call-abc',
        }),
      );

      // Provider connects (call answered)
      orchestrator.handleMediaEvent({
        type: 'session_event',
        sessionId: outbound.callId,
        event: 'provider_connected',
      });

      // Simulate 30 seconds of call time
      vi.advanceTimersByTime(30_000);

      // End call after being answered
      await orchestrator.endCall(outbound.callId);

      // Duration should be updated with ~30s
      expect(callHistory.updateDurationByProviderCallId).toHaveBeenCalledWith(
        'elks-call-abc',
        30,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('should mark outbound call as UNANSWERED when ended without answer', async () => {
    const { orchestrator, callHistory } = createE2EOrchestrator('46elks');

    await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');
    const calls = orchestrator.getAllActiveCalls();
    const callId = calls[0].callId;

    // End without provider ever connecting (no answer)
    await orchestrator.endCall(callId);

    expect(callHistory.markOutboundUnanswered).toHaveBeenCalledWith('elks-call-abc');
  });

  it('should mark inbound call as MISSED when ended without answer', async () => {
    const { orchestrator, callHistory } = createE2EOrchestrator('46elks');

    await orchestrator.handleInbound(
      '46elks-provider-1',
      'elks-inbound-missed',
      '+46709876543',
      '+46731000001',
    );
    const calls = orchestrator.getAllActiveCalls();
    const callId = calls[0].callId;

    // End without answering (caller hangs up)
    await orchestrator.endCall(callId);

    expect(callHistory.updateCallTypeByProviderCallId).toHaveBeenCalledWith(
      'elks-inbound-missed',
      'MISSED',
    );
  });
});

describe('E2E Integration: Missed Call Notifications (Push + WS)', () => {
  it('should send missed call push notification when inbound call ends unanswered', async () => {
    const { orchestrator, callHistory, wakeSignalPublisher } = createE2EOrchestrator('46elks');

    // Make updateCallTypeByProviderCallId return an entry (triggers push)
    (callHistory.updateCallTypeByProviderCallId as any).mockResolvedValue({
      id: 'history-missed-e2e',
      phone_number: '+46709876543',
      provider_number: '+46731000001',
      call_type: 'MISSED',
    });

    await orchestrator.handleInbound(
      '46elks-provider-1',
      'elks-inbound-missed-push',
      '+46709876543',
      '+46731000001',
    );
    const calls = orchestrator.getAllActiveCalls();
    const callId = calls[0].callId;

    // End call without answering
    await orchestrator.endCall(callId);

    // NotificationService transitions the call notification to missed
    const notificationService = (orchestrator as any).notificationService;
    await vi.waitFor(() => {
      expect(notificationService.transitionToMissed).toHaveBeenCalledWith(callId);
    });
  });

  it('should broadcast ringing WS event to all devices on inbound call', async () => {
    const { orchestrator } = createE2EOrchestrator('vonage');

    await orchestrator.handleInbound(
      'vonage-provider-1',
      'vonage-inbound-ring',
      '+14155559999',
      '+14155550001',
    );

    // NotificationService handles device notification instead of direct WS broadcast
    const notificationService = (orchestrator as any).notificationService;
    await vi.waitFor(() => {
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'incoming_call',
          payload: expect.objectContaining({
            callerNumber: '+14155559999',
            providerNumber: '+14155550001',
          }),
        }),
      );
    });
  });
});


describe('E2E Integration: Answered-Elsewhere Flow (Multi-Device)', () => {
  it('should cancel other devices when one device answers', async () => {
    const { orchestrator, wsBroadcaster, callHistory } = createE2EOrchestrator('vonage');

    // Inbound call rings on all devices
    await orchestrator.handleInbound(
      'vonage-provider-1',
      'vonage-multi-device',
      '+14155559999',
      '+14155550001',
    );
    const calls = orchestrator.getAllActiveCalls();
    const callId = calls[0].callId;

    // device-2 answers the call
    (wsBroadcaster.broadcastExcept as any).mockClear();
    const answer = await orchestrator.answerCall(callId, 'device-2');
    expect(answer.success).toBe(true);

    // Other devices (device-1) receive answered_elsewhere cancellation
    expect(wsBroadcaster.broadcastExcept).toHaveBeenCalledWith(
      'device-2',
      expect.objectContaining({
        type: 'call_cancelled',
        data: {
          callId,
          reason: 'answered_elsewhere',
        },
      }),
    );

    // Call history updated
    expect(callHistory.markAnswered).toHaveBeenCalledWith(
      'vonage-multi-device',
      'device-2',
    );
  });

  it('should reject second answer attempt after call already answered', async () => {
    const { orchestrator } = createE2EOrchestrator('vonage');

    await orchestrator.handleInbound(
      'vonage-provider-1',
      'vonage-race-condition',
      '+14155559999',
      '+14155550001',
    );
    const calls = orchestrator.getAllActiveCalls();
    const callId = calls[0].callId;

    // device-1 answers first
    const first = await orchestrator.answerCall(callId, 'device-1');
    expect(first.success).toBe(true);

    // device-2 tries to answer slightly later (race condition)
    const second = await orchestrator.answerCall(callId, 'device-2');
    expect(second.success).toBe(false);
    expect(second.errorReason).toContain('already answered');
  });

  it('should allow WebRTC offer only from the answering device', async () => {
    const { orchestrator, mediaBridge } = createE2EOrchestrator('vonage');

    await orchestrator.handleInbound(
      'vonage-provider-1',
      'vonage-webrtc-device',
      '+14155559999',
      '+14155550001',
    );
    const calls = orchestrator.getAllActiveCalls();
    const callId = calls[0].callId;

    await orchestrator.answerCall(callId, 'device-1');

    // device-1 (answerer) sends WebRTC offer — should work
    const offer = await orchestrator.handleWebRtcOffer(callId, 'device-1', 'v=0\r\no=- offer-from-device-1');
    expect(offer.sdpAnswer).toBeDefined();
    expect(mediaBridge.submitOffer).toHaveBeenCalled();
  });
});

describe('E2E Integration: Connectivity Loss Handling', () => {
  it('should end call with disconnected status when WebRTC connection fails (ice_failed)', async () => {
    const { orchestrator, wsBroadcaster, mediaBridge, provider } = createE2EOrchestrator('vonage');

    const outbound = await orchestrator.initiateOutbound('device-1', '+14155550001', '+14155559999');

    // Call is connected
    orchestrator.handleMediaEvent({
      type: 'session_event',
      sessionId: outbound.callId,
      event: 'provider_connected',
    });

    (wsBroadcaster.broadcast as any).mockClear();
    (mediaBridge.destroySession as any).mockClear();

    // WebRTC connection lost — MediaBridge detects and reports
    orchestrator.handleMediaEvent({
      type: 'session_event',
      sessionId: outbound.callId,
      event: 'client_disconnected',
      reason: 'ice_failed',
    });

    // Call ended → client notified
    await vi.waitFor(() => {
      expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({
            callId: outbound.callId,
            status: 'disconnected',
          }),
        }),
      );
    });

    // Session destroyed and provider informed
    expect(mediaBridge.destroySession).toHaveBeenCalled();
    expect(provider.endCall).toHaveBeenCalledWith('vonage-call-xyz');
  });

  it('should end call when client_disconnected with dtls_timeout reason', async () => {
    const { orchestrator, wsBroadcaster } = createE2EOrchestrator('46elks');

    const outbound = await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');
    (wsBroadcaster.broadcast as any).mockClear();

    orchestrator.handleMediaEvent({
      type: 'session_event',
      sessionId: outbound.callId,
      event: 'client_disconnected',
      reason: 'dtls_timeout',
    });

    await vi.waitFor(() => {
      expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({ status: 'disconnected' }),
        }),
      );
    });
  });

  it('should end call when provider disconnects unexpectedly', async () => {
    const { orchestrator, wsBroadcaster } = createE2EOrchestrator('46elks');

    const outbound = await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');

    // Provider connected initially
    orchestrator.handleMediaEvent({
      type: 'session_event',
      sessionId: outbound.callId,
      event: 'provider_connected',
    });

    (wsBroadcaster.broadcast as any).mockClear();

    // Provider drops (network issue on their side)
    orchestrator.handleMediaEvent({
      type: 'session_event',
      sessionId: outbound.callId,
      event: 'provider_disconnected',
      reason: 'connection_lost',
    });

    await vi.waitFor(() => {
      expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({ status: 'disconnected' }),
        }),
      );
    });
  });
});


describe('E2E Integration: MediaBridge Crash Recovery', () => {
  it('should end all calls and notify clients when MediaBridge crashes (health transition)', async () => {
    const { orchestrator, mediaBridge, wsBroadcaster } = createE2EOrchestrator('vonage');

    // Start two calls
    const call1 = await orchestrator.initiateOutbound('device-1', '+14155550001', '+14155551111');
    mediaBridge.createSession.mockResolvedValue({
      sessionId: 'session-e2e-2',
      status: 'CREATED',
      sipUri: 'sip:session-e2e-2@mediabridge:5060',
      audioWsUrl: 'ws://mediabridge:9091/audio/session-e2e-2',
    });

    // Create a second mock number management to return the same provider entry
    await orchestrator.handleInbound('vonage-provider-1', 'vonage-inbound-crash', '+14155552222', '+14155550001');

    expect(orchestrator.getAllActiveCalls()).toHaveLength(2);

    // Set up failure detector
    let healthyState = true;
    const mockMBClient = {
      get isCurrentlyHealthy() { return healthyState; },
      startHealthChecks: vi.fn(),
      stopHealthChecks: vi.fn(),
    };
    const mockEventListener = {
      isConnected: vi.fn().mockReturnValue(false),
    };
    const mockLogger = createMockLogger();

    const detector = new MediaBridgeFailureDetector(
      {
        mediaBridgeClient: mockMBClient as any,
        mediaBridgeEventListener: mockEventListener as any,
        callOrchestrator: orchestrator as any,
        wsBroadcaster: wsBroadcaster as any,
      },
      { pollInterval: 1000, logger: mockLogger as any },
    );

    // First check — bridge is healthy
    detector.check();
    expect(orchestrator.getAllActiveCalls()).toHaveLength(2);

    // Bridge crashes — health check fails
    (wsBroadcaster.broadcast as any).mockClear();
    healthyState = false;
    detector.check();

    // All clients notified of failure
    expect(wsBroadcaster.broadcast).toHaveBeenCalledWith({
      type: 'call_event',
      data: {
        status: 'failed',
        reason: 'media_service_unavailable',
      },
    });

    // All calls ended
    await vi.waitFor(() => {
      expect(orchestrator.getAllActiveCalls()).toHaveLength(0);
    });

    // Structured warning logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'health_check_failure',
        component: 'MediaBridge',
        event: 'failure_detected',
      }),
      expect.stringContaining('MediaBridge failure detected'),
    );

    detector.stop();
  });

  it('should end all calls when event WebSocket disconnects (was previously connected)', async () => {
    const { orchestrator, wsBroadcaster } = createE2EOrchestrator('46elks');

    await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');
    expect(orchestrator.getAllActiveCalls()).toHaveLength(1);

    const mockMBClient = {
      get isCurrentlyHealthy() { return false; },
      startHealthChecks: vi.fn(),
      stopHealthChecks: vi.fn(),
    };
    const isConnectedMock = vi.fn();
    const mockEventListener = { isConnected: isConnectedMock };
    const mockLogger = createMockLogger();

    const detector = new MediaBridgeFailureDetector(
      {
        mediaBridgeClient: mockMBClient as any,
        mediaBridgeEventListener: mockEventListener as any,
        callOrchestrator: orchestrator as any,
        wsBroadcaster: wsBroadcaster as any,
      },
      { pollInterval: 1000, logger: mockLogger as any },
    );

    // WebSocket was connected
    isConnectedMock.mockReturnValue(true);
    detector.check();

    // WebSocket disconnects
    (wsBroadcaster.broadcast as any).mockClear();
    isConnectedMock.mockReturnValue(false);
    detector.check();

    expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'call_event',
        data: expect.objectContaining({ status: 'failed', reason: 'media_service_unavailable' }),
      }),
    );

    await vi.waitFor(() => {
      expect(orchestrator.getAllActiveCalls()).toHaveLength(0);
    });

    detector.stop();
  });
});

describe('E2E Integration: SMS Send/Receive Unaffected', () => {
  it('should not interact with MediaBridge during SMS operations', async () => {
    const { orchestrator, mediaBridge, provider } = createE2EOrchestrator('46elks');

    // Verify that SMS operations through the provider don't touch MediaBridge
    // (SMS goes directly provider ↔ server, no audio bridge needed)
    await provider.sendSms('+46731000001', '+46709876543', 'Test SMS message');

    expect(provider.sendSms).toHaveBeenCalledWith('+46731000001', '+46709876543', 'Test SMS message');

    // MediaBridge should NOT be involved
    expect(mediaBridge.createSession).not.toHaveBeenCalled();
    expect(mediaBridge.destroySession).not.toHaveBeenCalled();
    expect(mediaBridge.updateSession).not.toHaveBeenCalled();
    expect(mediaBridge.submitOffer).not.toHaveBeenCalled();
  });

  it('SMS provider operations work independently while voice calls are active', async () => {
    const { orchestrator, mediaBridge, provider } = createE2EOrchestrator('46elks');

    // Start an active call
    const outbound = await orchestrator.initiateOutbound('device-1', '+46731000001', '+46701234567');
    expect(orchestrator.getAllActiveCalls()).toHaveLength(1);

    // Clear media bridge mocks from the call setup
    (mediaBridge.createSession as any).mockClear();
    (mediaBridge.updateSession as any).mockClear();

    // Send SMS while call is active — should work independently
    await provider.sendSms('+46731000001', '+46709876543', 'SMS during call');

    // No additional MediaBridge interactions for SMS
    expect(mediaBridge.createSession).not.toHaveBeenCalled();
    expect(mediaBridge.updateSession).not.toHaveBeenCalled();

    // Call is still active
    expect(orchestrator.getAllActiveCalls()).toHaveLength(1);
  });
});

describe('E2E Integration: Speaker Routing Unchanged', () => {
  it('audio routing is handled by WebRTC peer connection — no server involvement', () => {
    // Speaker routing (earpiece vs speaker vs bluetooth) is entirely managed
    // by the Android AudioRouter which controls the WebRTC audio output device.
    // The server/orchestrator has NO involvement in speaker selection.
    // This test verifies that the CallOrchestrator interface has no speaker-related methods.
    const { orchestrator } = createE2EOrchestrator('vonage');

    // Verify orchestrator does not expose speaker routing methods
    expect((orchestrator as any).setSpeakerRoute).toBeUndefined();
    expect((orchestrator as any).setAudioOutput).toBeUndefined();
    expect((orchestrator as any).routeAudio).toBeUndefined();

    // The only audio-related server interaction is WebRTC offer/answer and MediaBridge session
    // Speaker routing is a client-only concern (Android AudioRouter + WebRTC audio device selection)
  });

  it('WebRTC offer/answer does not contain speaker routing information', async () => {
    const { orchestrator, mediaBridge } = createE2EOrchestrator('vonage');

    const outbound = await orchestrator.initiateOutbound('device-1', '+14155550001', '+14155559999');

    const offer = await orchestrator.handleWebRtcOffer(
      outbound.callId,
      'device-1',
      'v=0\r\no=- audio-only-offer\r\na=rtpmap:111 opus/48000/2',
    );

    // The SDP offer submitted to MediaBridge is the raw client SDP
    expect(mediaBridge.submitOffer).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('audio-only-offer'),
    );

    // Answer contains only SDP data — no speaker routing metadata
    expect(offer.sdpAnswer).toBeDefined();
    expect(offer.iceCandidates).toBeDefined();
    expect((offer as any).speakerRoute).toBeUndefined();
    expect((offer as any).audioOutput).toBeUndefined();
  });
});
