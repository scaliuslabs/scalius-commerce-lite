export interface GatewayEnvironmentConfig {
  testMode?: unknown;
  sandbox?: unknown;
}

/**
 * New checkout config uses one provider-neutral flag. The sandbox fallback
 * keeps already-cached SSLCommerz/Polar responses truthful during rollout.
 */
export function isGatewayTestMode(gateway: GatewayEnvironmentConfig): boolean {
  if (typeof gateway.testMode === "boolean") return gateway.testMode;
  return gateway.sandbox === true;
}
