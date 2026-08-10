import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  Elks46TelephonyProvider,
  mapElks46StatusToCallState,
} from './elks46-telephony-provider.js';
import type { Elks46ProviderConfig } from './elks46-telephony-provider.js';
import type { TelephonyEvent } from './telephony-provider.js';

describe('Elks46TelephonyProvider', () => {
  let provider: Elks46TelephonyProvider;
  let emittedEvents: TelephonyEvent[];
  const config: Elks46ProviderConfig = {
    apiUsername: 'test-user',
    apiPassword: 'test-pass',
    webhookBaseUrl: 'https://example.com',
  };

  beforeEach(() => {
    provider = new Elks46TelephonyProvider(config);
    emittedEvents = [];
    provider.onEvent((event) => {
      emittedEvents.push(event);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('interface compliance', () => {
    it('should implement TelephonyProvider interface', () => {
      expect(provider.providerId).toBe('46elks');
      expect(provider.makeCall).toBeTypeOf('function');
      expect(provider.endCall).toBeTypeOf('function');
      expect(provider.answerCall).toBeTypeOf('function');
      expect(provider.sendSms).toBeTypeOf('function');
      expect(provider.listNumbers).toBeTypeOf('function');
      expect(provider.onEvent).toBeTypeOf('function');
      expect(provider.start).toBeTypeOf('function');
      expect(provider.stop).toBeTypeOf('function');
      expect(provider.getWebhookEndpoints).toBeTypeOf('function');
      expect(provider.handleWebhook).toBeTypeOf('function');
    });

    it('should return correct webhook endpoints', () => {
      expect(provider.getWebhookEndpoints()).toEqual([
        'voice_start',
        'voice_event',
        'sms_incoming',
      ]);
    });
  });

  describe('makeCall', () => {
    it('should POST to 46elks calls API with correct parameters', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'call-123' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await provider.makeCall('+46701234567', '+46709876543');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.46elks.com/a1/calls',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Basic ${btoa('test-user:test-pass')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        }),
      );

      // Verify form body
      const callBody = mockFetch.mock.calls[0][1].body;
      const params = new URLSearchParams(callBody);
      expect(params.get('from')).toBe('+46701234567');
      expect(params.get('to')).toBe('+46709876543');
      expect(params.get('voice_start')).toBe('https://example.com/webhooks/46elks/voice_start');

      expect(result).toEqual({
        callId: 'call-123',
        clientToken: null,
      });
    });

    it('should throw on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }));

      await expect(provider.makeCall('+46701234567', '+46709876543'))
        .rejects.toThrow('46elks makeCall failed: 401 Unauthorized');
    });
  });

  describe('endCall', () => {
    it('should DELETE the call endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await provider.endCall('call-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.46elks.com/a1/calls/call-123',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            'Authorization': `Basic ${btoa('test-user:test-pass')}`,
          }),
        }),
      );
    });

    it('should not throw on 404 (call already ended)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Call not found',
      }));

      await expect(provider.endCall('call-123')).resolves.toBeUndefined();
    });

    it('should throw on other API errors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }));

      await expect(provider.endCall('call-123'))
        .rejects.toThrow('Hangup failed: 500');
    });
  });

  describe('answerCall', () => {
    it('should return success (answering is handled via webhook)', async () => {
      const result = await provider.answerCall('call-123', 'device-1');

      expect(result).toEqual({
        success: true,
        clientToken: null,
        errorReason: null,
      });
    });
  });

  describe('sendSms', () => {
    it('should POST to 46elks SMS API with correct parameters', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'sms-456' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await provider.sendSms('+46701234567', '+46709876543', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.46elks.com/a1/sms',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Basic ${btoa('test-user:test-pass')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        }),
      );

      const callBody = mockFetch.mock.calls[0][1].body;
      const params = new URLSearchParams(callBody);
      expect(params.get('from')).toBe('+46701234567');
      expect(params.get('to')).toBe('+46709876543');
      expect(params.get('message')).toBe('Hello!');

      expect(result).toEqual({
        messageId: 'sms-456',
        success: true,
        errorReason: null,
      });
    });

    it('should return failure on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid number',
      }));

      const result = await provider.sendSms('+46701234567', 'invalid', 'Hi');

      expect(result.success).toBe(false);
      expect(result.errorReason).toContain('46elks SMS failed');
    });

    it('should handle network errors gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const result = await provider.sendSms('+46701234567', '+46709876543', 'Hi');

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe('Network error');
    });
  });

  describe('listNumbers', () => {
    it('should fetch and map numbers from 46elks API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { number: '+46701234567', active: 'yes', capabilities: ['voice', 'sms'] },
            { number: '+46709876543', active: 'yes', capabilities: ['sms'] },
            { number: '+46700000000', active: 'no', capabilities: ['voice'] },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const numbers = await provider.listNumbers();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.46elks.com/a1/numbers',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': `Basic ${btoa('test-user:test-pass')}`,
          }),
        }),
      );

      expect(numbers).toHaveLength(2); // only active numbers
      expect(numbers[0]).toEqual({
        number: '+46701234567',
        capabilities: new Set(['VOICE', 'SMS']),
      });
      expect(numbers[1]).toEqual({
        number: '+46709876543',
        capabilities: new Set(['SMS']),
      });
    });

    it('should return empty array on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      }));

      const numbers = await provider.listNumbers();
      expect(numbers).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const numbers = await provider.listNumbers();
      expect(numbers).toEqual([]);
    });
  });

  describe('handleWebhook - voice_start', () => {
    it('should emit incoming_call event for inbound calls', async () => {
      const result = await provider.handleWebhook('voice_start', {
        callid: 'call-789',
        from: '+46701234567',
        to: '+46709876543',
        direction: 'incoming',
      }, {});

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'incoming_call',
        callId: 'call-789',
        from: '+46701234567',
        to: '+46709876543',
      });

      // Should return connect action
      expect(result).toEqual({
        connect: '+46709876543',
        callerid: '+46701234567',
      });
    });

    it('should not emit incoming_call for outbound calls', async () => {
      await provider.handleWebhook('voice_start', {
        callid: 'call-789',
        from: '+46701234567',
        to: '+46709876543',
        direction: 'outgoing',
      }, {});

      expect(emittedEvents).toHaveLength(0);
    });

    it('should return connect action for outbound calls', async () => {
      const result = await provider.handleWebhook('voice_start', {
        callid: 'call-789',
        from: '+46701234567',
        to: '+46709876543',
        direction: 'outgoing',
      }, {});

      expect(result).toEqual({
        connect: '+46709876543',
        callerid: '+46701234567',
      });
    });
  });

  describe('handleWebhook - voice_event', () => {
    it('should emit call_state_changed for ongoing status', async () => {
      await provider.handleWebhook('voice_event', {
        callid: 'call-123',
        status: 'ongoing',
      }, {});

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-123',
        state: 'ANSWERED',
        durationSeconds: null,
      });
    });

    it('should emit call_state_changed for success status with duration', async () => {
      await provider.handleWebhook('voice_event', {
        callid: 'call-123',
        status: 'success',
        duration: 45,
      }, {});

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-123',
        state: 'COMPLETED',
        durationSeconds: 45,
      });
    });

    it('should emit call_state_changed for failed status', async () => {
      await provider.handleWebhook('voice_event', {
        callid: 'call-123',
        status: 'failed',
      }, {});

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-123',
        state: 'FAILED',
      });
    });

    it('should handle missing callid gracefully', async () => {
      await provider.handleWebhook('voice_event', {
        status: 'ongoing',
      }, {});

      expect(emittedEvents).toHaveLength(0);
    });

    it('should use id field as fallback for callid', async () => {
      await provider.handleWebhook('voice_event', {
        id: 'call-456',
        status: 'success',
        duration: 10,
      }, {});

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'call_state_changed',
        callId: 'call-456',
        state: 'COMPLETED',
      });
    });
  });

  describe('handleWebhook - sms_incoming', () => {
    it('should emit incoming_sms event', async () => {
      await provider.handleWebhook('sms_incoming', {
        id: 'sms-789',
        from: '+46701234567',
        to: '+46709876543',
        message: 'Hello there!',
      }, {});

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'incoming_sms',
        messageId: 'sms-789',
        from: '+46701234567',
        to: '+46709876543',
        body: 'Hello there!',
      });
    });

    it('should normalize inbound number without + prefix', async () => {
      await provider.handleWebhook('sms_incoming', {
        id: 'sms-789',
        from: '46701234567',
        to: '+46709876543',
        message: 'Hi',
      }, {});

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'incoming_sms',
        from: '+46701234567', // normalized with +
      });
    });

    it('should ignore SMS with missing from/to', async () => {
      await provider.handleWebhook('sms_incoming', {
        id: 'sms-789',
        message: 'Hi',
      }, {});

      expect(emittedEvents).toHaveLength(0);
    });
  });

  describe('handleWebhook - unknown endpoint', () => {
    it('should return empty object for unknown endpoints', async () => {
      const result = await provider.handleWebhook('unknown', {}, {});
      expect(result).toEqual({});
    });
  });

  describe('mapElks46StatusToCallState', () => {
    it('should map ongoing to ANSWERED', () => {
      expect(mapElks46StatusToCallState('ongoing')).toBe('ANSWERED');
    });

    it('should map success to COMPLETED', () => {
      expect(mapElks46StatusToCallState('success')).toBe('COMPLETED');
    });

    it('should map failed to FAILED', () => {
      expect(mapElks46StatusToCallState('failed')).toBe('FAILED');
    });

    it('should return null for unknown status', () => {
      expect(mapElks46StatusToCallState('unknown' as any)).toBeNull();
    });
  });

  describe('HTTP Basic Authentication', () => {
    it('should use correct auth header format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await provider.listNumbers();

      const authHeader = mockFetch.mock.calls[0][1].headers['Authorization'];
      const expected = `Basic ${btoa('test-user:test-pass')}`;
      expect(authHeader).toBe(expected);
    });
  });
});
