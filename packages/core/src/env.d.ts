// packages/core/src/env.d.ts
// Ambient Cloudflare Workers Env declaration for @scalius/core.
//
// The concrete Env interface is declared in each app's own env.d.ts
// (apps/api/src/env.d.ts, apps/admin-v2/src/env.d.ts, apps/storefront/src/env.d.ts)
// with app-specific bindings. This file declares the minimal shape that
// @scalius/core actually accesses, so the package typechecks on its own.
//
// Because this is a .d.ts ambient declaration, consumers (apps) can declare
// their own Env interface that extends/merges with this one — TypeScript
// treats same-name global interfaces as declaration-merged.

/**
 * Minimal Cloudflare Workers environment bindings used by @scalius/core.
 * App-specific env.d.ts files extend this via declaration merging.
 */
interface Env {
  EMAIL?: {
    send(message: {
      to: string | { email: string; name?: string } | Array<string | { email: string; name?: string }>;
      from: string | { email: string; name?: string };
      subject: string;
      html?: string;
      text?: string;
    }): Promise<{ messageId: string }>;
  };

  // KV namespace for caching (used by orders.queue, kv-cache, cache-invalidation, etc.)
  CACHE: KVNamespace;

  // KV namespace for shared auth token caching (used by firebase/admin.ts)
  SHARED_AUTH_CACHE: KVNamespace;

  // Cloudflare Queue bindings (used by queue handlers)
  PAYMENT_EVENTS_QUEUE: Queue;
  ORDER_NOTIFICATIONS_QUEUE: Queue;
  AUTH_OTP_QUEUE: Queue;
  ORDER_INGEST_QUEUE: Queue;

  // D1 database binding
  DB: D1Database;

  // R2 storage bucket
  BUCKET: R2Bucket;

  // Secrets
  BETTER_AUTH_SECRET: string;
  FIREBASE_SERVICE_ACCOUNT_CRED_JSON?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  JWT_SECRET?: string;

  // Variables
  BETTER_AUTH_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  PROJECT_CACHE_PREFIX?: string;
  STOREFRONT_URL?: string;
  R2_PUBLIC_URL?: string;
  CDN_DOMAIN_URL?: string;

  // Allow additional bindings from apps
  [key: string]: unknown;
}
