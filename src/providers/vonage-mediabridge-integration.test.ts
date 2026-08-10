/**
 * Vonage MediaBridge Integration Tests
 *
 * Verifies that the Vonage provider properly routes voice calls through
 * the MediaBridge SIP infrastructure, and that existing features (webhooks,
 * SMS, call history, push notifications) continue to function.
 *
 * Requirements: 10.5, 10.6, 12.1, 12.2
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CallOrchestrator,
  type CallOrchestratorDeps,
} from '../services/call-orchestrator.js';
import { VonageTelephonyProvider } from './vonage-telephony-provider.js';
import type { TelephonyEvent } from './telephony-provider.js';
import type { MediaBridgeSessionEvent } from '../services/media-bridge-event-listener.js';
import { MediaBridgeUnavailableError } from '../services/media-bridge-client.js';

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockMediaBridgeClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'session-001',
      status: 'CREATED',
      sipUri: 'sip:session-001@mediabridge:5060',
      audioWsUrl: 'ws://mediabridge:9091/audio/session-001',
    }),
    submitOffer: vi.fn().mockResolvedValue({
      sdpAnswer: 'v=0\r\no=- answer-sdp',
      iceCandidates: [{ candidate: 'candidate:1 1 TCP 2130706431 192.168.1.1 8443 typ host', sdpMid: '0', sdpMLineIndex: 0 }],
    }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    destroySession: vi.fn().mockResolvedValue(undefined),
    getSessionStatus: vi.fn().mockResolvedValue({ sessionId: 'session-001', status: 'ACTIVE', clientConnected: true, providerConnected: true }),
    isHealthy: vi.fn().mockResolvedValue(true),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
    isCurrentlyHealthy: true,
  };
}

function createMockVonageProvider() {
  const provider = new VonageTelephonyProvider({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    applicationId: '00000000-0000-0000-0000-000000000000',
    privateKey: 'fake-private-key',
    webhookBaseUrl: 'https://example.com',
  });

  // Mock the makeCall/endCall that require SDK init
  const mockMakeCall = vi.fn().mockResolvedValue({ callId: 'vonage-call-uuid-123', clientToken: null });
  const mockEndCall = vi.fn().mockResolvedValue(undefined);
  (provider as any).makeCall = mockMakeCall;
  (provider as any).endCall = mockEndCall;

  return { provider, mockMakeCall, mockEndCall };
}

function createMockProviderEntry(provider: VonageTelephonyProvider) {
  return {
    id: 'vonage-provider-1',
    type: 'vonage',
    displayName: 'Vonage',
    config: {},
    enabled: true,
    instance: provider,
    status: 'active' as const,
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

function createMockCallHistoryService() {
  return {
    recordCall: vi.fn().mockResolvedValue({ id: 'history-1' }),
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
    getConnectionCount: vi.fn().mockReturnValue(1),
    isDeviceConnected: vi.fn().mockReturnValue(true),
    getConnectedDeviceIds: vi.fn().mockReturnValue(['device-1']),
    closeAll: vi.fn(),
    register: vi.fn(),
  };
}

function createMockDeviceRegistry() {
  return {
    getActiveDevicesWithPushInfo: vi.fn().mockResolvedValue([
      { deviceId: 'device-1', pushEndpointUrl: 'https://push.example.com/device-1' },
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
    sendToAllDevices: vi.fn().mockResolvedValue([{ deviceId: 'device-1', success: true }]),
  };
}

function createMockProviderRegistry(providerEntry: ReturnType<typeof createMockProviderEntry>) {
  return {
    getProvider: vi.fn().mockReturnValue(providerEntry),
    listProviders: vi.fn().mockReturnValue([providerEntry]),
    loadAll: vi.fn(),
    addProvider: vi.fn(),
    updateProvider: vi.fn(),
    removeProvider: vi.fn(),
    getWebhookUrls: vi.fn().mockReturnValue([]),
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

function createFullOrchestrator() {
  const { provider, mockMakeCall, mockEndCall } = createMockVonageProvider();
  const providerEntry = createMockProviderEntry(provider);
  const mediaBridge = createMockMediaBridgeClient();
  const callHistory = createMockCallHistoryService();
  const wsBroadcaster = createMockWsBroadcaster();
  const deviceRegistry = createMockDeviceRegistry();
  const wakeSignalPublisher = createMockWakeSignalPublisher();
  const numberManagement = createMockNumberManagement(providerEntry);
  const providerRegistry = createMockProviderRegistry(providerEntry);
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
    mockMakeCall,
    mockEndCall,
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


// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Vonage MediaBridge Integration', () => {
  describe('Outbound calls through MediaBridge SIP', () => {
    it('should create MediaBridge session and pass sipUri to Vonage makeCall', async () => {
      const { orchestrator, mockMakeCall, mediaBridge } = createFullOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      // MediaBridge session created with pending provider leg + ringback
      expect(mediaBridge.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerLeg: { type: 'pending' },
          options: { ringback: true },
        }),
      );

      // Provider.makeCall receives the sipUri from MediaBridge
      expect(mockMakeCall).toHaveBeenCalledWith(
        '+46701234567',
        '+46709876543',
        'sip:session-001@mediabridge:5060',
      );

      // Session patched with SIP leg info for provider audio routing
      expect(mediaBridge.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          providerLeg: { type: 'sip', uri: 'sip:session-001@mediabridge:5060' },
        }),
      );

      expect(result.callId).toBeDefined();
      expect(result.from).toBe('+46701234567');
      expect(result.to).toBe('+46709876543');
    });

    it('should generate SIP connect NCCO for outbound calls', () => {
      const { provider } = createMockVonageProvider();
      const sipUri = 'sip:session-xyz@mediabridge:5060';

      const ncco = provider.generateAnswerNcco({
        from: '+46701234567',
        to: '+46709876543',
        direction: 'outbound',
        sipUri,
      });

      // NCCO must connect to SIP endpoint (MediaBridge), not directly to phone
      expect(ncco).toHaveLength(1);
      expect(ncco[0]).toMatchObject({
        action: 'connect',
        endpoint: [{ type: 'sip', uri: sipUri }],
        from: '+46701234567',
      });
    });

    it('should complete WebRTC signaling after outbound call initiation', async () => {
      const { orchestrator, mediaBridge } = createFullOrchestrator();

      const outbound = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      // Client sends SDP offer → MediaBridge returns answer
      const offerResult = await orchestrator.handleWebRtcOffer(
        outbound.callId,
        'device-1',
        'v=0\r\no=- client-offer',
      );

      expect(mediaBridge.submitOffer).toHaveBeenCalledWith(
        expect.any(String),
        'v=0\r\no=- client-offer',
      );
      expect(offerResult.sdpAnswer).toBe('v=0\r\no=- answer-sdp');
      expect(offerResult.iceCandidates).toHaveLength(1);
    });
  });

  describe('Inbound calls through MediaBridge SIP', () => {
    it('should create MediaBridge session and return sipUri for webhook response', async () => {
      const { orchestrator, mediaBridge } = createFullOrchestrator();

      const result = await orchestrator.handleInbound(
        'vonage-provider-1',
        'vonage-inbound-uuid',
        '+46709876543',
        '+46701234567',
      );

      // MediaBridge session created with pending provider leg + ringback
      expect(mediaBridge.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerLeg: { type: 'pending' },
          options: { ringback: true },
        }),
      );

      // Returns sipUri that the webhook handler uses in the NCCO response
      expect(result.sipUri).toBe('sip:session-001@mediabridge:5060');
      expect(result.callId).toBeDefined();
    });

    it('should generate SIP connect NCCO for inbound calls', () => {
      const { provider } = createMockVonageProvider();
      const sipUri = 'sip:session-inbound@mediabridge:5060';

      const ncco = provider.generateAnswerNcco({
        from: '+46709876543',
        to: '+46701234567',
        sipUri,
      });

      // Inbound call connects to MediaBridge SIP (not to app user)
      expect(ncco).toHaveLength(1);
      expect(ncco[0]).toMatchObject({
        action: 'connect',
        endpoint: [{ type: 'sip', uri: sipUri }],
        from: '+46709876543',
      });
    });

    it('should notify devices and support answer + WebRTC flow', async () => {
      const { orchestrator, wsBroadcaster, mediaBridge, wakeSignalPublisher, deviceRegistry } = createFullOrchestrator();

      // 1. Inbound call arrives
      const inbound = await orchestrator.handleInbound(
        'vonage-provider-1',
        'vonage-inbound-uuid',
        '+46709876543',
        '+46701234567',
      );

      // Devices notified via NotificationService (which handles WS broadcast + push)
      const notificationService = (orchestrator as any).notificationService;
      await vi.waitFor(() => {
        expect(notificationService.createNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'incoming_call',
            sourceEntityType: 'call_history',
            payload: expect.objectContaining({
              callerNumber: '+46709876543',
              providerNumber: '+46701234567',
            }),
          }),
        );
      });

      // 2. User answers
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;
      const answer = await orchestrator.answerCall(callId, 'device-1');
      expect(answer.success).toBe(true);

      // 3. WebRTC offer/answer
      const offerResult = await orchestrator.handleWebRtcOffer(
        callId,
        'device-1',
        'v=0\r\no=- device-sdp-offer',
      );
      expect(offerResult.sdpAnswer).toBeDefined();
    });
  });

  describe('Call events flow through CallOrchestrator', () => {
    it('should broadcast "connected" on provider_connected event (ringing → connected)', async () => {
      const { orchestrator, wsBroadcaster } = createFullOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (wsBroadcaster.broadcast as any).mockClear();

      // MediaBridge reports provider SIP connected (Vonage answered the INVITE)
      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: result.callId,
        event: 'provider_connected',
      };
      orchestrator.handleMediaEvent(event);

      expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({
            callId: result.callId,
            status: 'connected',
          }),
        }),
      );
    });

    it('should end call and notify on provider_disconnected (completed)', async () => {
      const { orchestrator, wsBroadcaster, mediaBridge, mockEndCall } = createFullOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (wsBroadcaster.broadcast as any).mockClear();
      (mediaBridge.destroySession as any).mockClear();

      // Provider sends BYE (call completed)
      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: result.callId,
        event: 'provider_disconnected',
        reason: 'bye',
      };
      orchestrator.handleMediaEvent(event);

      await vi.waitFor(() => {
        expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'call_event',
            data: expect.objectContaining({
              callId: result.callId,
              status: 'disconnected',
            }),
          }),
        );
      });

      // MediaBridge session destroyed (delayed 200ms for provider_disconnected)
      await vi.waitFor(() => {
        expect(mediaBridge.destroySession).toHaveBeenCalled();
      });
      // Provider endCall triggered
      expect(mockEndCall).toHaveBeenCalledWith('vonage-call-uuid-123');
    });

    it('should end call on client_disconnected (WebRTC failure)', async () => {
      const { orchestrator, wsBroadcaster, mediaBridge } = createFullOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (wsBroadcaster.broadcast as any).mockClear();

      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: result.callId,
        event: 'client_disconnected',
        reason: 'ice_failed',
      };
      orchestrator.handleMediaEvent(event);

      await vi.waitFor(() => {
        expect(wsBroadcaster.broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'call_event',
            data: expect.objectContaining({ status: 'disconnected' }),
          }),
        );
      });
    });

    it('should handle failed call when MediaBridge is unavailable', async () => {
      const { orchestrator, mediaBridge } = createFullOrchestrator();
      mediaBridge.createSession.mockRejectedValue(new MediaBridgeUnavailableError());

      await expect(
        orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543'),
      ).rejects.toThrow('Media service is unavailable');
    });
  });


  describe('Existing webhooks continue to function', () => {
    it('should handle answer webhook and return appropriate NCCO', () => {
      const { provider } = createMockVonageProvider();

      // Existing answer webhook behavior for outbound (no sipUri = legacy)
      const legacyOutbound = provider.generateAnswerNcco({
        from: '+46701234567',
        to: '+46709876543',
        direction: 'outbound',
      });
      expect(legacyOutbound[0]).toMatchObject({
        action: 'connect',
        endpoint: [{ type: 'phone', number: '+46709876543' }],
      });

      // Answer webhook with sipUri (new architecture)
      const sipOutbound = provider.generateAnswerNcco({
        from: '+46701234567',
        to: '+46709876543',
        direction: 'outbound',
        sipUri: 'sip:session-id@mediabridge:5060',
      });
      expect(sipOutbound[0]).toMatchObject({
        action: 'connect',
        endpoint: [{ type: 'sip', uri: 'sip:session-id@mediabridge:5060' }],
      });
    });

    it('should handle event webhook and emit call_state_changed events', () => {
      const { provider } = createMockVonageProvider();
      const events: TelephonyEvent[] = [];
      provider.onEvent((e) => events.push(e));

      // Simulate Vonage event webhook payloads for call lifecycle
      provider.processCallEvent({ uuid: 'call-1', status: 'ringing', direction: 'outbound' });
      provider.processCallEvent({ uuid: 'call-1', status: 'answered' });
      provider.processCallEvent({ uuid: 'call-1', status: 'completed', duration: '60' });

      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: 'call_state_changed', state: 'RINGING' });
      expect(events[1]).toMatchObject({ type: 'call_state_changed', state: 'ANSWERED' });
      expect(events[2]).toMatchObject({ type: 'call_state_changed', state: 'COMPLETED', durationSeconds: 60 });
    });

    it('should handle inbound-sms webhook and emit incoming_sms event', () => {
      const { provider } = createMockVonageProvider();
      const events: TelephonyEvent[] = [];
      provider.onEvent((e) => events.push(e));

      provider.processSmsEvent({
        message_uuid: 'msg-001',
        from: '+46709876543',
        to: '+46701234567',
        text: 'Hello from SMS',
        timestamp: '2024-06-15T12:00:00.000Z',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'incoming_sms',
        messageId: 'msg-001',
        from: '+46709876543',
        to: '+46701234567',
        body: 'Hello from SMS',
      });
    });

    it('should handle sms-status webhook and emit sms_status_update event', () => {
      const { provider } = createMockVonageProvider();
      const events: TelephonyEvent[] = [];
      provider.onEvent((e) => events.push(e));

      provider.processSmsStatusEvent({
        message_uuid: 'msg-002',
        status: 'delivered',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'sms_status_update',
        messageId: 'msg-002',
        status: 'DELIVERED',
      });
    });

    it('should list all webhook endpoints correctly', () => {
      const { provider } = createMockVonageProvider();
      const endpoints = provider.getWebhookEndpoints();

      expect(endpoints).toContain('answer');
      expect(endpoints).toContain('event');
      expect(endpoints).toContain('inbound-sms');
      expect(endpoints).toContain('sms-status');
    });
  });

  describe('SMS remains unaffected (no MediaBridge involvement)', () => {
    it('should not interact with MediaBridge when processing SMS events', () => {
      const { provider, mediaBridge } = createFullOrchestrator();
      const events: TelephonyEvent[] = [];
      provider.onEvent((e) => events.push(e));

      // Process inbound SMS
      provider.processSmsEvent({
        message_uuid: 'sms-in-001',
        from: '+46709876543',
        to: '+46701234567',
        text: 'Test SMS',
      });

      // Process SMS status update
      provider.processSmsStatusEvent({
        message_uuid: 'sms-out-001',
        status: 'delivered',
      });

      // MediaBridge should NOT be involved in any SMS flow
      expect(mediaBridge.createSession).not.toHaveBeenCalled();
      expect(mediaBridge.destroySession).not.toHaveBeenCalled();
      expect(mediaBridge.updateSession).not.toHaveBeenCalled();
      expect(mediaBridge.submitOffer).not.toHaveBeenCalled();

      // SMS events emitted correctly
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: 'incoming_sms' });
      expect(events[1]).toMatchObject({ type: 'sms_status_update' });
    });
  });

  describe('Call history recording works', () => {
    it('should record outbound call in history on initiation', async () => {
      const { orchestrator, callHistory } = createFullOrchestrator();

      await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      expect(callHistory.recordCall).toHaveBeenCalledWith(
        expect.objectContaining({
          phone_number: '+46709876543',
          provider_number: '+46701234567',
          call_type: 'OUTGOING',
          provider_call_id: 'vonage-call-uuid-123',
        }),
      );
    });

    it('should record inbound call in history on arrival', async () => {
      const { orchestrator, callHistory } = createFullOrchestrator();

      await orchestrator.handleInbound(
        'vonage-provider-1',
        'vonage-inbound-uuid',
        '+46709876543',
        '+46701234567',
      );

      expect(callHistory.recordCall).toHaveBeenCalledWith(
        expect.objectContaining({
          phone_number: '+46709876543',
          provider_number: '+46701234567',
          call_type: 'INCOMING',
          provider_call_id: 'vonage-inbound-uuid',
        }),
      );
    });

    it('should mark answered in history when call is answered', async () => {
      const { orchestrator, callHistory } = createFullOrchestrator();

      await orchestrator.handleInbound(
        'vonage-provider-1',
        'vonage-inbound-uuid',
        '+46709876543',
        '+46701234567',
      );
      const calls = orchestrator.getAllActiveCalls();
      const callId = calls[0].callId;

      await orchestrator.answerCall(callId, 'device-1');

      expect(callHistory.markAnswered).toHaveBeenCalledWith(
        'vonage-inbound-uuid',
        'device-1',
      );
    });

    it('should mark inbound unanswered call as MISSED when ended', async () => {
      const { orchestrator, callHistory } = createFullOrchestrator();

      await orchestrator.handleInbound(
        'vonage-provider-1',
        'vonage-inbound-uuid',
        '+46709876543',
        '+46701234567',
      );
      const calls = orchestrator.getAllActiveCalls();
      const callId = calls[0].callId;

      // End without answering
      await orchestrator.endCall(callId);

      expect(callHistory.updateCallTypeByProviderCallId).toHaveBeenCalledWith(
        'vonage-inbound-uuid',
        'MISSED',
      );
    });
  });

  describe('Push notifications still work', () => {
    it('should send push notifications on inbound call', async () => {
      const { orchestrator } = createFullOrchestrator();

      await orchestrator.handleInbound(
        'vonage-provider-1',
        'vonage-inbound-uuid',
        '+46709876543',
        '+46701234567',
      );

      // NotificationService handles WS broadcast + push delivery
      const notificationService = (orchestrator as any).notificationService;
      await vi.waitFor(() => {
        expect(notificationService.createNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'incoming_call',
            payload: expect.objectContaining({
              callerNumber: '+46709876543',
              providerNumber: '+46701234567',
            }),
          }),
        );
      });
    });

    it('should send missed call push notification when unanswered call ends', async () => {
      const { orchestrator, callHistory } = createFullOrchestrator();

      // Make updateCallTypeByProviderCallId return a valid entry to trigger push
      (callHistory.updateCallTypeByProviderCallId as any).mockResolvedValue({
        id: 'history-missed-1',
        phone_number: '+46709876543',
        provider_number: '+46701234567',
        call_type: 'MISSED',
      });

      await orchestrator.handleInbound(
        'vonage-provider-1',
        'vonage-inbound-uuid',
        '+46709876543',
        '+46701234567',
      );
      const calls = orchestrator.getAllActiveCalls();
      const callId = calls[0].callId;

      await orchestrator.endCall(callId);

      // NotificationService transitions the notification to missed_call
      const notificationService = (orchestrator as any).notificationService;
      await vi.waitFor(() => {
        expect(notificationService.transitionToMissed).toHaveBeenCalledWith(callId);
      });
    });
  });
});
