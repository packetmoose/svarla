import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CallOrchestrator,
  CallNotFoundError,
  CallOrchestratorError,
  type CallOrchestratorDeps,
} from './call-orchestrator.js';
import { MediaBridgeUnavailableError } from './media-bridge-client.js';
import type { MediaBridgeSessionEvent } from './media-bridge-event-listener.js';

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockMediaBridgeClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'test-session',
      status: 'CREATED',
      sipUri: 'sip:test-session@mediabridge:5060',
      audioWsUrl: 'ws://mediabridge:9091/audio/test-session',
    }),
    submitOffer: vi.fn().mockResolvedValue({
      sdpAnswer: 'v=0\r\no=- answer',
      iceCandidates: [{ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }],
    }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    destroySession: vi.fn().mockResolvedValue(undefined),
    getSessionStatus: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
    isCurrentlyHealthy: true,
  };
}

function createMockProvider(providerId = 'vonage-1') {
  return {
    providerId,
    makeCall: vi.fn().mockResolvedValue({ callId: 'provider-call-123', clientToken: null }),
    endCall: vi.fn().mockResolvedValue(undefined),
    answerCall: vi.fn().mockResolvedValue({ success: true, clientToken: null, errorReason: null }),
    sendSms: vi.fn(),
    listNumbers: vi.fn().mockResolvedValue([]),
    onEvent: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getWebhookEndpoints: vi.fn().mockReturnValue([]),
    handleWebhook: vi.fn(),
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
    isInboundBlocked: vi.fn(),
  };
}

function createMockProviderEntry(provider = createMockProvider()) {
  return {
    id: 'provider-entry-1',
    type: 'vonage',
    displayName: 'Vonage Provider',
    config: {},
    enabled: true,
    instance: provider,
    status: 'active' as const,
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
    getConnectionCount: vi.fn().mockReturnValue(0),
    isDeviceConnected: vi.fn().mockReturnValue(false),
    getConnectedDeviceIds: vi.fn().mockReturnValue([]),
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

function createMockNotificationService() {
  return {
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
  };
}

function createMockProviderRegistry(providerEntry = createMockProviderEntry()) {
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

function createOrchestrator(overrides?: Partial<CallOrchestratorDeps>) {
  const provider = createMockProvider();
  const providerEntry = createMockProviderEntry(provider);
  const deps: CallOrchestratorDeps = {
    mediaBridgeClient: createMockMediaBridgeClient() as any,
    providerRegistry: createMockProviderRegistry(providerEntry) as any,
    numberManagementService: createMockNumberManagement(providerEntry) as any,
    callHistoryService: createMockCallHistoryService() as any,
    wsBroadcaster: createMockWsBroadcaster() as any,
    deviceRegistryManager: createMockDeviceRegistry() as any,
    wakeSignalPublisher: createMockWakeSignalPublisher() as any,
    notificationService: createMockNotificationService() as any,
    logger: createMockLogger() as any,
    ...overrides,
  };
  return { orchestrator: new CallOrchestrator(deps), deps };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CallOrchestrator', () => {
  describe('initiateOutbound', () => {
    it('should create a MediaBridge session and initiate provider call', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      expect(result.callId).toBeDefined();
      expect(result.from).toBe('+46701234567');
      expect(result.to).toBe('+46709876543');

      // Should create session with pending leg and ringback
      expect(deps.mediaBridgeClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerLeg: { type: 'pending' },
          options: { ringback: true },
        }),
      );

      // Should call provider.makeCall
      const provider = (deps.numberManagementService as any).requireProviderForNumber.mock.results[0]?.value;
      expect(provider).toBeDefined();
    });

    it('should patch session with SIP URI after provider call', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      expect(deps.mediaBridgeClient.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          providerLeg: { type: 'sip', uri: 'sip:test-session@mediabridge:5060' },
        }),
      );
    });

    it('should record outbound call in history', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      expect(deps.callHistoryService.recordCall).toHaveBeenCalledWith(
        expect.objectContaining({
          phone_number: '+46709876543',
          provider_number: '+46701234567',
          call_type: 'OUTGOING',
          provider_call_id: 'provider-call-123',
        }),
      );
    });

    it('should throw when MediaBridge is unavailable', async () => {
      const mediaBridge = createMockMediaBridgeClient();
      mediaBridge.createSession.mockRejectedValue(new MediaBridgeUnavailableError());
      const { orchestrator } = createOrchestrator({ mediaBridgeClient: mediaBridge as any });

      await expect(
        orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543'),
      ).rejects.toThrow(CallOrchestratorError);
    });
  });

  describe('handleInbound', () => {
    it('should create a MediaBridge session with pending provider leg', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');

      expect(result.sipUri).toBe('sip:test-session@mediabridge:5060');
      expect(result.callId).toBeDefined();

      expect(deps.mediaBridgeClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerLeg: { type: 'pending' },
          options: { ringback: true },
        }),
      );
    });

    it('should create incoming call notification via NotificationService', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');

      expect(deps.notificationService.createNotification).toHaveBeenCalledWith(
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

    it('should not directly send push notifications (NotificationService handles delivery)', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');

      // Wake signal is now handled by NotificationService, not called directly
      expect(deps.wakeSignalPublisher.sendToAllDevices).not.toHaveBeenCalled();
    });

    it('should record inbound call in history', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');

      expect(deps.callHistoryService.recordCall).toHaveBeenCalledWith(
        expect.objectContaining({
          phone_number: '+46709876543',
          provider_number: '+46701234567',
          call_type: 'INCOMING',
          provider_call_id: 'prov-call-1',
        }),
      );
    });

    it('should throw when provider is not available', async () => {
      const registry = createMockProviderRegistry();
      registry.getProvider.mockReturnValue(null);
      const { orchestrator } = createOrchestrator({ providerRegistry: registry as any });

      await expect(
        orchestrator.handleInbound('unknown-provider', 'prov-call-1', '+46709876543', '+46701234567'),
      ).rejects.toThrow('not available');
    });
  });

  describe('answerCall', () => {
    it('should mark call as answered and notify other devices', async () => {
      const { orchestrator, deps } = createOrchestrator();

      // First create an inbound call
      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      // Clear mocks from handleInbound
      (deps.wsBroadcaster.broadcastExcept as any).mockClear();

      const result = await orchestrator.answerCall(callId, 'device-2');

      expect(result.success).toBe(true);
      expect(deps.wsBroadcaster.broadcastExcept).toHaveBeenCalledWith(
        'device-2',
        expect.objectContaining({
          type: 'call_cancelled',
          data: { callId, reason: 'answered_elsewhere' },
        }),
      );
    });

    it('should mark call as answered in call history', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      await orchestrator.answerCall(callId, 'device-2');

      expect(deps.callHistoryService.markAnswered).toHaveBeenCalledWith(
        'prov-call-1',
        'device-2',
      );
    });

    it('should reject if call is already answered', async () => {
      const { orchestrator } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      // First answer succeeds
      const first = await orchestrator.answerCall(callId, 'device-1');
      expect(first.success).toBe(true);

      // Second answer fails
      const second = await orchestrator.answerCall(callId, 'device-2');
      expect(second.success).toBe(false);
      expect(second.errorReason).toContain('already answered');
    });

    it('should return failure for non-existent call', async () => {
      const { orchestrator } = createOrchestrator();

      const result = await orchestrator.answerCall('non-existent-call', 'device-1');

      expect(result.success).toBe(false);
      expect(result.errorReason).toContain('not found');
    });

    it('should mark call notification as resolved via NotificationService', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      await orchestrator.answerCall(callId, 'device-2');

      expect(deps.notificationService.markCallResolved).toHaveBeenCalledWith(callId);
    });
  });

  describe('handleWebRtcOffer', () => {
    it('should submit SDP offer to MediaBridge and return answer', async () => {
      const { orchestrator, deps } = createOrchestrator();

      // Create an outbound call first
      const outboundResult = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.mediaBridgeClient.submitOffer as any).mockClear();

      const result = await orchestrator.handleWebRtcOffer(
        outboundResult.callId,
        'device-1',
        'v=0\r\no=- offer',
      );

      expect(result.sdpAnswer).toBe('v=0\r\no=- answer');
      expect(result.iceCandidates).toHaveLength(1);
      expect(deps.mediaBridgeClient.submitOffer).toHaveBeenCalledWith(
        expect.any(String),
        'v=0\r\no=- offer',
      );
    });

    it('should throw CallNotFoundError for unknown callId', async () => {
      const { orchestrator } = createOrchestrator();

      await expect(
        orchestrator.handleWebRtcOffer('unknown-call', 'device-1', 'v=0\r\no=- offer'),
      ).rejects.toThrow(CallNotFoundError);
    });

    it('should throw CallOrchestratorError when MediaBridge is unavailable', async () => {
      const mediaBridge = createMockMediaBridgeClient();
      mediaBridge.submitOffer.mockRejectedValue(new MediaBridgeUnavailableError());
      const { orchestrator } = createOrchestrator({ mediaBridgeClient: mediaBridge as any });

      // Create an outbound call first (with working createSession)
      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      await expect(
        orchestrator.handleWebRtcOffer(result.callId, 'device-1', 'v=0\r\no=- offer'),
      ).rejects.toThrow(CallOrchestratorError);
    });
  });

  describe('endCall', () => {
    it('should destroy MediaBridge session', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.mediaBridgeClient.destroySession as any).mockClear();

      await orchestrator.endCall(result.callId);

      expect(deps.mediaBridgeClient.destroySession).toHaveBeenCalled();
    });

    it('should end call via provider', async () => {
      const provider = createMockProvider();
      const providerEntry = createMockProviderEntry(provider);
      const numberManagement = createMockNumberManagement(providerEntry);
      const { orchestrator } = createOrchestrator({
        numberManagementService: numberManagement as any,
      });

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      provider.endCall.mockClear();

      await orchestrator.endCall(result.callId);

      expect(provider.endCall).toHaveBeenCalledWith('provider-call-123');
    });

    it('should notify clients via WebSocket', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.wsBroadcaster.broadcast as any).mockClear();

      await orchestrator.endCall(result.callId);

      expect(deps.wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({
            callId: result.callId,
            status: 'disconnected',
          }),
        }),
      );
    });

    it('should mark inbound unanswered call as MISSED', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      await orchestrator.endCall(callId);

      expect(deps.callHistoryService.updateCallTypeByProviderCallId).toHaveBeenCalledWith(
        'prov-call-1',
        'MISSED',
      );
    });

    it('should transition notification to missed when caller hangs up (inbound, not answered)', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      await orchestrator.endCall(callId);

      expect(deps.notificationService.transitionToMissed).toHaveBeenCalledWith(callId);
      expect(deps.notificationService.markCallResolved).not.toHaveBeenCalled();
    });

    it('should mark notification as resolved when call is declined', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      // Clear the mock from handleInbound to isolate endCall behavior
      (deps.notificationService.markCallResolved as any).mockClear();

      await orchestrator.endCall(callId, 'declined');

      expect(deps.notificationService.markCallResolved).toHaveBeenCalledWith(callId);
      expect(deps.notificationService.transitionToMissed).not.toHaveBeenCalled();
    });

    it('should not send wake signals directly for missed calls (NotificationService handles delivery)', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.handleInbound('provider-entry-1', 'prov-call-1', '+46709876543', '+46701234567');
      const activeCalls = orchestrator.getAllActiveCalls();
      const callId = activeCalls[0].callId;

      // Clear mocks from handleInbound
      (deps.wakeSignalPublisher.sendToAllDevices as any).mockClear();

      await orchestrator.endCall(callId);

      expect(deps.wakeSignalPublisher.sendToAllDevices).not.toHaveBeenCalled();
    });

    it('should not end the same call twice', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.mediaBridgeClient.destroySession as any).mockClear();

      await orchestrator.endCall(result.callId);
      await orchestrator.endCall(result.callId); // second call should no-op

      expect(deps.mediaBridgeClient.destroySession).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op for unknown callId', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.endCall('non-existent-call');

      expect(deps.mediaBridgeClient.destroySession).not.toHaveBeenCalled();
    });
  });

  describe('handleMediaEvent', () => {
    it('should end call on provider_disconnected', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.wsBroadcaster.broadcast as any).mockClear();

      // Get the sessionId (same as callId in our implementation)
      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: result.callId,
        event: 'provider_disconnected',
        reason: 'bye',
      };

      orchestrator.handleMediaEvent(event);

      // Give async endCall time to complete
      await vi.waitFor(() => {
        expect(deps.wsBroadcaster.broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'call_event',
            data: expect.objectContaining({ status: 'disconnected' }),
          }),
        );
      });
    });

    it('should end call on client_disconnected', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.wsBroadcaster.broadcast as any).mockClear();

      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: result.callId,
        event: 'client_disconnected',
        reason: 'ice_failed',
      };

      orchestrator.handleMediaEvent(event);

      await vi.waitFor(() => {
        expect(deps.wsBroadcaster.broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'call_event',
            data: expect.objectContaining({ status: 'disconnected' }),
          }),
        );
      });
    });

    it('should broadcast connected status on provider_connected', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.wsBroadcaster.broadcast as any).mockClear();

      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: result.callId,
        event: 'provider_connected',
      };

      orchestrator.handleMediaEvent(event);

      expect(deps.wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({
            callId: result.callId,
            status: 'connected',
          }),
        }),
      );
    });

    it('should broadcast DTMF digit on dtmf event', async () => {
      const { orchestrator, deps } = createOrchestrator();

      const result = await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      (deps.wsBroadcaster.broadcast as any).mockClear();

      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: result.callId,
        event: 'dtmf',
        digit: '5',
      };

      orchestrator.handleMediaEvent(event);

      expect(deps.wsBroadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'call_event',
          data: expect.objectContaining({
            callId: result.callId,
            status: 'dtmf',
            digit: '5',
          }),
        }),
      );
    });

    it('should ignore events for unknown sessions', () => {
      const { orchestrator, deps } = createOrchestrator();

      const event: MediaBridgeSessionEvent = {
        type: 'session_event',
        sessionId: 'unknown-session',
        event: 'provider_disconnected',
      };

      orchestrator.handleMediaEvent(event);

      expect(deps.mediaBridgeClient.destroySession).not.toHaveBeenCalled();
    });
  });

  describe('utility methods', () => {
    it('getCallIdByProviderCallId should return internal callId', async () => {
      const { orchestrator } = createOrchestrator();

      await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      const internalId = orchestrator.getCallIdByProviderCallId('provider-call-123');
      expect(internalId).toBeDefined();
    });

    it('getAllActiveCalls should return all active calls', async () => {
      const { orchestrator } = createOrchestrator();

      await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      await orchestrator.handleInbound('provider-entry-1', 'prov-call-2', '+46700000000', '+46701234567');

      const calls = orchestrator.getAllActiveCalls();
      expect(calls).toHaveLength(2);
    });

    it('endAllCalls should end all tracked calls', async () => {
      const { orchestrator, deps } = createOrchestrator();

      await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');
      await orchestrator.handleInbound('provider-entry-1', 'prov-call-2', '+46700000000', '+46701234567');

      await orchestrator.endAllCalls('MediaBridge failure');

      const calls = orchestrator.getAllActiveCalls();
      expect(calls).toHaveLength(0);
      expect(deps.mediaBridgeClient.destroySession).toHaveBeenCalledTimes(2);
    });

    it('dispose should clear all tracking state', async () => {
      const { orchestrator } = createOrchestrator();

      await orchestrator.initiateOutbound('device-1', '+46701234567', '+46709876543');

      orchestrator.dispose();

      const calls = orchestrator.getAllActiveCalls();
      expect(calls).toHaveLength(0);
    });
  });
});
