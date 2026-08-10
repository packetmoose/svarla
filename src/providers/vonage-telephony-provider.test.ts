import { describe, it, expect, beforeEach } from 'vitest';
import {
  VonageTelephonyProvider,
  mapVonageStatusToCallState,
  mapVonageSmsStatus,
} from './vonage-telephony-provider.js';
import type { VonageCallStatus } from './vonage-telephony-provider.js';
import type { TelephonyEvent } from './telephony-provider.js';

describe('VonageTelephonyProvider', () => {
  let provider: VonageTelephonyProvider;
  let emittedEvents: TelephonyEvent[];

  beforeEach(() => {
    provider = new VonageTelephonyProvider({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      applicationId: '00000000-0000-0000-0000-000000000000',
      privateKeyPath: '/tmp/test-key.pem',
      webhookBaseUrl: 'https://example.com',
    });

    emittedEvents = [];
    provider.onEvent((event) => {
      emittedEvents.push(event);
    });
  });

  describe('generateAnswerNcco', () => {
    it('should return inbound NCCO when no direction specified', () => {
      const ncco = provider.generateAnswerNcco({
        from: '+14155551234',
        to: '+14155550000',
      });

      expect(ncco).toEqual([
        {
          action: 'talk',
          text: ' ',
          bargeIn: false,
          loop: 0,
        },
      ]);
    });

    it('should return inbound NCCO for inbound direction', () => {
      const ncco = provider.generateAnswerNcco({
        from: '+14155551234',
        to: '+14155550000',
        direction: 'inbound',
      });

      expect(ncco).toEqual([
        {
          action: 'talk',
          text: ' ',
          bargeIn: false,
          loop: 0,
        },
      ]);
    });

    it('should return outbound NCCO for outbound direction', () => {
      const ncco = provider.generateAnswerNcco({
        from: '+14155550000',
        to: '+14155551234',
        direction: 'outbound',
      });

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'phone', number: '+14155551234' }],
          from: '+14155550000',
        },
      ]);
    });

    it('should return SIP connect NCCO when sipUri is provided for inbound call', () => {
      const ncco = provider.generateAnswerNcco({
        from: '+14155551234',
        to: '+14155550000',
        sipUri: 'sip://session-abc@mediabridge:5060',
      });

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'sip', uri: 'sip://session-abc@mediabridge:5060' }],
          from: '+14155551234',
        },
      ]);
    });

    it('should return SIP connect NCCO when sipUri is provided for outbound call', () => {
      const ncco = provider.generateAnswerNcco({
        from: '+14155550000',
        to: '+14155551234',
        direction: 'outbound',
        sipUri: 'sip://session-xyz@mediabridge:5060',
      });

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'sip', uri: 'sip://session-xyz@mediabridge:5060' }],
          from: '+14155550000',
        },
      ]);
    });

    it('should prioritize sipUri over direction when both are provided', () => {
      const ncco = provider.generateAnswerNcco({
        from: '+14155550000',
        to: '+14155551234',
        direction: 'outbound',
        sipUri: 'sip://test@host:5060',
      });

      // When sipUri is present, always connect to SIP regardless of direction
      expect(ncco).toHaveLength(1);
      expect(ncco[0]).toMatchObject({
        action: 'connect',
        endpoint: [{ type: 'sip', uri: 'sip://test@host:5060' }],
      });
    });
  });

  describe('processCallEvent', () => {
    it('should emit incoming_call for inbound started event', () => {
      provider.processCallEvent({
        uuid: 'call-123',
        status: 'started',
        from: '+14155551234',
        to: '+14155550000',
        direction: 'inbound',
        timestamp: '2024-01-15T10:30:00.000Z',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toEqual({
        type: 'incoming_call',
        callId: 'call-123',
        from: '+14155551234',
        to: '+14155550000',
        timestamp: new Date('2024-01-15T10:30:00.000Z').getTime(),
      });
    });

    it('should emit call_state_changed for outbound started event', () => {
      provider.processCallEvent({
        uuid: 'call-456',
        status: 'started',
        from: '+14155550000',
        to: '+14155551234',
        direction: 'outbound',
      });

      // Outbound started should emit call_state_changed, not incoming_call
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-456',
        state: 'RINGING',
      });
    });

    it('should emit call_state_changed with ANSWERED for answered status', () => {
      provider.processCallEvent({
        uuid: 'call-789',
        status: 'answered',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-789',
        state: 'ANSWERED',
        durationSeconds: null,
      });
    });

    it('should emit call_state_changed with COMPLETED and duration', () => {
      provider.processCallEvent({
        uuid: 'call-completed',
        status: 'completed',
        duration: '180',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-completed',
        state: 'COMPLETED',
        durationSeconds: 180,
      });
    });

    it('should emit call_state_changed with FAILED for various failure statuses', () => {
      const failureStatuses: VonageCallStatus[] = [
        'failed',
        'cancelled',
        'timeout',
        'unanswered',
      ];

      for (const status of failureStatuses) {
        emittedEvents = [];
        provider.processCallEvent({
          uuid: `call-${status}`,
          status,
        });

        expect(emittedEvents).toHaveLength(1);
        expect(emittedEvents[0]).toMatchObject({
          type: 'call_state_changed',
          callId: `call-${status}`,
          state: 'FAILED',
        });
      }
    });

    it('should emit call_state_changed with BUSY for busy and rejected statuses', () => {
      const busyStatuses: VonageCallStatus[] = [
        'busy',
        'rejected',
      ];

      for (const status of busyStatuses) {
        emittedEvents = [];
        provider.processCallEvent({
          uuid: `call-${status}`,
          status,
        });

        expect(emittedEvents).toHaveLength(1);
        expect(emittedEvents[0]).toMatchObject({
          type: 'call_state_changed',
          callId: `call-${status}`,
          state: 'BUSY',
        });
      }
    });

    it('should not emit events when uuid is missing', () => {
      provider.processCallEvent({
        status: 'answered',
      });

      expect(emittedEvents).toHaveLength(0);
    });

    it('should not emit events when status is missing', () => {
      provider.processCallEvent({
        uuid: 'call-no-status',
      });

      expect(emittedEvents).toHaveLength(0);
    });

    it('should use Date.now() when no timestamp provided', () => {
      const before = Date.now();
      provider.processCallEvent({
        uuid: 'call-no-ts',
        status: 'answered',
      });
      const after = Date.now();

      expect(emittedEvents).toHaveLength(1);
      const event = emittedEvents[0] as { timestamp: number };
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });

    it('should handle non-numeric duration as null', () => {
      provider.processCallEvent({
        uuid: 'call-bad-dur',
        status: 'completed',
        duration: 'invalid',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-bad-dur',
        state: 'COMPLETED',
        durationSeconds: null,
      });
    });
  });

  describe('makeCall', () => {
    it('should throw when provider not started', async () => {
      await expect(
        provider.makeCall('+14155550000', '+14155551234')
      ).rejects.toThrow('VonageTelephonyProvider not started');
    });
  });

  describe('endCall', () => {
    it('should throw when provider not started', async () => {
      await expect(provider.endCall('call-uuid')).rejects.toThrow(
        'VonageTelephonyProvider not started'
      );
    });
  });

  describe('answerCall', () => {
    it('should return success (no-op in new architecture)', async () => {
      const result = await provider.answerCall('call-uuid', 'device-1');

      expect(result.success).toBe(true);
      expect(result.clientToken).toBeNull();
      expect(result.errorReason).toBeNull();
    });
  });

  describe('mapVonageStatusToCallState', () => {
    it('should map started to RINGING', () => {
      expect(mapVonageStatusToCallState('started')).toBe('RINGING');
    });

    it('should map ringing to RINGING', () => {
      expect(mapVonageStatusToCallState('ringing')).toBe('RINGING');
    });

    it('should map answered to ANSWERED', () => {
      expect(mapVonageStatusToCallState('answered')).toBe('ANSWERED');
    });

    it('should map completed to COMPLETED', () => {
      expect(mapVonageStatusToCallState('completed')).toBe('COMPLETED');
    });

    it('should map failure statuses to FAILED', () => {
      expect(mapVonageStatusToCallState('failed')).toBe('FAILED');
      expect(mapVonageStatusToCallState('cancelled')).toBe('FAILED');
      expect(mapVonageStatusToCallState('timeout')).toBe('FAILED');
      expect(mapVonageStatusToCallState('unanswered')).toBe('FAILED');
    });

    it('should map busy and rejected statuses to BUSY', () => {
      expect(mapVonageStatusToCallState('busy')).toBe('BUSY');
      expect(mapVonageStatusToCallState('rejected')).toBe('BUSY');
    });

    it('should return null for unknown status', () => {
      expect(mapVonageStatusToCallState('unknown' as VonageCallStatus)).toBeNull();
    });
  });

  describe('mapVonageSmsStatus', () => {
    it('should map delivered to DELIVERED', () => {
      expect(mapVonageSmsStatus('delivered')).toBe('DELIVERED');
    });

    it('should map failed to FAILED', () => {
      expect(mapVonageSmsStatus('failed')).toBe('FAILED');
    });

    it('should map rejected to FAILED', () => {
      expect(mapVonageSmsStatus('rejected')).toBe('FAILED');
    });

    it('should map undeliverable to FAILED', () => {
      expect(mapVonageSmsStatus('undeliverable')).toBe('FAILED');
    });

    it('should return null for submitted (intermediate status)', () => {
      expect(mapVonageSmsStatus('submitted')).toBeNull();
    });

    it('should return null for unknown status', () => {
      expect(mapVonageSmsStatus('unknown')).toBeNull();
    });
  });

  describe('sendSms', () => {
    it('should throw when provider not started', async () => {
      await expect(
        provider.sendSms('+14155550000', '+14155551234', 'Hello')
      ).rejects.toThrow('VonageTelephonyProvider not started');
    });
  });

  describe('processSmsEvent', () => {
    it('should emit incoming_sms event for valid inbound SMS', () => {
      provider.processSmsEvent({
        message_uuid: 'msg-uuid-123',
        from: '+14155551234',
        to: '+14155550000',
        text: 'Hello there',
        timestamp: '2024-01-15T10:30:00.000Z',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toEqual({
        type: 'incoming_sms',
        messageId: 'msg-uuid-123',
        from: '+14155551234',
        to: '+14155550000',
        body: 'Hello there',
        timestamp: new Date('2024-01-15T10:30:00.000Z').getTime(),
      });
    });

    it('should use Date.now() when no timestamp provided', () => {
      const before = Date.now();
      provider.processSmsEvent({
        message_uuid: 'msg-uuid-456',
        from: '+14155551234',
        to: '+14155550000',
        text: 'No timestamp',
      });
      const after = Date.now();

      expect(emittedEvents).toHaveLength(1);
      const event = emittedEvents[0] as { timestamp: number };
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });

    it('should use empty string for body when text is undefined', () => {
      provider.processSmsEvent({
        message_uuid: 'msg-uuid-789',
        from: '+14155551234',
        to: '+14155550000',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'incoming_sms',
        body: '',
      });
    });

    it('should not emit events when message_uuid is missing', () => {
      provider.processSmsEvent({
        from: '+14155551234',
        to: '+14155550000',
        text: 'No UUID',
      });

      expect(emittedEvents).toHaveLength(0);
    });

    it('should not emit events when from is missing', () => {
      provider.processSmsEvent({
        message_uuid: 'msg-uuid-no-from',
        to: '+14155550000',
        text: 'No from',
      });

      expect(emittedEvents).toHaveLength(0);
    });

    it('should not emit events when to is missing', () => {
      provider.processSmsEvent({
        message_uuid: 'msg-uuid-no-to',
        from: '+14155551234',
        text: 'No to',
      });

      expect(emittedEvents).toHaveLength(0);
    });
  });

  describe('processSmsStatusEvent', () => {
    it('should emit sms_status_update with DELIVERED for delivered status', () => {
      provider.processSmsStatusEvent({
        message_uuid: 'msg-uuid-delivered',
        status: 'delivered',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toEqual({
        type: 'sms_status_update',
        messageId: 'msg-uuid-delivered',
        status: 'DELIVERED',
      });
    });

    it('should emit sms_status_update with FAILED for failed status', () => {
      provider.processSmsStatusEvent({
        message_uuid: 'msg-uuid-failed',
        status: 'failed',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toEqual({
        type: 'sms_status_update',
        messageId: 'msg-uuid-failed',
        status: 'FAILED',
      });
    });

    it('should emit sms_status_update with FAILED for rejected status', () => {
      provider.processSmsStatusEvent({
        message_uuid: 'msg-uuid-rejected',
        status: 'rejected',
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toEqual({
        type: 'sms_status_update',
        messageId: 'msg-uuid-rejected',
        status: 'FAILED',
      });
    });

    it('should not emit events for intermediate status (submitted)', () => {
      provider.processSmsStatusEvent({
        message_uuid: 'msg-uuid-submitted',
        status: 'submitted',
      });

      expect(emittedEvents).toHaveLength(0);
    });

    it('should not emit events when message_uuid is missing', () => {
      provider.processSmsStatusEvent({
        status: 'delivered',
      });

      expect(emittedEvents).toHaveLength(0);
    });

    it('should not emit events when status is missing', () => {
      provider.processSmsStatusEvent({
        message_uuid: 'msg-uuid-no-status',
      });

      expect(emittedEvents).toHaveLength(0);
    });
  });
});
