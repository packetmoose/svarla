import { describe, it, expect } from 'vitest';
import {
  buildOutboundCallNcco,
  buildSipConnectNcco,
} from './ncco-builder.js';

describe('NccoBuilder', () => {
  describe('buildOutboundCallNcco', () => {
    it('should build connect action with phone endpoint and from number', () => {
      const ncco = buildOutboundCallNcco('+14155551234', '+14155550000');

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'phone', number: '+14155551234' }],
          from: '+14155550000',
        },
      ]);
    });

    it('should include eventUrl when provided', () => {
      const ncco = buildOutboundCallNcco(
        '+14155551234',
        '+14155550000',
        'https://example.com/webhooks/event'
      );

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'phone', number: '+14155551234' }],
          from: '+14155550000',
          eventUrl: ['https://example.com/webhooks/event'],
        },
      ]);
    });

    it('should not include eventUrl when not provided', () => {
      const ncco = buildOutboundCallNcco('+447700900000', '+14155550000');

      expect(ncco).toHaveLength(1);
      expect(ncco[0]).not.toHaveProperty('eventUrl');
    });

    it('should produce exactly one connect action', () => {
      const ncco = buildOutboundCallNcco('+61412345678', '+14155550000');

      expect(ncco).toHaveLength(1);
      expect(ncco[0]).toHaveProperty('action', 'connect');
    });
  });

  describe('buildSipConnectNcco', () => {
    it('should build connect action with SIP endpoint', () => {
      const ncco = buildSipConnectNcco('sip://session-123@mediabridge:5060');

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'sip', uri: 'sip://session-123@mediabridge:5060' }],
        },
      ]);
    });

    it('should include from when provided', () => {
      const ncco = buildSipConnectNcco('sip://session-123@mediabridge:5060', '+14155550000');

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'sip', uri: 'sip://session-123@mediabridge:5060' }],
          from: '+14155550000',
        },
      ]);
    });

    it('should include eventUrl when provided', () => {
      const ncco = buildSipConnectNcco(
        'sip://session-123@mediabridge:5060',
        '+14155550000',
        'https://example.com/webhooks/event'
      );

      expect(ncco).toEqual([
        {
          action: 'connect',
          endpoint: [{ type: 'sip', uri: 'sip://session-123@mediabridge:5060' }],
          from: '+14155550000',
          eventUrl: ['https://example.com/webhooks/event'],
        },
      ]);
    });

    it('should not include from when not provided', () => {
      const ncco = buildSipConnectNcco('sip://session-abc@mediabridge:5060');

      expect(ncco).toHaveLength(1);
      expect(ncco[0]).not.toHaveProperty('from');
    });

    it('should not include eventUrl when not provided', () => {
      const ncco = buildSipConnectNcco('sip://session-abc@mediabridge:5060', '+14155550000');

      expect(ncco).toHaveLength(1);
      expect(ncco[0]).not.toHaveProperty('eventUrl');
    });

    it('should produce exactly one connect action', () => {
      const ncco = buildSipConnectNcco('sip://test@host:5060');

      expect(ncco).toHaveLength(1);
      expect(ncco[0]).toHaveProperty('action', 'connect');
    });
  });
});
