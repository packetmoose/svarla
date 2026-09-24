import { resolveWebhookEndpoint, getAcceptedEndpoints } from './webhook-endpoint-aliases.js';

const VONAGE_ENDPOINTS = ['answer', 'event', 'inbound-sms', 'sms-status'];
const ELKS46_ENDPOINTS = ['voice_start', 'sms_incoming'];

describe('resolveWebhookEndpoint', () => {
  describe('exact matches (backward compatibility)', () => {
    it('resolves native Vonage endpoints unchanged', () => {
      expect(resolveWebhookEndpoint('inbound-sms', VONAGE_ENDPOINTS)).toBe('inbound-sms');
      expect(resolveWebhookEndpoint('sms-status', VONAGE_ENDPOINTS)).toBe('sms-status');
      expect(resolveWebhookEndpoint('answer', VONAGE_ENDPOINTS)).toBe('answer');
      expect(resolveWebhookEndpoint('event', VONAGE_ENDPOINTS)).toBe('event');
    });

    it('resolves native 46elks endpoints unchanged', () => {
      expect(resolveWebhookEndpoint('voice_start', ELKS46_ENDPOINTS)).toBe('voice_start');
      expect(resolveWebhookEndpoint('sms_incoming', ELKS46_ENDPOINTS)).toBe('sms_incoming');
    });
  });

  describe('cross-provider aliases', () => {
    it('resolves 46elks sms_incoming to Vonage inbound-sms', () => {
      expect(resolveWebhookEndpoint('sms_incoming', VONAGE_ENDPOINTS)).toBe('inbound-sms');
    });

    it('resolves Vonage inbound-sms to 46elks sms_incoming', () => {
      expect(resolveWebhookEndpoint('inbound-sms', ELKS46_ENDPOINTS)).toBe('sms_incoming');
    });

    it('resolves voice_start to Vonage answer', () => {
      expect(resolveWebhookEndpoint('voice_start', VONAGE_ENDPOINTS)).toBe('answer');
    });

    it('resolves answer to 46elks voice_start', () => {
      expect(resolveWebhookEndpoint('answer', ELKS46_ENDPOINTS)).toBe('voice_start');
    });
  });

  describe('separator and case insensitivity', () => {
    it('treats - and _ as interchangeable', () => {
      expect(resolveWebhookEndpoint('sms-incoming', VONAGE_ENDPOINTS)).toBe('inbound-sms');
      expect(resolveWebhookEndpoint('sms_status', VONAGE_ENDPOINTS)).toBe('sms-status');
    });

    it('is case-insensitive', () => {
      expect(resolveWebhookEndpoint('SMS_INCOMING', VONAGE_ENDPOINTS)).toBe('inbound-sms');
      expect(resolveWebhookEndpoint('Inbound-SMS', ELKS46_ENDPOINTS)).toBe('sms_incoming');
    });
  });

  describe('unknown endpoints', () => {
    it('returns undefined for a genuinely unknown endpoint', () => {
      expect(resolveWebhookEndpoint('does-not-exist', VONAGE_ENDPOINTS)).toBeUndefined();
    });

    it('returns undefined for an empty endpoint', () => {
      expect(resolveWebhookEndpoint('', VONAGE_ENDPOINTS)).toBeUndefined();
    });

    it('returns undefined when the alias group has no supported member', () => {
      // sms-status has no equivalent on 46elks
      expect(resolveWebhookEndpoint('sms-status', ELKS46_ENDPOINTS)).toBeUndefined();
    });

    it('returns undefined when the provider supports no endpoints', () => {
      expect(resolveWebhookEndpoint('inbound-sms', [])).toBeUndefined();
    });
  });
});

describe('getAcceptedEndpoints', () => {
  it('adds voice_event for 46elks even though it is not statically listed', () => {
    const accepted = getAcceptedEndpoints('46elks', ELKS46_ENDPOINTS);
    expect(accepted).toContain('voice_start');
    expect(accepted).toContain('sms_incoming');
    expect(accepted).toContain('voice_event');
  });

  it('does not add extras for Vonage', () => {
    const accepted = getAcceptedEndpoints('vonage', VONAGE_ENDPOINTS);
    expect(accepted).toEqual(VONAGE_ENDPOINTS);
  });

  it('lets voice_event / voice-event resolve on 46elks via accepted extras', () => {
    const accepted = getAcceptedEndpoints('46elks', ELKS46_ENDPOINTS);
    expect(resolveWebhookEndpoint('voice_event', accepted)).toBe('voice_event');
    expect(resolveWebhookEndpoint('voice-event', accepted)).toBe('voice_event');
  });
});
