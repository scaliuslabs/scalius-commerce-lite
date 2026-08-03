// src/modules/payments/gateway-registry.ts
// Registry for payment gateways — allows dynamic discovery of available
// gateways without hardcoded if-blocks in the checkout config route.

export interface GatewayMeta {
  id: string;
  name: string;
  settingsCategory: string;
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
