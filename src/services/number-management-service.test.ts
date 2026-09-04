import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NumberManagementService, ProviderUnavailableError } from './number-management-service.js';
import type { BroadcastCallback, NumberEvent } from './number-management-service.js';
import type { TelephonyProvider, ProviderNumber } from '../providers/telephony-provider.js';
import type { ProviderRegistry, ProviderRegistryEntry } from './provider-registry.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

function createMockProviderInstance(numbers: ProviderNumber[] = []): TelephonyProvider {
  return {
    providerId: 'test',
    listNumbers: vi.fn<[], Promise<ProviderNumber[]>>().mockResolvedValue(numbers),
    makeCall: vi.fn(),
    endCall: vi.fn(),
    answerCall: vi.fn(),
    sendSms: vi.fn(),
    onEvent: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getWebhookEndpoints: vi.fn().mockReturnValue([]),
    handleWebhook: vi.fn(),
  } as unknown as TelephonyProvider;
}

function createMockRegistry(entries: Map<string, ProviderRegistryEntry> = new Map()): ProviderRegistry {
  return {
    getProvider: vi.fn((id: string) => entries.get(id)),
    listProviders: vi.fn(() => Array.from(entries.values())),
    loadAll: vi.fn(),
    addProvider: vi.fn(),
    updateProvider: vi.fn(),
    removeProvider: vi.fn(),
    getWebhookUrls: vi.fn(() => []),
  } as unknown as ProviderRegistry;
}

interface MockNumberRow {
  number: string;
  provider_id: string | null;
  label: string | null;
  color?: string | null;
  added_at: Date;
  is_active: boolean;
  last_used_at: Date | null;
}

interface MockProviderRow {
  id: string;
  display_name: string;
}

// Build a predicate for a single Kysely-style where clause against a number row.
function mkPred(col: string, op: string, val: unknown): (n: MockNumberRow) => boolean {
  return (n: MockNumberRow) => {
    const cell = (n as unknown as Record<string, unknown>)[col];
    if (op === 'is not' && val === null) return cell != null;
    if (op === 'is' && val === null) return cell == null;
    if (op === '!=') return cell !== val;
    // Subquery objects (used by color reclaim) never match a scalar cell.
    if (val !== null && typeof val === 'object') return false;
    return cell === val;
  };
}

function createMockDb(initialNumbers: MockNumberRow[] = [], providers: MockProviderRow[] = []) {
  let numbers = [...initialNumbers];
  let settings: Record<string, string | null> = {};

  const mockDb = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'settings') {
        return {
          select: (_col: string) => ({
            where: (_filterCol: string, _op: string, _filterVal: unknown) => ({
              executeTakeFirst: async () => {
                const key = _filterVal as string;
                if (key in settings) {
                  return { value: settings[key] };
                }
                return undefined;
              },
            }),
          }),
        };
      }
      if (table === 'numbers') {
        return {
          selectAll: () => ({
            where: (col: string, _op: string, val: unknown) => ({
              execute: async () => {
                return numbers.filter((n) => {
                  if (col === 'provider_id') return n.provider_id === val;
                  if (col === 'is_active') return n.is_active === val;
                  return true;
                });
              },
              orderBy: (_col2: string, _dir: string) => ({
                execute: async () => {
                  let filtered = numbers.filter((n) => {
                    if (col === 'is_active') return n.is_active === val;
                    return true;
                  });
                  filtered.sort((a, b) => {
                    if (a.last_used_at === null && b.last_used_at === null) return 0;
                    if (a.last_used_at === null) return 1;
                    if (b.last_used_at === null) return -1;
                    return new Date(b.last_used_at).getTime() - new Date(a.last_used_at).getTime();
                  });
                  return filtered;
                },
              }),
            }),
          }),
          innerJoin: (_joinTable: string, _col1: string, _col2: string) => ({
            select: (_cols: string[]) => ({
              where: (col: string, _op: string, val: unknown) => ({
                orderBy: (_sortCol: string, _dir: string) => ({
                  execute: async () => {
                    let filtered = numbers.filter((n) => {
                      if (col === 'numbers.is_active') return n.is_active === val;
                      return true;
                    });
                    filtered.sort((a, b) => {
                      if (a.last_used_at === null && b.last_used_at === null) return 0;
                      if (a.last_used_at === null) return 1;
                      if (b.last_used_at === null) return -1;
                      return new Date(b.last_used_at).getTime() - new Date(a.last_used_at).getTime();
                    });
                    return filtered.map((n) => {
                      const prov = providers.find((p) => p.id === n.provider_id);
                      return {
                        ...n,
                        provider_display_name: prov?.display_name ?? 'Unknown',
                      };
                    });
                  },
                }),
                execute: async () => {
                  const filtered = numbers.filter((n) => {
                    if (col === 'numbers.is_active') return n.is_active === val;
                    return true;
                  });
                  return filtered.map((n) => {
                    const prov = providers.find((p) => p.id === n.provider_id);
                    return {
                      ...n,
                      provider_display_name: prov?.display_name ?? 'Unknown',
                    };
                  });
                },
              }),
            }),
          }),
          select: (col: string | string[]) => {
            // Predicate builder shared across chained .where() calls, so
            // getColorUsage()'s `.where('color','is not',null)[.where('number','!=',x)].execute()`
            // and the lookup `.where('number','=',x).where('is_active','=',true).executeTakeFirst()`
            // are both supported.
            const makeWhere = (preds: Array<(n: MockNumberRow) => boolean>) => ({
              where: (fc: string, op: string, fv: unknown) =>
                makeWhere([...preds, mkPred(fc, op, fv)]),
              executeTakeFirst: async () => {
                const found = numbers.find((n) => preds.every((p) => p(n)));
                if (!found) return undefined;
                if (col === 'provider_id' || (Array.isArray(col) && col.includes('provider_id'))) {
                  return { provider_id: found.provider_id };
                }
                return found;
              },
              execute: async () => {
                const filtered = numbers.filter((n) => preds.every((p) => p(n)));
                return filtered.map((n) => ({
                  color: n.color ?? null,
                  is_active: n.is_active,
                }));
              },
            });
            return makeWhere([]);
          },
        };
      }
      return {};
    }),
    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === 'settings') {
        return {
          values: (values: Record<string, unknown>) => ({
            onConflict: (_oc: unknown) => ({
              column: (_col: string) => ({
                doUpdateSet: (_vals: Record<string, unknown>) => ({
                  execute: async () => {
                    settings[values.key as string] = values.value as string | null;
                  },
                }),
              }),
            }),
            execute: async () => {
              settings[values.key as string] = values.value as string | null;
            },
          }),
        };
      }
      return {
        values: (values: Record<string, unknown>) => ({
          execute: async () => {
            numbers.push({
              number: values.number as string,
              provider_id: values.provider_id as string,
              label: (values.label as string | null) ?? null,
              color: (values.color as string | null) ?? null,
              added_at: new Date(),
              is_active: values.is_active as boolean,
              last_used_at: (values.last_used_at as Date | null) ?? null,
            });
          },
        }),
      };
    }),
    updateTable: vi.fn().mockImplementation((_table: string) => {
      return {
        set: (values: Record<string, unknown>) => ({
          where: (col: string, _op: string, val: unknown) => ({
            where: (col2: string, _op2: string, val2: unknown) => ({
              executeTakeFirst: async () => {
                const idx = numbers.findIndex((n) => {
                  const matchFirst = col === 'number' ? n.number === val : true;
                  const matchSecond = col2 === 'is_active' ? n.is_active === val2 : true;
                  return matchFirst && matchSecond;
                });
                if (idx >= 0) {
                  Object.assign(numbers[idx], values);
                  return { numUpdatedRows: 1n };
                }
                return { numUpdatedRows: 0n };
              },
            }),
            execute: async () => {
              const idx = numbers.findIndex((n) => {
                if (col === 'number') return n.number === val;
                return true;
              });
              if (idx >= 0) {
                Object.assign(numbers[idx], values);
              }
            },
            executeTakeFirst: async () => {
              const idx = numbers.findIndex((n) => {
                if (col === 'number') return n.number === val;
                return true;
              });
              if (idx >= 0) {
                Object.assign(numbers[idx], values);
                return { numUpdatedRows: 1n };
              }
              return { numUpdatedRows: 0n };
            },
          }),
        }),
      };
    }),
  } as unknown as Kysely<Database>;

  return { mockDb, getNumbers: () => numbers, setNumbers: (n: MockNumberRow[]) => { numbers = n; }, setSettings: (s: Record<string, string | null>) => { settings = s; } };
}

describe('NumberManagementService', () => {
  const PROVIDER_ID = 'provider-1';
  const PROVIDER_DISPLAY_NAME = 'Test Provider';

  let service: NumberManagementService;
  let mockProviderInstance: TelephonyProvider;
  let mockRegistry: ProviderRegistry;
  let dbHelper: ReturnType<typeof createMockDb>;
  let broadcastEvents: NumberEvent[];
  let broadcast: BroadcastCallback;

  beforeEach(() => {
    broadcastEvents = [];
    broadcast = (event) => broadcastEvents.push(event);
    mockProviderInstance = createMockProviderInstance();

    const entries = new Map<string, ProviderRegistryEntry>();
    entries.set(PROVIDER_ID, {
      id: PROVIDER_ID,
      type: 'dummy',
      displayName: PROVIDER_DISPLAY_NAME,
      config: {},
      enabled: true,
      instance: mockProviderInstance,
      status: 'active',
    });

    mockRegistry = createMockRegistry(entries);
    dbHelper = createMockDb([], [{ id: PROVIDER_ID, display_name: PROVIDER_DISPLAY_NAME }]);
    service = new NumberManagementService(dbHelper.mockDb, mockRegistry, broadcast);
  });

  describe('syncNumbers', () => {
    // TODO: DB mock missing onConflict method. See #18
    it.skip('should add new numbers from provider with provider_id', async () => {
      (mockProviderInstance.listNumbers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { number: '+14155551234', capabilities: new Set(['VOICE', 'SMS']) },
        { number: '+14155555678', capabilities: new Set(['VOICE']) },
      ]);

      const result = await service.syncNumbers(PROVIDER_ID);

      expect(result.added).toEqual(['+14155551234', '+14155555678']);
      expect(result.removed).toEqual([]);
      expect(result.total).toBe(2);
      expect(dbHelper.getNumbers()).toHaveLength(2);
      expect(dbHelper.getNumbers()[0].is_active).toBe(true);
      expect(dbHelper.getNumbers()[0].provider_id).toBe(PROVIDER_ID);
      expect(dbHelper.getNumbers()[1].provider_id).toBe(PROVIDER_ID);
    });

    it('should mark removed numbers as inactive', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: 'Personal', added_at: new Date(), is_active: true, last_used_at: null },
        { number: '+14155555678', provider_id: PROVIDER_ID, label: 'Business', added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      (mockProviderInstance.listNumbers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { number: '+14155551234', capabilities: new Set(['VOICE', 'SMS']) },
      ]);

      const result = await service.syncNumbers(PROVIDER_ID);

      expect(result.added).toEqual([]);
      expect(result.removed).toEqual(['+14155555678']);
      expect(result.total).toBe(1);

      const nums = dbHelper.getNumbers();
      expect(nums.find((n) => n.number === '+14155555678')!.is_active).toBe(false);
    });

    it('should reactivate previously removed numbers', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: 'Personal', added_at: new Date(), is_active: false, last_used_at: null },
      ]);

      (mockProviderInstance.listNumbers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { number: '+14155551234', capabilities: new Set(['VOICE', 'SMS']) },
      ]);

      const result = await service.syncNumbers(PROVIDER_ID);

      expect(result.added).toEqual(['+14155551234']);
      expect(dbHelper.getNumbers()[0].is_active).toBe(true);
    });

    // TODO: DB mock missing onConflict method. See #18
    it.skip('should broadcast numbers_changed event when changes occur', async () => {
      (mockProviderInstance.listNumbers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { number: '+14155551234', capabilities: new Set(['VOICE', 'SMS']) },
      ]);

      await service.syncNumbers(PROVIDER_ID);

      expect(broadcastEvents).toHaveLength(1);
      expect(broadcastEvents[0].type).toBe('numbers_changed');
    });

    it('should not broadcast when no changes occur', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: 'Personal', added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      (mockProviderInstance.listNumbers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { number: '+14155551234', capabilities: new Set(['VOICE', 'SMS']) },
      ]);

      await service.syncNumbers(PROVIDER_ID);

      expect(broadcastEvents).toHaveLength(0);
    });

    it('should throw error for non-existent provider', async () => {
      await expect(service.syncNumbers('non-existent')).rejects.toThrow('Provider non-existent not found in registry');
    });

    it('should throw ProviderUnavailableError when provider has no instance', async () => {
      const entries = new Map<string, ProviderRegistryEntry>();
      entries.set('unavailable-provider', {
        id: 'unavailable-provider',
        type: 'dummy',
        displayName: 'Unavailable Provider',
        config: {},
        enabled: true,
        instance: null,
        status: 'unavailable',
      });

      const registry = createMockRegistry(entries);
      const svc = new NumberManagementService(dbHelper.mockDb, registry, broadcast);

      await expect(svc.syncNumbers('unavailable-provider')).rejects.toThrow(ProviderUnavailableError);
    });
  });

  describe('getNumbers', () => {
    it('should return active numbers with provider context', async () => {
      const now = new Date();
      dbHelper.setNumbers([
        { number: '+14155551111', provider_id: PROVIDER_ID, label: 'A', added_at: new Date(), is_active: true, last_used_at: new Date(now.getTime() - 60000) },
        { number: '+14155552222', provider_id: PROVIDER_ID, label: 'B', added_at: new Date(), is_active: true, last_used_at: now },
        { number: '+14155553333', provider_id: PROVIDER_ID, label: 'C', added_at: new Date(), is_active: false, last_used_at: null },
      ]);

      const numbers = await service.getNumbers();

      // Only active numbers
      expect(numbers).toHaveLength(2);
      // Most recently used first
      expect(numbers[0].number).toBe('+14155552222');
      expect(numbers[1].number).toBe('+14155551111');
      // Provider context included
      expect(numbers[0].provider_id).toBe(PROVIDER_ID);
      expect(numbers[0].provider_display_name).toBe(PROVIDER_DISPLAY_NAME);
    });

    it('should return empty array when no active numbers', async () => {
      dbHelper.setNumbers([]);
      const numbers = await service.getNumbers();
      expect(numbers).toEqual([]);
    });
  });

  describe('updateLabel', () => {
    it('should update label for an active number', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: null, added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      const result = await service.updateLabel('+14155551234', 'Personal');

      expect(result.success).toBe(true);
      expect(dbHelper.getNumbers()[0].label).toBe('Personal');
    });

    it('should broadcast number_label_updated event on success', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: null, added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      await service.updateLabel('+14155551234', 'Work');

      expect(broadcastEvents).toHaveLength(1);
      expect(broadcastEvents[0]).toEqual({
        type: 'number_label_updated',
        number: '+14155551234',
        label: 'Work',
      });
    });

    it('should reject empty label', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: null, added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      const result = await service.updateLabel('+14155551234', '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject label longer than 30 characters', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: null, added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      const result = await service.updateLabel('+14155551234', 'A'.repeat(31));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error for non-existent number', async () => {
      dbHelper.setNumbers([]);

      const result = await service.updateLabel('+19999999999', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Number not found or inactive');
    });

    it('should return error for inactive number', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: null, added_at: new Date(), is_active: false, last_used_at: null },
      ]);

      const result = await service.updateLabel('+14155551234', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Number not found or inactive');
    });
  });

  describe('getDefaultNumber', () => {
    it('should return null when no active numbers exist', async () => {
      dbHelper.setNumbers([]);
      const result = await service.getDefaultNumber();
      expect(result).toBeNull();
    });

    it('should auto-select the only number when one exists', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: 'Only Number', added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      const result = await service.getDefaultNumber();

      expect(result).not.toBeNull();
      expect(result!.number).toBe('+14155551234');
      expect(result!.provider_id).toBe(PROVIDER_ID);
    });

    it('should return most recently used number when multiple exist', async () => {
      const now = new Date();
      dbHelper.setNumbers([
        { number: '+14155551111', provider_id: PROVIDER_ID, label: 'A', added_at: new Date(now.getTime() - 100000), is_active: true, last_used_at: new Date(now.getTime() - 60000) },
        { number: '+14155552222', provider_id: PROVIDER_ID, label: 'B', added_at: new Date(now.getTime() - 200000), is_active: true, last_used_at: now },
        { number: '+14155553333', provider_id: PROVIDER_ID, label: 'C', added_at: new Date(now.getTime() - 300000), is_active: true, last_used_at: new Date(now.getTime() - 120000) },
      ]);

      const result = await service.getDefaultNumber();

      expect(result).not.toBeNull();
      expect(result!.number).toBe('+14155552222');
    });

    it('should return first added number when none have been used', async () => {
      const now = new Date();
      dbHelper.setNumbers([
        { number: '+14155552222', provider_id: PROVIDER_ID, label: 'B', added_at: new Date(now.getTime() - 50000), is_active: true, last_used_at: null },
        { number: '+14155551111', provider_id: PROVIDER_ID, label: 'A', added_at: new Date(now.getTime() - 100000), is_active: true, last_used_at: null },
      ]);

      const result = await service.getDefaultNumber();

      expect(result).not.toBeNull();
      expect(result!.number).toBe('+14155551111');
    });
  });

  describe('markNumberUsed', () => {
    it('should update last_used_at for an active number', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: 'Test', added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      const result = await service.markNumberUsed('+14155551234');

      expect(result).toBe(true);
      expect(dbHelper.getNumbers()[0].last_used_at).not.toBeNull();
    });

    it('should return false for non-existent number', async () => {
      dbHelper.setNumbers([]);
      const result = await service.markNumberUsed('+19999999999');
      expect(result).toBe(false);
    });

    it('should return false for inactive number', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: 'Test', added_at: new Date(), is_active: false, last_used_at: null },
      ]);

      const result = await service.markNumberUsed('+14155551234');
      expect(result).toBe(false);
    });
  });

  describe('getProviderForNumber', () => {
    it('should return the provider entry for an active number', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: null, added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      const entry = await service.getProviderForNumber('+14155551234');

      expect(entry).not.toBeNull();
      expect(entry!.id).toBe(PROVIDER_ID);
      expect(entry!.displayName).toBe(PROVIDER_DISPLAY_NAME);
    });

    it('should return null for non-existent number', async () => {
      dbHelper.setNumbers([]);

      const entry = await service.getProviderForNumber('+19999999999');
      expect(entry).toBeNull();
    });
  });

  describe('requireProviderForNumber', () => {
    it('should return provider entry when provider is active', async () => {
      dbHelper.setNumbers([
        { number: '+14155551234', provider_id: PROVIDER_ID, label: null, added_at: new Date(), is_active: true, last_used_at: null },
      ]);

      const entry = await service.requireProviderForNumber('+14155551234');
      expect(entry.id).toBe(PROVIDER_ID);
      expect(entry.status).toBe('active');
    });

    it('should throw ProviderUnavailableError when provider is disabled', async () => {
      const entries = new Map<string, ProviderRegistryEntry>();
      entries.set('disabled-provider', {
        id: 'disabled-provider',
        type: 'dummy',
        displayName: 'Disabled Provider',
        config: {},
        enabled: false,
        instance: null,
        status: 'disabled',
      });

      const registry = createMockRegistry(entries);
      const db = createMockDb(
        [{ number: '+14155551234', provider_id: 'disabled-provider', label: null, added_at: new Date(), is_active: true, last_used_at: null }],
        [{ id: 'disabled-provider', display_name: 'Disabled Provider' }]
      );
      const svc = new NumberManagementService(db.mockDb, registry, broadcast);

      await expect(svc.requireProviderForNumber('+14155551234')).rejects.toThrow(ProviderUnavailableError);
      await expect(svc.requireProviderForNumber('+14155551234')).rejects.toThrow(/disabled/);
    });

    it('should throw ProviderUnavailableError when provider is unavailable', async () => {
      const entries = new Map<string, ProviderRegistryEntry>();
      entries.set('unavailable-provider', {
        id: 'unavailable-provider',
        type: 'dummy',
        displayName: 'Unavailable Provider',
        config: {},
        enabled: true,
        instance: null,
        status: 'unavailable',
      });

      const registry = createMockRegistry(entries);
      const db = createMockDb(
        [{ number: '+14155551234', provider_id: 'unavailable-provider', label: null, added_at: new Date(), is_active: true, last_used_at: null }],
        [{ id: 'unavailable-provider', display_name: 'Unavailable Provider' }]
      );
      const svc = new NumberManagementService(db.mockDb, registry, broadcast);

      await expect(svc.requireProviderForNumber('+14155551234')).rejects.toThrow(ProviderUnavailableError);
      await expect(svc.requireProviderForNumber('+14155551234')).rejects.toThrow(/unavailable/i);
    });

    it('should throw error when number has no provider', async () => {
      dbHelper.setNumbers([]);

      await expect(service.requireProviderForNumber('+19999999999')).rejects.toThrow('No provider found for number');
    });
  });
});
