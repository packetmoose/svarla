import type {
  TelephonyProvider,
  CallInitResult,
  CallAnswerResult,
  SmsResult,
  ProviderNumber,
  TelephonyEvent,
} from './telephony-provider.js';

/**
 * Configuration for the ModemManager telephony provider.
 * Maps to the `telephony.modemmanager` section of server-config.yaml.
 */
export interface ModemManagerProviderConfig {
  /**
   * Optional mapping of SIM ICCID (or modem EquipmentIdentifier/IMEI) to E.164 phone number.
   * Used when the SIM doesn't report its own number via OwnNumbers.
   * The key should be the SIM's ICCID (SimIdentifier) which is stable across reboots,
   * unlike the modem path index which can change.
   */
  numberOverrides?: Record<string, string>;
}

/**
 * Internal representation of a discovered modem.
 */
interface ModemEntry {
  path: string;
  number: string;
  messagingProxy: unknown;
}

/**
 * ModemManager implementation of the TelephonyProvider interface.
 *
 * Communicates with USB modems via D-Bus using the ModemManager1 D-Bus API.
 * Currently supports SMS only; voice methods are stubbed for future implementation.
 */
export class ModemManagerTelephonyProvider implements TelephonyProvider {
  readonly providerId = 'modemmanager';

  private readonly config: ModemManagerProviderConfig;
  private eventListeners: Array<(event: TelephonyEvent) => void> = [];
  private bus: any = null;
  private objectManagerProxy: any = null;
  private modems: Map<string, ModemEntry> = new Map(); // number → ModemEntry
  private modemPathToNumber: Map<string, string> = new Map(); // modemPath → number
  private signalHandlers: Array<() => void> = [];

  constructor(config: ModemManagerProviderConfig = {}) {
    this.config = config;
  }

  /**
   * Connect to D-Bus, enumerate modems, and subscribe to signals.
   */
  async start(): Promise<void> {
    // Dynamically import dbus-next to allow mocking in tests
    const dbus = await import('dbus-next');
    const systemBusFn = dbus.systemBus ?? (dbus as any).default?.systemBus;

    try {
      this.bus = systemBusFn();
    } catch (error) {
      throw new Error(
        `Failed to connect to system D-Bus. Is ModemManager running? ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const proxyObject = await this.bus.getProxyObject(
        'org.freedesktop.ModemManager1',
        '/org/freedesktop/ModemManager1'
      );
      this.objectManagerProxy = proxyObject.getInterface(
        'org.freedesktop.DBus.ObjectManager'
      );
    } catch (error) {
      this.bus.disconnect();
      this.bus = null;
      throw new Error(
        `Failed to get ModemManager ObjectManager. Is ModemManager service running? ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Enumerate all currently managed modems
    const managedObjects = await this.objectManagerProxy.GetManagedObjects();
    for (const [path, interfaces] of Object.entries(managedObjects as Record<string, any>)) {
      if (interfaces['org.freedesktop.ModemManager1.Modem']) {
        await this.addModem(path, interfaces);
      }
    }

    // Subscribe to modem hot-plug: InterfacesAdded / InterfacesRemoved
    this.objectManagerProxy.on('InterfacesAdded', async (path: string, interfaces: Record<string, any>) => {
      if (interfaces['org.freedesktop.ModemManager1.Modem']) {
        await this.addModem(path, interfaces);
      }
    });
    this.signalHandlers.push(() => {
      this.objectManagerProxy?.removeAllListeners('InterfacesAdded');
    });

    this.objectManagerProxy.on('InterfacesRemoved', (path: string, _interfaces: string[]) => {
      this.removeModem(path);
    });
    this.signalHandlers.push(() => {
      this.objectManagerProxy?.removeAllListeners('InterfacesRemoved');
    });
  }

  /**
   * Disconnect from D-Bus and clean up.
   */
  async stop(): Promise<void> {
    // Remove signal handlers
    for (const cleanup of this.signalHandlers) {
      cleanup();
    }
    this.signalHandlers = [];
    this.modems.clear();
    this.modemPathToNumber.clear();

    if (this.bus) {
      this.bus.disconnect();
      this.bus = null;
    }
    this.objectManagerProxy = null;
  }

  /**
   * List all discovered modem numbers with their capabilities.
   */
  async listNumbers(): Promise<ProviderNumber[]> {
    const numbers: ProviderNumber[] = [];
    for (const [number] of this.modems) {
      numbers.push({
        number,
        capabilities: new Set(['SMS']),
      });
    }
    return numbers;
  }

  /**
   * Send an SMS message via the modem associated with the `from` number.
   */
  async sendSms(from: string, to: string, body: string): Promise<SmsResult> {
    const modem = this.modems.get(from);
    if (!modem) {
      return {
        messageId: '',
        success: false,
        errorReason: `No modem found for number: ${from}`,
      };
    }

    try {
      const messagingProxy = modem.messagingProxy as any;

      // Create the SMS object on the modem
      const smsPath: string = await messagingProxy.Create({
        number: { value: to, signature: 's' },
        text: { value: body, signature: 's' },
      });

      // Get the SMS object and call Send()
      const smsProxyObject = await this.bus.getProxyObject(
        'org.freedesktop.ModemManager1',
        smsPath
      );
      const smsInterface = smsProxyObject.getInterface(
        'org.freedesktop.ModemManager1.Sms'
      );
      await smsInterface.Send();

      return {
        messageId: smsPath,
        success: true,
        errorReason: null,
      };
    } catch (error) {
      return {
        messageId: '',
        success: false,
        errorReason: error instanceof Error ? error.message : 'Failed to send SMS',
      };
    }
  }

  /**
   * Voice calls are not yet implemented for ModemManager.
   */
  async makeCall(_from: string, _to: string): Promise<CallInitResult> {
    throw new Error('Voice calls are not yet implemented for ModemManager provider');
  }

  /**
   * Voice calls are not yet implemented for ModemManager.
   */
  async endCall(_callId: string): Promise<void> {
    throw new Error('Voice calls are not yet implemented for ModemManager provider');
  }

  /**
   * Voice calls are not yet implemented for ModemManager.
   */
  async answerCall(_callId: string, _deviceId: string): Promise<CallAnswerResult> {
    throw new Error('Voice calls are not yet implemented for ModemManager provider');
  }

  onEvent(listener: (event: TelephonyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * ModemManager uses D-Bus signals, not webhooks, so no endpoints are needed.
   */
  getWebhookEndpoints(): string[] {
    return [];
  }

  /**
   * ModemManager does not receive webhooks. Returns acknowledgement.
   */
  async handleWebhook(_endpoint: string, _body: unknown, _request: unknown): Promise<unknown> {
    return { status: 'not_applicable' };
  }

  /**
   * Emit an event to all registered listeners.
   */
  private emitEvent(event: TelephonyEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /**
   * Add a modem to the internal map and subscribe to its Messaging.Added signal.
   */
  private async addModem(path: string, interfaces: Record<string, any>): Promise<void> {
    const modemIface = interfaces['org.freedesktop.ModemManager1.Modem'];
    let ownNumbers: string[] = [];
    let simIdentifier = '';
    let equipmentIdentifier = '';

    if (modemIface) {
      if (modemIface.OwnNumbers) {
        // OwnNumbers may be a Variant; extract the value
        const raw = modemIface.OwnNumbers;
        ownNumbers = Array.isArray(raw?.value) ? raw.value : Array.isArray(raw) ? raw : [];
      }
      // Read stable identifiers for number override lookup
      if (modemIface.SimIdentifier) {
        const raw = modemIface.SimIdentifier;
        simIdentifier = raw?.value ?? (typeof raw === 'string' ? raw : '');
      }
      if (modemIface.EquipmentIdentifier) {
        const raw = modemIface.EquipmentIdentifier;
        equipmentIdentifier = raw?.value ?? (typeof raw === 'string' ? raw : '');
      }
    }

    // Also try reading SimIdentifier from the Sim interface if not in Modem properties
    const simIface = interfaces['org.freedesktop.ModemManager1.Sim'];
    if (!simIdentifier && simIface?.SimIdentifier) {
      const raw = simIface.SimIdentifier;
      simIdentifier = raw?.value ?? (typeof raw === 'string' ? raw : '');
    }

    // Determine the phone number: OwnNumbers first, then override by SIM ICCID or IMEI
    let number: string | undefined = ownNumbers[0];
    if (!number && this.config.numberOverrides) {
      // Try SIM ICCID first (most stable identifier)
      if (simIdentifier && this.config.numberOverrides[simIdentifier]) {
        number = this.config.numberOverrides[simIdentifier];
      }
      // Then try IMEI (equipment identifier)
      else if (equipmentIdentifier && this.config.numberOverrides[equipmentIdentifier]) {
        number = this.config.numberOverrides[equipmentIdentifier];
      }
      // Last resort: try modem path index (not recommended, unstable)
      else {
        const modemIndex = path.split('/').pop() ?? '';
        if (this.config.numberOverrides[modemIndex]) {
          number = this.config.numberOverrides[modemIndex];
        }
      }
    }

    if (!number) {
      // Cannot register modem without a number
      console.warn(
        `[ModemManager] Modem at ${path} (SIM: ${simIdentifier || 'unknown'}, IMEI: ${equipmentIdentifier || 'unknown'}) has no OwnNumbers and no override configured. Skipping.`
      );
      return;
    }

    // Get the Messaging interface proxy for this modem
    let messagingProxy: any;
    try {
      const modemProxyObject = await this.bus.getProxyObject(
        'org.freedesktop.ModemManager1',
        path
      );
      messagingProxy = modemProxyObject.getInterface(
        'org.freedesktop.ModemManager1.Modem.Messaging'
      );
    } catch (error) {
      console.warn(
        `[ModemManager] Failed to get Messaging interface for modem at ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    const entry: ModemEntry = { path, number, messagingProxy };
    this.modems.set(number, entry);
    this.modemPathToNumber.set(path, number);

    // Subscribe to incoming SMS signal
    messagingProxy.on('Added', async (smsPath: string, received: boolean) => {
      if (!received) return;
      await this.handleIncomingSms(smsPath, number!);
    });
    this.signalHandlers.push(() => {
      messagingProxy.removeAllListeners('Added');
    });

    // TODO: Subscribe to Voice.CallAdded signal for future voice support
    // try {
    //   const voiceProxy = modemProxyObject.getInterface(
    //     'org.freedesktop.ModemManager1.Modem.Voice'
    //   );
    //   voiceProxy.on('CallAdded', (callPath: string) => {
    //     // Future: handle incoming voice call
    //   });
    //   voiceProxy.on('CallDeleted', (callPath: string) => {
    //     // Future: handle call ended
    //   });
    // } catch {
    //   // Voice interface may not be available on all modems
    // }
  }

  /**
   * Remove a modem from the internal map when it is unplugged.
   */
  private removeModem(path: string): void {
    const number = this.modemPathToNumber.get(path);
    if (number) {
      console.warn(`[ModemManager] Modem removed: ${path} (number: ${number})`);
      this.modems.delete(number);
      this.modemPathToNumber.delete(path);
    }
  }

  /**
   * Handle an incoming SMS by reading the SMS object properties and emitting an event.
   */
  private async handleIncomingSms(smsPath: string, modemNumber: string): Promise<void> {
    try {
      const smsProxyObject = await this.bus.getProxyObject(
        'org.freedesktop.ModemManager1',
        smsPath
      );
      const smsProperties = smsProxyObject.getInterface(
        'org.freedesktop.DBus.Properties'
      );

      const smsNumber = await smsProperties.Get(
        'org.freedesktop.ModemManager1.Sms',
        'Number'
      );
      const smsText = await smsProperties.Get(
        'org.freedesktop.ModemManager1.Sms',
        'Text'
      );

      // Extract values from D-Bus Variants
      const from = smsNumber?.value ?? smsNumber ?? '';
      const body = smsText?.value ?? smsText ?? '';

      this.emitEvent({
        type: 'incoming_sms',
        messageId: smsPath,
        from: String(from),
        to: modemNumber,
        body: String(body),
        timestamp: Date.now(),
      });
    } catch (error) {
      console.warn(
        `[ModemManager] Failed to read incoming SMS at ${smsPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
