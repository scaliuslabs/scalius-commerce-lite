// packages/core/src/providers/index.ts
// Main barrel for the universal provider system.
//
// Usage:
//   import { registerProvider, getProvider, getRegisteredProviders } from "@scalius/core/providers";
//   import type { PaymentProvider } from "@scalius/core/providers/payment/types";
//   import type { EmailProvider } from "@scalius/core/providers/email/types";

// --- Universal registry ---
export {
  registerProvider,
  getProvider,
  getProviderMeta,
  getRegisteredProviders,
  getRegisteredIds,
  isProviderRegistered,
  unregisterProvider,
} from "./registry";

// --- Universal types ---
export type {
  ProviderType,
  ProviderMeta,
  ProviderLifecycle,
  ProviderFactory,
  HealthCheckResult,
} from "./types";
