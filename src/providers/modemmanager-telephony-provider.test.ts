import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TelephonyEvent } from './telephony-provider.js';

/**
 * Mock D-Bus interfaces and objects for testing the ModemManager provider
 * without an actual D-Bus connection.
 */

// --- Mock state container (must be declared before vi.mock) ---
const mockState = {
  bus: null as any,
};

// Set up the dbus-next mock — factory references mockState so it always uses latest value
vi.mock('dbus-next', () => ({
  systemBus: () => {
    if (!mockState.bus) {
      throw new Error('Connection refused');
    }
    return mockState.bus;
  },
  default: {
    systemBus: () => {
      if (!mockState.bus) {
        throw new Error('Connection refused');
      }
      return mockState.bus;
    },
  },
}));

// Import after mock setup
import { ModemManagerTelephonyProvider } from './modemmanager-telephony-provider.js';

// --- Mock factories ---

function createMockSmsInterface() {
  return {
    Send: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSmsPropertiesInterface() {
  return {
    Get: vi.fn().mockImplementation((_iface: string, prop: string) => {
      if (prop === 'Number') return { value: '+15559990000' };
      if (prop === 'Text') return { value: 'Hello from outside' };
      return { value: '' };
    }),
  };
}

function createMockMessagingProxy() {
  const listeners: Record<string, Function[]> = {};
  return {
    Create: vi.fn().mockResolvedValue('/org/freedesktop/ModemManager1/SMS/0'),
    List: vi.fn().mockResolvedValue([]),
    on: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeAllListeners: vi.fn().mockImplementation((event?: string) => {
      if (event) {
        delete listeners[event];
      } else {
        for (const key of Object.keys(listeners)) delete listeners[key];
      }
    }),
    // Helper to simulate signal emission in tests
    _emit: (event: string, ...args: any[]) => {
      for (const handler of listeners[event] ?? []) {
        handler(...args);
      }
    },
  };
}

function createMockObjectManagerProxy() {
  const listeners: Record<string, Function[]> = {};
  return {
    GetManagedObjects: vi.fn().mockResolvedValue({
      '/org/freedesktop/ModemManager1/Modem/0': {
        'org.freedesktop.ModemManager1.Modem': {
          OwnNumbers: ['+15551234567'],
        },
        'org.freedesktop.ModemManager1.Modem.Messaging': {},
      },
      '/org/freedesktop/ModemManager1/Modem/1': {
        'org.freedesktop.ModemManager1.Modem': {
          OwnNumbers: ['+15559876543'],
        },
        'org.freedesktop.ModemManager1.Modem.Messaging': {},
      },
    }),
    on: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeAllListeners: vi.fn().mockImplementation((event?: string) => {
      if (event) {
        delete listeners[event];
      } else {
        for (const key of Object.keys(listeners)) delete listeners[key];
      }
    }),
    _emit: (event: string, ...args: any[]) => {
      for (const handler of listeners[event] ?? []) {
        handler(...args);
      }
    },
  };
}

// Shared mock instances
let mockObjectManagerProxy: ReturnType<typeof createMockObjectManagerProxy>;
let mockMessagingProxies: Map<string, ReturnType<typeof createMockMessagingProxy>>;
let mockSmsInterface: ReturnType<typeof createMockSmsInterface>;
let mockSmsPropertiesInterface: ReturnType<typeof createMockSmsPropertiesInterface>;

describe('ModemManagerTelephonyProvider', () => {
  beforeEach(() => {
    mockObjectManagerProxy = createMockObjectManagerProxy();
    mockMessagingProxies = new Map();
    mockSmsInterface = createMockSmsInterface();
    mockSmsPropertiesInterface = createMockSmsPropertiesInterface();

    // Create messaging proxies for each modem path
    mockMessagingProxies.set(
      '/org/freedesktop/ModemManager1/Modem/0',
      createMockMessagingProxy()
    );
    mockMessagingProxies.set(
      '/org/freedesktop/ModemManager1/Modem/1',
      createMockMessagingProxy()
    );

    mockState.bus = {
      disconnect: vi.fn(),
      getProxyObject: vi.fn().mockImplementation((_service: string, path: string) => {
        if (path === '/org/freedesktop/ModemManager1') {
          return Promise.resolve({
            getInterface: (ifaceName: string) => {
              if (ifaceName === 'org.freedesktop.DBus.ObjectManager') {
                return mockObjectManagerProxy;
              }
              throw new Error(`Unknown interface: ${ifaceName}`);
            },
          });
        }

        // Modem paths
        if (path.startsWith('/org/freedesktop/ModemManager1/Modem/')) {
          const messagingProxy = mockMessagingProxies.get(path) ?? createMockMessagingProxy();
          return Promise.resolve({
            getInterface: (ifaceName: string) => {
              if (ifaceName === 'org.freedesktop.ModemManager1.Modem.Messaging') {
                return messagingProxy;
              }
              throw new Error(`Unknown interface: ${ifaceName}`);
            },
          });
        }

        // SMS object paths
        if (path.startsWith('/org/freedesktop/ModemManager1/SMS/')) {
          return Promise.resolve({
            getInterface: (ifaceName: string) => {
              if (ifaceName === 'org.freedesktop.ModemManager1.Sms') {
                return mockSmsInterface;
              }
              if (ifaceName === 'org.freedesktop.DBus.Properties') {
                return mockSmsPropertiesInterface;
              }
              throw new Error(`Unknown interface: ${ifaceName}`);
            },
          });
        }

        return Promise.reject(new Error(`Unknown object path: ${path}`));
      }),
    };
  });

  afterEach(() => {
    mockState.bus = null;
    vi.restoreAllMocks();
  });

  describe('providerId', () => {
    it('should return "modemmanager"', () => {
      const provider = new ModemManagerTelephonyProvider();
      expect(provider.providerId).toBe('modemmanager');
    });
  });

  describe('start() and listNumbers()', () => {
    it('should discover modems and list their numbers', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      const numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(2);

      const numberStrings = numbers.map((n) => n.number).sort();
      expect(numberStrings).toEqual(['+15551234567', '+15559876543']);

      // All numbers should have only SMS capability
      for (const num of numbers) {
        expect(num.capabilities).toEqual(new Set(['SMS']));
      }

      await provider.stop();
    });

    it('should use number_overrides when OwnNumbers is empty', async () => {
      // Modify mock to have empty OwnNumbers but a SimIdentifier (ICCID)
      mockObjectManagerProxy.GetManagedObjects.mockResolvedValue({
        '/org/freedesktop/ModemManager1/Modem/0': {
          'org.freedesktop.ModemManager1.Modem': {
            OwnNumbers: [],
            SimIdentifier: '8901260123456789012',
            EquipmentIdentifier: '353456789012345',
          },
          'org.freedesktop.ModemManager1.Modem.Messaging': {},
        },
      });

      const provider = new ModemManagerTelephonyProvider({
        numberOverrides: { '8901260123456789012': '+15550001111' },
      });
      await provider.start();

      const numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(1);
      expect(numbers[0].number).toBe('+15550001111');

      await provider.stop();
    });

    it('should skip modems with no OwnNumbers and no override', async () => {
      mockObjectManagerProxy.GetManagedObjects.mockResolvedValue({
        '/org/freedesktop/ModemManager1/Modem/0': {
          'org.freedesktop.ModemManager1.Modem': {
            OwnNumbers: [],
          },
          'org.freedesktop.ModemManager1.Modem.Messaging': {},
        },
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      const numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();

      await provider.stop();
      warnSpy.mockRestore();
    });

    it('should throw if D-Bus connection fails', async () => {
      // Set bus to null so the mock throws
      mockState.bus = null;

      const provider = new ModemManagerTelephonyProvider();
      await expect(provider.start()).rejects.toThrow(/Failed to connect to system D-Bus/);
    });
  });

  describe('sendSms()', () => {
    it('should send SMS via the correct modem', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      const result = await provider.sendSms('+15551234567', '+15550009999', 'Test message');

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('/org/freedesktop/ModemManager1/SMS/0');
      expect(result.errorReason).toBeNull();

      // Verify Create was called on the correct modem's messaging proxy
      const modem0Proxy = mockMessagingProxies.get('/org/freedesktop/ModemManager1/Modem/0')!;
      expect(modem0Proxy.Create).toHaveBeenCalledWith({
        number: { value: '+15550009999', signature: 's' },
        text: { value: 'Test message', signature: 's' },
      });

      // Verify Send was called on the SMS object
      expect(mockSmsInterface.Send).toHaveBeenCalled();

      await provider.stop();
    });

    it('should return error for unknown from number', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      const result = await provider.sendSms('+15550000000', '+15550009999', 'Test');

      expect(result.success).toBe(false);
      expect(result.messageId).toBe('');
      expect(result.errorReason).toContain('No modem found for number');

      await provider.stop();
    });

    it('should handle D-Bus errors during send', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      // Make Send() throw
      mockSmsInterface.Send.mockRejectedValueOnce(new Error('Modem busy'));

      const result = await provider.sendSms('+15551234567', '+15550009999', 'Test');

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe('Modem busy');

      await provider.stop();
    });
  });

  describe('voice methods', () => {
    it('makeCall should throw not implemented error', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await expect(provider.makeCall('+15551234567', '+15550009999')).rejects.toThrow(
        'Voice calls are not yet implemented for ModemManager provider'
      );
    });

    it('endCall should throw not implemented error', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await expect(provider.endCall('call-123')).rejects.toThrow(
        'Voice calls are not yet implemented for ModemManager provider'
      );
    });

    it('answerCall should throw not implemented error', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await expect(provider.answerCall('call-123', 'device-1')).rejects.toThrow(
        'Voice calls are not yet implemented for ModemManager provider'
      );
    });
  });

  describe('incoming SMS events', () => {
    it('should emit incoming_sms event when Messaging.Added signal fires', async () => {
      const provider = new ModemManagerTelephonyProvider();
      const events: TelephonyEvent[] = [];
      provider.onEvent((event) => events.push(event));

      await provider.start();

      // Simulate the Added signal on modem 0's messaging proxy
      const modem0Proxy = mockMessagingProxies.get('/org/freedesktop/ModemManager1/Modem/0')!;
      modem0Proxy._emit('Added', '/org/freedesktop/ModemManager1/SMS/0', true);

      // Give the async handler time to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'incoming_sms',
        messageId: '/org/freedesktop/ModemManager1/SMS/0',
        from: '+15559990000',
        to: '+15551234567',
        body: 'Hello from outside',
      });
      expect((events[0] as any).timestamp).toBeTypeOf('number');

      await provider.stop();
    });

    it('should not emit event for outbound SMS (received=false)', async () => {
      const provider = new ModemManagerTelephonyProvider();
      const events: TelephonyEvent[] = [];
      provider.onEvent((event) => events.push(event));

      await provider.start();

      const modem0Proxy = mockMessagingProxies.get('/org/freedesktop/ModemManager1/Modem/0')!;
      modem0Proxy._emit('Added', '/org/freedesktop/ModemManager1/SMS/1', false);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events).toHaveLength(0);

      await provider.stop();
    });
  });

  describe('modem hot-plug', () => {
    it('should add modem when InterfacesAdded signal fires', async () => {
      // Start with only modem 0
      mockObjectManagerProxy.GetManagedObjects.mockResolvedValue({
        '/org/freedesktop/ModemManager1/Modem/0': {
          'org.freedesktop.ModemManager1.Modem': {
            OwnNumbers: ['+15551234567'],
          },
          'org.freedesktop.ModemManager1.Modem.Messaging': {},
        },
      });

      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      let numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(1);

      // Add a new messaging proxy for modem 2
      mockMessagingProxies.set(
        '/org/freedesktop/ModemManager1/Modem/2',
        createMockMessagingProxy()
      );

      // Simulate InterfacesAdded signal
      mockObjectManagerProxy._emit(
        'InterfacesAdded',
        '/org/freedesktop/ModemManager1/Modem/2',
        {
          'org.freedesktop.ModemManager1.Modem': {
            OwnNumbers: ['+15552222222'],
          },
          'org.freedesktop.ModemManager1.Modem.Messaging': {},
        }
      );

      // Give async handler time to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(2);
      expect(numbers.map((n) => n.number).sort()).toEqual(['+15551234567', '+15552222222']);

      await provider.stop();
    });

    it('should remove modem when InterfacesRemoved signal fires', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      let numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(2);

      // Simulate InterfacesRemoved signal
      mockObjectManagerProxy._emit(
        'InterfacesRemoved',
        '/org/freedesktop/ModemManager1/Modem/0',
        ['org.freedesktop.ModemManager1.Modem']
      );

      numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(1);
      expect(numbers[0].number).toBe('+15559876543');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Modem removed')
      );

      await provider.stop();
      warnSpy.mockRestore();
    });
  });

  describe('stop()', () => {
    it('should disconnect from D-Bus and clear state', async () => {
      const provider = new ModemManagerTelephonyProvider();
      await provider.start();

      await provider.stop();

      expect(mockState.bus.disconnect).toHaveBeenCalled();

      const numbers = await provider.listNumbers();
      expect(numbers).toHaveLength(0);
    });
  });
});
