import { describe, it, expect } from 'vitest';
import { VonageTelephonyProvider } from './vonage-telephony-provider.js';
import type { TelephonyProvider, TelephonyEvent } from './telephony-provider.js';

describe('VonageTelephonyProvider', () => {
  const config = {
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    applicationId: '00000000-0000-0000-0000-000000000001',
    privateKeyPath: '/path/to/key.pem',
    webhookBaseUrl: 'https://example.com',
  };

  it('should have providerId set to "vonage"', () => {
    const provider = new VonageTelephonyProvider(config);
    expect(provider.providerId).toBe('vonage');
  });

  it('should implement the TelephonyProvider interface', () => {
    const provider: TelephonyProvider = new VonageTelephonyProvider(config);
    expect(provider.makeCall).toBeTypeOf('function');
    expect(provider.endCall).toBeTypeOf('function');
    expect(provider.answerCall).toBeTypeOf('function');
    expect(provider.sendSms).toBeTypeOf('function');
    expect(provider.listNumbers).toBeTypeOf('function');
    expect(provider.onEvent).toBeTypeOf('function');
    expect(provider.start).toBeTypeOf('function');
    expect(provider.stop).toBeTypeOf('function');
  });

  it('should throw when not started for makeCall', async () => {
    const provider = new VonageTelephonyProvider(config);
    await expect(provider.makeCall('+15551234567', '+15559876543')).rejects.toThrow('not started');
  });

  it('should throw when not started for endCall', async () => {
    const provider = new VonageTelephonyProvider(config);
    await expect(provider.endCall('call-123')).rejects.toThrow('not started');
  });

  it('should return success for answerCall (no-op in new architecture)', async () => {
    const provider = new VonageTelephonyProvider(config);
    const result = await provider.answerCall('call-123', 'device-1');
    expect(result.success).toBe(true);
    expect(result.clientToken).toBeNull();
    expect(result.errorReason).toBeNull();
  });

  it('should throw when not started for sendSms', async () => {
    const provider = new VonageTelephonyProvider(config);
    await expect(provider.sendSms('+15551234567', '+15559876543', 'Hello')).rejects.toThrow('not started');
  });

  it('should return empty array for listNumbers when API fails', async () => {
    const provider = new VonageTelephonyProvider(config);
    const result = await provider.listNumbers();
    expect(result).toEqual([]);
  });

  it('should throw when private key file not found for start', async () => {
    const provider = new VonageTelephonyProvider(config);
    await expect(provider.start()).rejects.toThrow();
  });

  it('should resolve cleanly for stop without starting', async () => {
    const provider = new VonageTelephonyProvider(config);
    await expect(provider.stop()).resolves.toBeUndefined();
  });

  it('should register event listeners and emit events to them', () => {
    const provider = new VonageTelephonyProvider(config);
    const receivedEvents: TelephonyEvent[] = [];

    provider.onEvent((event) => {
      receivedEvents.push(event);
    });

    // Access the protected emitEvent method via type assertion for testing
    const providerAny = provider as unknown as { emitEvent(event: TelephonyEvent): void };
    const testEvent: TelephonyEvent = {
      type: 'incoming_call',
      callId: 'call-abc',
      from: '+15551234567',
      to: '+15559876543',
      timestamp: Date.now(),
    };

    providerAny.emitEvent(testEvent);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual(testEvent);
  });

  it('should support multiple event listeners', () => {
    const provider = new VonageTelephonyProvider(config);
    const events1: TelephonyEvent[] = [];
    const events2: TelephonyEvent[] = [];

    provider.onEvent((event) => events1.push(event));
    provider.onEvent((event) => events2.push(event));

    const providerAny = provider as unknown as { emitEvent(event: TelephonyEvent): void };
    const testEvent: TelephonyEvent = {
      type: 'sms_status_update',
      messageId: 'msg-123',
      status: 'DELIVERED',
    };

    providerAny.emitEvent(testEvent);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0]).toEqual(testEvent);
    expect(events2[0]).toEqual(testEvent);
  });
});
