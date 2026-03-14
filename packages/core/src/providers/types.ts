// packages/core/src/providers/types.ts
// Universal provider types for all provider categories.
//
// Every provider in the system (payment, email, delivery, SMS) shares these
// base types. The ProviderMeta describes what a provider IS (identity,
// configuration schema). The ProviderLifecycle describes what a provider DOES
// at the infrastructure level (initialize, health check, teardown).
//
// Domain-specific behavior (e.g. "send an email", "create a shipment") is
// defined in the per-category type files (email/types.ts, delivery/types.ts, etc.).

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Provider categories
// ---------------------------------------------------------------------------

/**
 * All supported provider categories.
 * Each category has its own domain-specific interface that extends ProviderLifecycle.
 */
export type ProviderType = "payment" | "email" | "delivery" | "sms";

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

/**
 * Static metadata describing a provider implementation.
 *
 * This is registered once when the provider module loads.
 * It does NOT contain runtime state or credentials.
 */
export interface ProviderMeta<TSettings = unknown> {
  /** Unique provider identifier, e.g. "stripe", "resend", "pathao" */
  id: string;

  /** Human-readable display name, e.g. "Stripe", "Resend", "Pathao Courier" */
  name: string;

  /** Which category this provider belongs to */
  type: ProviderType;

  /** Semver version of this provider implementation (not the upstream SDK) */
  version: string;

  /**
   * Zod schema that validates the settings object this provider expects.
   * Used at registration time to document what settings are required,
   * and at runtime to validate settings before passing them to the factory.
   */
  settingsSchema: z.ZodType<TSettings>;

  /** Optional description shown in admin UI */
  description?: string;
}

// ---------------------------------------------------------------------------
// Provider lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle hooks shared by all providers.
 *
 * Every domain-specific provider interface (PaymentProvider, EmailProvider, etc.)
 * extends this. Implementations should treat these as infrastructure-level
 * concerns, not business logic.
 */
export interface ProviderLifecycle {
  /**
   * Initialize the provider with validated settings.
   * Called once before the provider handles any requests.
   * Use this for: SDK client creation, token exchange, connection pooling.
   */
  initialize(settings: unknown): Promise<void>;

  /**
   * Check whether the provider is reachable and functional.
   * Should be safe to call frequently (no side effects, fast timeout).
   */
  healthCheck(): Promise<HealthCheckResult>;

  /**
   * Optional teardown. Called when the provider is being deregistered
   * or the worker is shutting down. Use for: closing connections, flushing buffers.
   */
  dispose?(): Promise<void>;
}

export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  /** Optional latency in milliseconds */
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * A factory function that creates a provider instance from validated settings.
 * The registry stores these and calls them lazily when getProvider() is invoked.
 */
export type ProviderFactory<TProvider, TSettings = unknown> = (
  settings: TSettings,
) => TProvider;

// ---------------------------------------------------------------------------
// Provider registration entry (internal)
// ---------------------------------------------------------------------------

/**
 * Internal structure stored in the registry for each registered provider.
 * Not exported directly -- consumers interact through registry functions.
 */
export interface ProviderRegistration<TProvider = unknown, TSettings = unknown> {
  meta: ProviderMeta<TSettings>;
  factory: ProviderFactory<TProvider, TSettings>;
}
