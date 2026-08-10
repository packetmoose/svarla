import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CallRouter, type CallRouterEvent, type CallRouterDeps } from './call-router.js';
import type { TelephonyProvider, CallAnswerResult } from '../providers/telephony-provider.js';
import type { DeviceInfo } from './device-registry-manager.js';

function createMockProvider(overrides?: Partial<TelephonyProvider>): TelephonyProvider {
  return {
    providerId: 'mock',
    makeCall: vi.fn().mockResolvedValue({ callId: 'call-1', clientToken: null }),
    endCall: vi.fn().mockResolvedValue(undefined),
    answerCall: vi.fn().mockResolvedValue({
      success: true,
      clientToken: 'token-abc',
      errorReason: null,
    } satisfies CallAnswerResult),
    sendSms: vi.fn().mockResolvedValue({ messageId: 'msg-1', success: true, errorReason: null }),
    listNumbers: vi.fn().mockResolvedValue([]),
    onEvent: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getWebhookEndpoints: vi.fn().mockReturnValue([]),
    handleWebhook: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function createMockDevices(count: number): DeviceInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    deviceId: `device-${i + 1}`,
    deviceName: `Device ${i + 1}`,
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    isActive: true,
  }));
}

describe('CallRouter', () => {
  let provider: TelephonyProvider;
  let broadcastEvents: CallRouterEvent[];
  let broadcast: (event: CallRouterEvent) => void;
  let missedCalls: Array<{ callId: string; from: string; to: string }>;
  let declinedCalls: Array<{ callId: string; from: string; to: string }>;
  let onMissedCall: (callId: string, from: string, to: string) => void;
  let onDeclinedCall: (callId: string, from: string, to: string) => void;
  let devices: DeviceInfo[];
  let router: CallRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = createMockProvider();
    broadcastEvents = [];
    broadcast = (event) => broadcastEvents.push(event);
    missedCalls = [];
    declinedCalls = [];
    onMissedCall = (callId, from, to) => missedCalls.push({ callId, from, to });
    onDeclinedCall = (callId, from, to) => declinedCalls.push({ callId, from, to });
    devices = createMockDevices(3);

    const deps: CallRouterDeps = {
      provider,
      getActiveDevices: async () => devices,
      broadcast,
      onMissedCall,
      onDeclinedCall,
    };

    router = new CallRouter(deps);
  });

  afterEach(() => {
    router.dispose();
    vi.useRealTimers();
  });

  describe('handleIncomingCall', () => {
    it('should broadcast incoming call event to all devices', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      expect(broadcastEvents).toHaveLength(1);
      expect(broadcastEvents[0]).toEqual({
        type: 'incoming_call',
        callId: 'call-1',
        from: '+15551234567',
        providerNumber: '+15559876543',
      });
    });

    it('should ignore duplicate incoming calls with the same callId', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      expect(broadcastEvents).toHaveLength(1);
    });

    it('should track the call as pending', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      expect(router.isPendingCall('call-1')).toBe(true);
    });

    it('should handle multiple different incoming calls', async () => {
      await router.handleIncomingCall('call-1', '+15551111111', '+15559876543');
      await router.handleIncomingCall('call-2', '+15552222222', '+15559876544');

      expect(broadcastEvents).toHaveLength(2);
      expect(router.isPendingCall('call-1')).toBe(true);
      expect(router.isPendingCall('call-2')).toBe(true);
    });
  });

  describe('answerCall', () => {
    it('should answer call successfully on first device', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      const result = await router.answerCall('call-1', 'device-1');

      expect(result.success).toBe(true);
      expect(result.clientToken).toBe('token-abc');
      expect(provider.answerCall).toHaveBeenCalledWith('call-1', 'device-1');
    });

    it('should reject answer for non-existent call', async () => {
      const result = await router.answerCall('nonexistent', 'device-1');

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe('Call not found or already ended');
    });

    it('should broadcast call_answered and call_cancelled events', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      broadcastEvents = []; // Clear the incoming_call event

      await router.answerCall('call-1', 'device-1');

      expect(broadcastEvents).toEqual([
        {
          type: 'call_answered',
          callId: 'call-1',
          deviceId: 'device-1',
          providerNumber: '+15559876543',
        },
        {
          type: 'call_cancelled',
          callId: 'call-1',
          reason: 'answered_elsewhere',
        },
        {
          type: 'active_call_started',
          providerNumber: '+15559876543',
          info: expect.objectContaining({
            callId: 'call-1',
            deviceId: 'device-1',
            remoteParty: '+15551234567',
            providerNumber: '+15559876543',
          }),
        },
      ]);
    });

    it('should track active call after answering', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      const activeCall = router.getActiveCallForNumber('+15559876543');
      expect(activeCall).not.toBeNull();
      expect(activeCall!.callId).toBe('call-1');
      expect(activeCall!.deviceId).toBe('device-1');
      expect(activeCall!.remoteParty).toBe('+15551234567');
      expect(activeCall!.providerNumber).toBe('+15559876543');
    });

    it('should remove pending call after answering', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      expect(router.isPendingCall('call-1')).toBe(false);
    });

    it('should clear the timeout after answering', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      // Advance time past timeout — nothing should happen
      vi.advanceTimersByTime(35_000);

      // No missed call recorded
      expect(missedCalls).toHaveLength(0);
    });
  });

  describe('race condition: first-answer-wins', () => {
    it('should reject second answer attempt for the same call', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      const result1 = await router.answerCall('call-1', 'device-1');
      const result2 = await router.answerCall('call-1', 'device-2');

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(false);
      // After successful answer, the pending call is removed from the map
      expect(result2.errorReason).toBe('Call not found or already ended');
    });

    it('should only call provider.answerCall once for simultaneous answers', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      await router.answerCall('call-1', 'device-1');
      await router.answerCall('call-1', 'device-2');
      await router.answerCall('call-1', 'device-3');

      expect(provider.answerCall).toHaveBeenCalledTimes(1);
      expect(provider.answerCall).toHaveBeenCalledWith('call-1', 'device-1');
    });

    it('should handle true concurrent answer attempts via resolved flag', async () => {
      // Simulate a slow provider where the first answerCall takes time
      let resolveFirst: (value: CallAnswerResult) => void;
      const slowProvider = createMockProvider({
        answerCall: vi.fn().mockImplementationOnce(
          () => new Promise<CallAnswerResult>((resolve) => { resolveFirst = resolve; })
        ).mockResolvedValue({
          success: true,
          clientToken: 'token-2',
          errorReason: null,
        }),
      });

      const concurrentRouter = new CallRouter({
        provider: slowProvider,
        getActiveDevices: async () => devices,
        broadcast,
        onMissedCall,
      });

      await concurrentRouter.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      // First device starts answering (slow)
      const promise1 = concurrentRouter.answerCall('call-1', 'device-1');

      // Second device tries while first is still pending — resolved flag is already set
      const result2 = await concurrentRouter.answerCall('call-1', 'device-2');
      expect(result2.success).toBe(false);
      expect(result2.errorReason).toBe('Call already answered by another device');

      // Now first device completes
      resolveFirst!({ success: true, clientToken: 'token-1', errorReason: null });
      const result1 = await promise1;
      expect(result1.success).toBe(true);

      // Provider was only called once (for device-1)
      expect(slowProvider.answerCall).toHaveBeenCalledTimes(1);

      concurrentRouter.dispose();
    });

    it('should allow retry if provider.answerCall fails', async () => {
      const mockProvider = createMockProvider({
        answerCall: vi.fn()
          .mockResolvedValueOnce({
            success: false,
            clientToken: null,
            errorReason: 'Provider error',
          })
          .mockResolvedValueOnce({
            success: true,
            clientToken: 'token-xyz',
            errorReason: null,
          }),
      });

      const deps: CallRouterDeps = {
        provider: mockProvider,
        getActiveDevices: async () => devices,
        broadcast,
        onMissedCall,
      };
      const retryRouter = new CallRouter(deps);

      await retryRouter.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      // First answer attempt fails at provider level
      const result1 = await retryRouter.answerCall('call-1', 'device-1');
      expect(result1.success).toBe(false);

      // Second device can try since first one failed
      const result2 = await retryRouter.answerCall('call-1', 'device-2');
      expect(result2.success).toBe(true);

      retryRouter.dispose();
    });
  });

  describe('declineCall', () => {
    it('should end the call via provider', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.declineCall('call-1');

      expect(provider.endCall).toHaveBeenCalledWith('call-1');
    });

    it('should broadcast stop_ringing and call_cancelled events', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      broadcastEvents = [];

      await router.declineCall('call-1');

      expect(broadcastEvents).toEqual([
        { type: 'stop_ringing', callId: 'call-1' },
        { type: 'call_cancelled', callId: 'call-1', reason: 'declined' },
      ]);
    });

    it('should record as declined call', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.declineCall('call-1');

      expect(declinedCalls).toEqual([
        { callId: 'call-1', from: '+15551234567', to: '+15559876543' },
      ]);
      expect(missedCalls).toEqual([]);
    });

    it('should clear the timeout after declining', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.declineCall('call-1');

      declinedCalls = [];
      vi.advanceTimersByTime(35_000);

      // No additional missed call recorded from timeout
      expect(missedCalls).toHaveLength(0);
    });

    it('should be a no-op for already resolved calls', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      broadcastEvents = [];
      await router.declineCall('call-1');

      // No additional events since call was already answered
      expect(broadcastEvents).toHaveLength(0);
      expect(provider.endCall).not.toHaveBeenCalled();
    });

    it('should be a no-op for non-existent calls', async () => {
      await router.declineCall('nonexistent');
      expect(provider.endCall).not.toHaveBeenCalled();
    });
  });

  describe('30-second timeout', () => {
    it('should end call and record as missed after 30 seconds', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      vi.advanceTimersByTime(30_000);

      expect(provider.endCall).toHaveBeenCalledWith('call-1');
      expect(missedCalls).toEqual([
        { callId: 'call-1', from: '+15551234567', to: '+15559876543' },
      ]);
    });

    it('should broadcast stop_ringing and call_cancelled with timeout reason', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      broadcastEvents = [];

      vi.advanceTimersByTime(30_000);

      expect(broadcastEvents).toEqual([
        { type: 'stop_ringing', callId: 'call-1' },
        { type: 'call_cancelled', callId: 'call-1', reason: 'timeout' },
      ]);
    });

    it('should not trigger timeout if answered before 30 seconds', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      vi.advanceTimersByTime(15_000); // Half the timeout
      await router.answerCall('call-1', 'device-1');
      vi.advanceTimersByTime(20_000); // Past the original timeout

      expect(missedCalls).toHaveLength(0);
    });

    it('should not trigger timeout if declined before 30 seconds', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      await router.declineCall('call-1');
      declinedCalls = []; // Clear the declined call from decline
      missedCalls = [];
      vi.advanceTimersByTime(35_000);

      // No additional missed call from timeout
      expect(missedCalls).toHaveLength(0);
      expect(declinedCalls).toHaveLength(0);
    });

    it('should remove pending call after timeout', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      vi.advanceTimersByTime(30_000);

      expect(router.isPendingCall('call-1')).toBe(false);
    });
  });

  describe('handleCallerDisconnect', () => {
    it('should stop ringing on all devices', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      broadcastEvents = [];

      router.handleCallerDisconnect('call-1');

      expect(broadcastEvents).toEqual([
        { type: 'stop_ringing', callId: 'call-1' },
        { type: 'call_cancelled', callId: 'call-1', reason: 'caller_disconnected' },
      ]);
    });

    it('should record as missed call', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      router.handleCallerDisconnect('call-1');

      expect(missedCalls).toEqual([
        { callId: 'call-1', from: '+15551234567', to: '+15559876543' },
      ]);
    });

    it('should clear the timeout', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      router.handleCallerDisconnect('call-1');

      missedCalls = [];
      vi.advanceTimersByTime(35_000);

      expect(missedCalls).toHaveLength(0);
    });

    it('should be a no-op for already resolved calls', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      broadcastEvents = [];
      router.handleCallerDisconnect('call-1');

      expect(broadcastEvents).toHaveLength(0);
    });

    it('should be a no-op for non-existent calls', async () => {
      router.handleCallerDisconnect('nonexistent');
      expect(broadcastEvents).toHaveLength(0);
    });
  });

  describe('handleCallEnded', () => {
    it('should treat ended pending call as caller disconnect', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      broadcastEvents = [];

      router.handleCallEnded('call-1');

      expect(broadcastEvents).toContainEqual({
        type: 'call_cancelled',
        callId: 'call-1',
        reason: 'caller_disconnected',
      });
      expect(missedCalls).toHaveLength(1);
    });

    it('should remove active call and broadcast end event', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');
      broadcastEvents = [];

      router.handleCallEnded('call-1');

      expect(router.getActiveCallForNumber('+15559876543')).toBeNull();
      expect(broadcastEvents).toEqual([
        { type: 'active_call_ended', providerNumber: '+15559876543' },
      ]);
    });

    it('should be a no-op for unknown call IDs', async () => {
      router.handleCallEnded('unknown');
      expect(broadcastEvents).toHaveLength(0);
    });
  });

  describe('getActiveCallForNumber', () => {
    it('should return null when no active call on number', () => {
      expect(router.getActiveCallForNumber('+15559876543')).toBeNull();
    });

    it('should return active call info after call is answered', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      const info = router.getActiveCallForNumber('+15559876543');
      expect(info).not.toBeNull();
      expect(info!.callId).toBe('call-1');
      expect(info!.deviceId).toBe('device-1');
      expect(info!.remoteParty).toBe('+15551234567');
    });

    it('should return null after active call ends', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');
      router.handleCallEnded('call-1');

      expect(router.getActiveCallForNumber('+15559876543')).toBeNull();
    });
  });

  describe('getAllActiveCalls', () => {
    it('should return empty map initially', () => {
      const calls = router.getAllActiveCalls();
      expect(calls.size).toBe(0);
    });

    it('should return all active calls', async () => {
      await router.handleIncomingCall('call-1', '+15551111111', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      await router.handleIncomingCall('call-2', '+15552222222', '+15559876544');
      await router.answerCall('call-2', 'device-2');

      const calls = router.getAllActiveCalls();
      expect(calls.size).toBe(2);
      expect(calls.has('+15559876543')).toBe(true);
      expect(calls.has('+15559876544')).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should clear all pending calls and timers', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.handleIncomingCall('call-2', '+15552222222', '+15559876544');

      router.dispose();

      expect(router.isPendingCall('call-1')).toBe(false);
      expect(router.isPendingCall('call-2')).toBe(false);

      // Advancing time should not trigger any timeouts
      vi.advanceTimersByTime(35_000);
      expect(missedCalls).toHaveLength(0);
    });

    it('should clear active calls', async () => {
      await router.handleIncomingCall('call-1', '+15551234567', '+15559876543');
      await router.answerCall('call-1', 'device-1');

      router.dispose();

      expect(router.getActiveCallForNumber('+15559876543')).toBeNull();
    });
  });

  describe('custom timeout', () => {
    it('should respect custom ring timeout', async () => {
      const customRouter = new CallRouter(
        {
          provider,
          getActiveDevices: async () => devices,
          broadcast,
          onMissedCall,
        },
        10_000 // 10 seconds instead of 30
      );

      await customRouter.handleIncomingCall('call-1', '+15551234567', '+15559876543');

      vi.advanceTimersByTime(10_000);

      expect(provider.endCall).toHaveBeenCalledWith('call-1');
      expect(missedCalls).toHaveLength(1);

      customRouter.dispose();
    });
  });
});
