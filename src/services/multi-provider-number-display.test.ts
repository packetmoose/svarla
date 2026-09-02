import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NumberManagementService } from './number-management-service.js';
import type { BroadcastCallback, NumberEvent, NumberRecord } from './number-management-service.js';
import type { TelephonyProvider, ProviderNumber } from '../providers/telephony-provider.js';
import type { ProviderRegistry, ProviderRegistryEntry } from './provider-registry.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database.js';

/**
 * Multi-Provider Number Display Verification Tests
 *
 * Validates Requirements 8.1 and 8.4:
 * - 8.1: ProviderRegistry supports multiple providers simultaneously with assigned numbers
 * - 8.4: Android client displays all numbers from all providers in a unified list;
 *         user does not need to know/select which provider backs a specific number
 *
 * These tests verify that the numbers API (via NumberManagementService) returns a combined
 * unified list of numbers from all configured providers, and that the response format
 * does not require the client to differentiate between providers for display purposes.
 */

function createMockProviderInstance(providerId: string, numbers: ProviderNumber[] = []): TelephonyProvider {
  return {
    providerId,
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

function createMockRegistry(entries: Map<string, ProviderRegistryEntry>): ProviderRegistry {
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
  provider_id: string;
  label: string | null;
  color: string;
  added_at: Date;
  is_active: boolean;
  last_used_at: Date | null;
  block_inbound_calls: boolean;
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
            }),
          }),
          innerJoin: (_joinTable: string, _col1: string, _col2: string) => ({
            select: (_cols: string[]) => {
              const mapWithProvider = (arr: MockNumberRow[]) =>
                arr.map((n) => {
                  const prov = providers.find((p) => p.id === n.provider_id);
                  return { ...n, provider_display_name: prov?.display_name ?? 'Unknown' };
                });

              const buildOrderByChain = (filterFn: (n: MockNumberRow) => boolean) => {
                const getFiltered = () => numbers.filter(filterFn);

                const result: any = {
                  orderBy: (_sortCol: string, _dir: string) => {
                    const innerResult: any = {
                      orderBy: (_sortCol2: string, _dir2: string) => ({
                        execute: async () => {
                          const filtered = getFiltered();
                          filtered.sort((a, b) => {
                            const provA = providers.find((p) => p.id === a.provider_id);
                            const provB = providers.find((p) => p.id === b.provider_id);
                            const nameA = provA?.display_name ?? '';
                            const nameB = provB?.display_name ?? '';
                            if (nameA !== nameB) return nameA.localeCompare(nameB);
                            return a.number.localeCompare(b.number);
                          });
                          return mapWithProvider(filtered);
                        },
                      }),
                      execute: async () => {
                        const filtered = getFiltered();
                        filtered.sort((a, b) => {
                          if (a.last_used_at === null && b.last_used_at === null) return 0;
                          if (a.last_used_at === null) return 1;
                          if (b.last_used_at === null) return -1;
                          return new Date(b.last_used_at).getTime() - new Date(a.last_used_at).getTime();
                        });
                        return mapWithProvider(filtered);
                      },
                    };
                    return innerResult;
                  },
                  execute: async () => {
                    return mapWithProvider(getFiltered());
                  },
                };
                return result;
              };

              const selectResult: any = {
                where: (col: string, _op: string, val: unknown) => {
                  const filterFn = (n: MockNumberRow) => {
                    if (col === 'numbers.is_active') return n.is_active === val;
                    return true;
                  };
                  return buildOrderByChain(filterFn);
                },
                // getAllNumbers() calls .orderBy() directly without .where()
                orderBy: (_sortCol: string, _dir: string) => {
                  const innerResult: any = {
                    orderBy: (_sortCol2: string, _dir2: string) => ({
                      execute: async () => {
                        const filtered = [...numbers];
                        filtered.sort((a, b) => {
                          const provA = providers.find((p) => p.id === a.provider_id);
                          const provB = providers.find((p) => p.id === b.provider_id);
                          const nameA = provA?.display_name ?? '';
                          const nameB = provB?.display_name ?? '';
                          if (nameA !== nameB) return nameA.localeCompare(nameB);
                          return a.number.localeCompare(b.number);
                        });
                        return mapWithProvider(filtered);
                      },
                    }),
                    execute: async () => {
                      return mapWithProvider([...numbers]);
                    },
                  };
                  return innerResult;
                },
              };

              return selectResult;
            },
          }),
          select: (col: string | string[]) => {
            const makeWhere = (preds: Array<(n: MockNumberRow) => boolean>) => ({
              where: (fc: string, op: string, fv: unknown) =>
                makeWhere([...preds, mkPred(fc, op, fv)]),
              executeTakeFirst: async () => {
                const found = numbers.find((n) => preds.every((p) => p(n)));
                if (!found) return undefined;
                if (col === 'provider_id' || (Array.isArray(col) && col.includes('provider_id'))) {
                  return { provider_id: found.provider_id };
                }
                if (col === 'block_inbound_calls') {
                  return { block_inbound_calls: found.block_inbound_calls };
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
            onConflict: (cb: Function) => {
              // The cb receives an object with .column().doUpdateSet() chain
              // but ultimately the result needs .execute()
              const conflictBuilder = {
                column: (_col: string) => ({
                  doUpdateSet: (_vals: Record<string, unknown>) => conflictBuilder,
                }),
              };
              cb(conflictBuilder);
              return {
                execute: async () => {
                  settings[values.key as string] = values.value as string | null;
                },
              };
            },
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
              color: values.color as string ?? '#6750A4',
              added_at: new Date(),
              is_active: values.is_active as boolean,
              last_used_at: (values.last_used_at as Date | null) ?? null,
              block_inbound_calls: false,
            });
          },
        }),
      };
    }),
    updateTable: vi.fn().mockImplementation(() => ({
      set: (values: Record<string, unknown>) => ({
        where: (col: string, _op: string, val: unknown) => ({
          where: () => ({
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
          execute: async () => {
            const idx = numbers.findIndex((n) => {
              if (col === 'number') return n.number === val;
              return true;
            });
            if (idx >= 0) Object.assign(numbers[idx], values);
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
    })),
  } as unknown as Kysely<Database>;

  return { mockDb, getNumbers: () => numbers, setSettings: (s: Record<string, string | null>) => { settings = s; } };
}


describe('Multi-Provider Number Display Verification', () => {
  const VONAGE_PROVIDER_ID = 'vonage-provider-1';
  const ELKS_PROVIDER_ID = '46elks-provider-1';
  const VONAGE_DISPLAY_NAME = 'Vonage';
  const ELKS_DISPLAY_NAME = '46elks';

  let service: NumberManagementService;
  let mockRegistry: ProviderRegistry;
  let dbHelper: ReturnType<typeof createMockDb>;
  let broadcastEvents: NumberEvent[];
  let broadcast: BroadcastCallback;

  const vonageNumbers: MockNumberRow[] = [
    { number: '+14155551111', provider_id: VONAGE_PROVIDER_ID, label: 'US Office', color: '#6750A4', added_at: new Date('2024-01-01'), is_active: true, last_used_at: new Date('2024-06-01'), block_inbound_calls: false },
    { number: '+14155552222', provider_id: VONAGE_PROVIDER_ID, label: null, color: '#006B5F', added_at: new Date('2024-01-02'), is_active: true, last_used_at: null, block_inbound_calls: false },
  ];

  const elksNumbers: MockNumberRow[] = [
    { number: '+46701234567', provider_id: ELKS_PROVIDER_ID, label: 'Swedish Mobile', color: '#B5485E', added_at: new Date('2024-02-01'), is_active: true, last_used_at: new Date('2024-06-15'), block_inbound_calls: false },
    { number: '+46812345678', provider_id: ELKS_PROVIDER_ID, label: 'Stockholm Office', color: '#526E2D', added_at: new Date('2024-02-02'), is_active: true, last_used_at: new Date('2024-05-01'), block_inbound_calls: false },
  ];

  const allProviders: MockProviderRow[] = [
    { id: VONAGE_PROVIDER_ID, display_name: VONAGE_DISPLAY_NAME },
    { id: ELKS_PROVIDER_ID, display_name: ELKS_DISPLAY_NAME },
  ];

  beforeEach(() => {
    broadcastEvents = [];
    broadcast = (event) => broadcastEvents.push(event);

    const vonageInstance = createMockProviderInstance(VONAGE_PROVIDER_ID, [
      { number: '+14155551111', capabilities: new Set(['VOICE', 'SMS']) },
      { number: '+14155552222', capabilities: new Set(['VOICE']) },
    ]);

    const elksInstance = createMockProviderInstance(ELKS_PROVIDER_ID, [
      { number: '+46701234567', capabilities: new Set(['VOICE', 'SMS']) },
      { number: '+46812345678', capabilities: new Set(['VOICE', 'SMS']) },
    ]);

    const entries = new Map<string, ProviderRegistryEntry>();
    entries.set(VONAGE_PROVIDER_ID, {
      id: VONAGE_PROVIDER_ID,
      type: 'vonage',
      displayName: VONAGE_DISPLAY_NAME,
      config: {},
      enabled: true,
      instance: vonageInstance,
      status: 'active',
    });
    entries.set(ELKS_PROVIDER_ID, {
      id: ELKS_PROVIDER_ID,
      type: '46elks',
      displayName: ELKS_DISPLAY_NAME,
      config: {},
      enabled: true,
      instance: elksInstance,
      status: 'active',
    });

    mockRegistry = createMockRegistry(entries);
    dbHelper = createMockDb([...vonageNumbers, ...elksNumbers], allProviders);
    service = new NumberManagementService(dbHelper.mockDb, mockRegistry, broadcast);
  });

  describe('Requirement 8.1: Multiple providers configured simultaneously with assigned numbers', () => {
    it('should return numbers from multiple providers in a single unified list', async () => {
      const numbers = await service.getNumbers();

      // All numbers from both providers should be included
      expect(numbers.length).toBe(4);

      const numberValues = numbers.map((n) => n.number);
      expect(numberValues).toContain('+14155551111');
      expect(numberValues).toContain('+14155552222');
      expect(numberValues).toContain('+46701234567');
      expect(numberValues).toContain('+46812345678');
    });

    it('should include provider_id for each number to enable server-side routing', async () => {
      const numbers = await service.getNumbers();

      const vonageNums = numbers.filter((n) => n.provider_id === VONAGE_PROVIDER_ID);
      const elksNums = numbers.filter((n) => n.provider_id === ELKS_PROVIDER_ID);

      expect(vonageNums).toHaveLength(2);
      expect(elksNums).toHaveLength(2);
    });

    it('should include provider display name for optional context but not for selection', async () => {
      const numbers = await service.getNumbers();

      // Every number has a provider_display_name but this is informational only
      numbers.forEach((n) => {
        expect(n.provider_display_name).toBeDefined();
        expect(typeof n.provider_display_name).toBe('string');
      });

      const vonageNum = numbers.find((n) => n.number === '+14155551111');
      expect(vonageNum!.provider_display_name).toBe(VONAGE_DISPLAY_NAME);

      const elksNum = numbers.find((n) => n.number === '+46701234567');
      expect(elksNum!.provider_display_name).toBe(ELKS_DISPLAY_NAME);
    });

    it('should sync numbers independently per provider', async () => {
      // Sync Vonage numbers
      const vonageResult = await service.syncNumbers(VONAGE_PROVIDER_ID);
      expect(vonageResult.total).toBe(2);

      // Sync 46elks numbers
      const elksResult = await service.syncNumbers(ELKS_PROVIDER_ID);
      expect(elksResult.total).toBe(2);

      // Each sync only affects its own provider's numbers
      const allNumbers = await service.getNumbers();
      expect(allNumbers.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Requirement 8.4: Unified list display — user does not need to select provider', () => {
    it('should return all numbers in a flat list without provider grouping', async () => {
      const numbers = await service.getNumbers();

      // Result is a flat array, not grouped by provider
      expect(Array.isArray(numbers)).toBe(true);
      // Numbers from different providers are interleaved (sorted by last_used_at)
      // The first number should be the most recently used regardless of provider
      expect(numbers[0].number).toBe('+46701234567'); // last_used_at: 2024-06-15
      expect(numbers[0].provider_id).toBe(ELKS_PROVIDER_ID);
    });

    it('should have identical record structure for numbers from all providers', async () => {
      const numbers = await service.getNumbers();

      // Every record has exactly the same fields regardless of provider
      const expectedFields = ['number', 'provider_id', 'provider_display_name', 'label', 'color', 'added_at', 'is_active', 'last_used_at', 'block_inbound_calls'];

      numbers.forEach((n) => {
        expectedFields.forEach((field) => {
          expect(n).toHaveProperty(field);
        });
      });
    });

    it('should not expose any provider-specific identifiers that require client-side provider logic', async () => {
      const numbers = await service.getNumbers();

      numbers.forEach((n) => {
        // No Vonage-specific fields
        expect(n).not.toHaveProperty('vonageNumber');
        expect(n).not.toHaveProperty('vonageUser');
        expect(n).not.toHaveProperty('vonageNumberId');
        // No 46elks-specific fields
        expect(n).not.toHaveProperty('elksNumberId');
        expect(n).not.toHaveProperty('elksAllocated');
        // Provider ID is generic - used for server routing, not client branching
        expect(typeof n.provider_id).toBe('string');
      });
    });

    it('should resolve correct provider when making a call from any number', async () => {
      // Verify that getProviderForNumber works correctly for numbers from different providers
      const vonageEntry = await service.getProviderForNumber('+14155551111');
      expect(vonageEntry).not.toBeNull();
      expect(vonageEntry!.id).toBe(VONAGE_PROVIDER_ID);
      expect(vonageEntry!.type).toBe('vonage');

      const elksEntry = await service.getProviderForNumber('+46701234567');
      expect(elksEntry).not.toBeNull();
      expect(elksEntry!.id).toBe(ELKS_PROVIDER_ID);
      expect(elksEntry!.type).toBe('46elks');
    });

    it('should select default number from any provider without preference', async () => {
      // The default number logic picks the most recently used, regardless of provider
      const defaultNum = await service.getDefaultNumber();
      expect(defaultNum).not.toBeNull();
      // Most recently used is +46701234567 (2024-06-15) from 46elks provider
      expect(defaultNum!.number).toBe('+46701234567');
      expect(defaultNum!.provider_id).toBe(ELKS_PROVIDER_ID);
    });

    it('should allow user to set default number from any provider', async () => {
      // User can set a Vonage number as default
      const result = await service.setDefaultNumber('+14155551111');
      expect(result.success).toBe(true);

      // Now getDefaultNumber should return the Vonage number
      const defaultNum = await service.getDefaultNumber();
      expect(defaultNum).not.toBeNull();
      expect(defaultNum!.number).toBe('+14155551111');
      expect(defaultNum!.provider_id).toBe(VONAGE_PROVIDER_ID);
    });
  });

  describe('Numbers API response format for Android client', () => {
    it('should provide getAllNumbers combining numbers from all providers', async () => {
      const numbers = await service.getAllNumbers();

      // getAllNumbers returns all numbers regardless of active status
      expect(numbers.length).toBe(4);
      const providerIds = new Set(numbers.map((n) => n.provider_id));
      expect(providerIds.size).toBe(2);
      expect(providerIds.has(VONAGE_PROVIDER_ID)).toBe(true);
      expect(providerIds.has(ELKS_PROVIDER_ID)).toBe(true);
    });

    it('should preserve labels for numbers from all providers uniformly', async () => {
      const numbers = await service.getNumbers();

      const labeled = numbers.filter((n) => n.label !== null);
      const unlabeled = numbers.filter((n) => n.label === null);

      // Labels work the same regardless of provider
      expect(labeled.length).toBe(3); // US Office, Swedish Mobile, Stockholm Office
      expect(unlabeled.length).toBe(1); // +14155552222

      // Labels are just strings, no provider-specific format
      labeled.forEach((n) => {
        expect(typeof n.label).toBe('string');
        expect(n.label!.length).toBeGreaterThan(0);
      });
    });

    it('should support updating labels on numbers from any provider', async () => {
      // Update label on Vonage number
      const vonageResult = await service.updateLabel('+14155552222', 'New Label');
      expect(vonageResult.success).toBe(true);

      // Update label on 46elks number
      const elksResult = await service.updateLabel('+46701234567', 'My Swedish');
      expect(elksResult.success).toBe(true);

      // Both produce the same broadcast event format
      expect(broadcastEvents).toHaveLength(2);
      expect(broadcastEvents[0].type).toBe('number_label_updated');
      expect(broadcastEvents[1].type).toBe('number_label_updated');
    });
  });
});
