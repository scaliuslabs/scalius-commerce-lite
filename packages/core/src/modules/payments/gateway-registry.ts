// src/modules/payments/gateway-registry.ts
// Registry for payment gateways — allows dynamic discovery of available
// gateways without hardcoded if-blocks in the checkout config route.

import type { Database } from "@scalius/database/client";

export interface GatewaySettingsReadOptions {
  /**
   * Public cacheable config assembly must read fresh settings from D1 because
   * the assembled response is already cached by API/storefront cache layers.
   */
  bypassMemoryCache?: boolean;
}

export interface GatewayMeta {
  id: string;
  name: string;
  settingsCategory: string;
  getSettings: (
    db: Database,
    kv?: KVNamespace,
    encryptionKey?: string,
    options?: GatewaySettingsReadOptions,
  ) => Promise<{ enabled: boolean; [key: string]: unknown } | null>;
  getPublicConfig?: (settings: Record<string, unknown>) => Record<string, unknown>;
  getCurrencies?: (localCurrency: string) => string[];
}

const registry = new Map<string, GatewayMeta>();

export function registerGateway(meta: GatewayMeta): void {
  registry.set(meta.id, meta);
}

export function getRegisteredGateways(): GatewayMeta[] {
  return Array.from(registry.values());
}

export function getGatewayMeta(id: string): GatewayMeta | undefined {
  return registry.get(id);
}
