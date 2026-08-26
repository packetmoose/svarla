/**
 * Database-backed persistence adapter for ModemGatewayWsHandler.
 *
 * Reads and writes public_key, pairing_secret, and pairing_secret_created_at
 * from the provider's config JSONB column in the providers table.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../database.js';
import type { WsHandlerPersistence } from './modem-gateway-ws-handler.js';

export class ModemGatewayDbPersistence implements WsHandlerPersistence {
  private readonly db: Kysely<Database>;
  private readonly providerId: string;

  constructor(db: Kysely<Database>, providerId: string) {
    this.db = db;
    this.providerId = providerId;
  }

  async getPublicKey(): Promise<string | null> {
    const config = await this.loadConfig();
    return (config?.public_key as string) ?? null;
  }

  async setPublicKey(key: string): Promise<void> {
    await this.updateConfigField('public_key', key);
  }

  async deletePublicKey(): Promise<void> {
    await this.updateConfigField('public_key', null);
  }

  async getPairingSecret(): Promise<string | null> {
    const config = await this.loadConfig();
    return (config?.pairing_secret as string) ?? null;
  }

  async getPairingSecretCreatedAt(): Promise<Date | null> {
    const config = await this.loadConfig();
    const raw = config?.pairing_secret_created_at as string | undefined;
    if (!raw) return null;
    const date = new Date(raw);
    return isNaN(date.getTime()) ? null : date;
  }

  async setPairingSecret(secret: string, createdAt: Date): Promise<void> {
    const config = await this.loadConfig();
    const updated = {
      ...(config ?? {}),
      pairing_secret: secret,
      pairing_secret_created_at: createdAt.toISOString(),
    };
    await this.saveConfig(updated);
  }

  async clearPairingSecret(): Promise<void> {
    const config = await this.loadConfig();
    const updated = { ...(config ?? {}) };
    delete updated.pairing_secret;
    delete updated.pairing_secret_created_at;
    await this.saveConfig(updated);
  }

  // --- Internal helpers ---

  private async loadConfig(): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .selectFrom('providers')
      .select('config')
      .where('id', '=', this.providerId)
      .executeTakeFirst();

    if (!row) return null;
    if (typeof row.config === 'string') {
      try {
        return JSON.parse(row.config) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return (row.config as Record<string, unknown>) ?? null;
  }

  private async updateConfigField(field: string, value: unknown): Promise<void> {
    const config = await this.loadConfig();
    const updated = { ...(config ?? {}), [field]: value };
    await this.saveConfig(updated);
  }

  private async saveConfig(config: Record<string, unknown>): Promise<void> {
    await this.db
      .updateTable('providers')
      .set({ config: JSON.stringify(config) })
      .where('id', '=', this.providerId)
      .execute();
  }
}
