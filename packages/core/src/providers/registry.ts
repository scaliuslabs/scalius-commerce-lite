// packages/core/src/providers/registry.ts
// Universal provider registry.
//
// Central registry for ALL provider types (payment, email, delivery, SMS).
// Providers register themselves at module load time via registerProvider().
// Consumers retrieve providers via getProvider() or getActiveProviders().
//
// The registry is intentionally simple: a Map keyed by "type:id" strings.
// No database access, no async initialization -- just metadata + factory storage.
// Settings validation and instance creation happen lazily on first use.

import type {
  ProviderType,
  ProviderMeta,
  ProviderFactory,
  ProviderRegistration,
} from "./types";

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/** Map from "type:id" -> registration entry */
const registry = new Map<string, ProviderRegistration>();

function registryKey(type: ProviderType, id: string): string {
  return `${type}:${id}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a provider implementation.
 *
 * Call this at module load time (top-level side effect). The registry
 * stores the metadata and factory function. No instance is created until
 * getProvider() is called.
 *
 * @param meta - Static metadata describing the provider
 * @param factory - Function that creates a provider instance from settings
 *
 * @example
 * ```ts
 * registerProvider(
 *   {
 *     id: "stripe",
 *     name: "Stripe",
 *     type: "payment",
 *     version: "1.0.0",
 *     settingsSchema: stripeSettingsSchema,
 *   },
 *   (settings) => new StripePaymentProvider(settings),
 * );
 * ```
 */
export function registerProvider<TProvider, TSettings>(
  meta: ProviderMeta<TSettings>,
  factory: ProviderFactory<TProvider, TSettings>,
): void {
  const key = registryKey(meta.type, meta.id);

  if (registry.has(key)) {
    console.warn(
      `[ProviderRegistry] Overwriting existing provider: ${meta.type}/${meta.id}`,
    );
  }

  registry.set(key, {
    meta: meta as ProviderMeta<unknown>,
    factory: factory as ProviderFactory<unknown, unknown>,
  });
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Create a provider instance from validated settings.
 *
 * Looks up the registered factory for the given type+id, validates
 * the settings against the provider's Zod schema, then calls the factory.
 *
 * @param type - Provider category ("payment", "email", "delivery", "sms")
 * @param id - Provider identifier (e.g. "stripe", "resend", "pathao")
 * @param settings - Raw settings object (will be validated against the schema)
 * @returns A new provider instance
 * @throws Error if provider is not registered or settings validation fails
 */
export function getProvider<TProvider>(
  type: ProviderType,
  id: string,
  settings: unknown,
): TProvider {
  const key = registryKey(type, id);
  const registration = registry.get(key);

  if (!registration) {
    throw new Error(
      `Provider not registered: ${type}/${id}. ` +
      `Available ${type} providers: ${getRegisteredIds(type).join(", ") || "(none)"}`,
    );
  }

  // Validate settings against the provider's schema
  const parsed = registration.meta.settingsSchema.safeParse(settings);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Invalid settings for ${type}/${id}: ${issues}`,
    );
  }

  return registration.factory(parsed.data) as TProvider;
}

/**
 * Get metadata for a specific registered provider without creating an instance.
 *
 * Useful for admin UI: show available providers, their settings schemas,
 * and descriptions without needing actual credentials.
 */
export function getProviderMeta(
  type: ProviderType,
  id: string,
): ProviderMeta | undefined {
  const key = registryKey(type, id);
  return registry.get(key)?.meta;
}

/**
 * Get metadata for ALL registered providers of a given type.
 *
 * Useful for admin UI: "show me all available payment gateways" or
 * "show me all email providers I can configure".
 */
export function getRegisteredProviders(type: ProviderType): ProviderMeta[] {
  const result: ProviderMeta[] = [];
  for (const [key, reg] of registry) {
    if (key.startsWith(`${type}:`)) {
      result.push(reg.meta);
    }
  }
  return result;
}

/**
 * Get just the IDs of all registered providers of a given type.
 */
export function getRegisteredIds(type: ProviderType): string[] {
  return getRegisteredProviders(type).map((m) => m.id);
}

/**
 * Check if a specific provider is registered.
 */
export function isProviderRegistered(type: ProviderType, id: string): boolean {
  return registry.has(registryKey(type, id));
}

/**
 * Remove a provider registration. Rarely needed -- mainly for testing.
 */
export function unregisterProvider(type: ProviderType, id: string): boolean {
  return registry.delete(registryKey(type, id));
}
