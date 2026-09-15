// packages/core/src/env.d.ts
// Ambient Cloudflare Workers Env declaration for @scalius/core.
//
// The authoritative Env for a deployment is declared once per Worker
// (apps/api/src/env.d.ts, apps/admin-v2/src/env.d.ts,
// apps/storefront/src/env.d.ts). This file is a strict SUBSET of those: it
// lists only the bindings @scalius/core actually reads, so the package
// typechecks on its own. Every field below must stay assignment-compatible
// with the Worker declarations.
//
// Because this is a .d.ts ambient declaration, consumers (apps) can declare
// their own Env interface that extends/merges with this one -- TypeScript
// treats same-name global interfaces as declaration-merged. Never add a
// binding here that @scalius/core does not read; add it to the owning Worker.

/**
 * Minimal Cloudflare Workers environment bindings read by @scalius/core.
 */
interface Env {
  // integrations/email/*: `context.env.EMAIL` is the Cloudflare send binding.
  EMAIL?: {
    send(message: {
      to: string | { email: string; name?: string } | Array<string | { email: string; name?: string }>;
      from: string | { email: string; name?: string };
      subject: string;
      html?: string;
      text?: string;
    }): Promise<{ messageId: string }>;
  };

  // KV namespace for caching (auth/rbac/api-protection, middleware-helper/csp-handler).
  CACHE: KVNamespace;

  // KV namespace for shared auth token caching (integrations/firebase/admin.ts).
  SHARED_AUTH_CACHE: KVNamespace;

  // Order notification fan-out (modules/orders/orders.ingest.ts).
  ORDER_NOTIFICATIONS_QUEUE: Queue;

  // Passed through to `getDb(env)` / `resolveDatabaseConfiguration(env)`.
  DB?: D1Database;

  // Installed secret used for provider credential decryption.
  CREDENTIAL_ENCRYPTION_KEY?: string;

  // Derived at Worker entry from SCALIUS_SECRET (auth/auth.ts). Never installed.
  BETTER_AUTH_SECRET: string;
  // Derived at Worker entry; HS256 key for identity handoff tokens (auth/identity-handoff.ts).
  IDENTITY_HANDOFF_SECRET?: string;

  // Resolved at Worker entry from Platform settings (auth/auth.ts reads the
  // identity handoff block and the dashboard base path).
  PLATFORM_CONFIG?: import("@scalius/shared/platform-config").PlatformConfig;

  // Resolved at Worker entry from Platform settings. Never Wrangler vars.
  // Read by middleware-helper/csp-handler.ts and notifications/orders link building.
  BETTER_AUTH_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  STOREFRONT_URL?: string;
  R2_PUBLIC_URL?: string;
  CDN_DOMAIN_URL?: string;

  // Local development only (integrations/email/settings.ts).
  LOCAL_MAILPIT_URL?: string;

  // Allow additional bindings from apps.
  [key: string]: unknown;
}
