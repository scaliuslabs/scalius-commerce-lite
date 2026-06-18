// src/server/hono-env.d.ts

import "@cloudflare/workers-types";
import type { Database } from "@scalius/database/client";

// Extend Hono's context variable map for type-safe c.get("db")
declare module "hono" {
  interface ContextVariableMap {
    db: Database;
    user: Record<string, unknown> & {
      id: string;
      name: string;
      email: string;
      role?: string;
      isSuperAdmin?: boolean;
      twoFactorEnabled?: boolean;
    };
    session: {
      id: string;
      twoFactorVerified?: boolean | null;
      [key: string]: unknown;
    };
    env: Env;
  }
}

declare global {
  interface CloudflareSendEmailBinding {
    send(message: {
      to: string | { email: string; name?: string } | Array<string | { email: string; name?: string }>;
      from: string | { email: string; name?: string };
      subject: string;
      html?: string;
      text?: string;
    }): Promise<{ messageId: string }>;
  }

  // Cloudflare Workers environment bindings.
  // DB, CACHE, BUCKET come from wrangler.jsonc bindings.
  // Secrets are set in the Cloudflare dashboard (or via wrangler secret put).
  type Env = {
    // Service / resource bindings
    DB: D1Database;
    CACHE: KVNamespace;
    BUCKET: R2Bucket;
    SHARED_AUTH_CACHE: KVNamespace;
    AI?: Ai;
    WidgetDesignAgent: DurableObjectNamespace;
    EMAIL?: CloudflareSendEmailBinding;

    // Cloudflare Queue bindings
    PAYMENT_EVENTS_QUEUE: Queue;
    ORDER_NOTIFICATIONS_QUEUE: Queue;
    AUTH_OTP_QUEUE: Queue;
    ORDER_INGEST_QUEUE: Queue;

    // Secrets
    BETTER_AUTH_SECRET: string;
    API_TOKEN?: string;
    JWT_SECRET?: string;
    FIREBASE_SERVICE_ACCOUNT_CRED_JSON?: string;
    CREDENTIAL_ENCRYPTION_KEY?: string;

    // Variables (set in wrangler.jsonc [vars] or dashboard)
    BETTER_AUTH_URL?: string;
    PUBLIC_API_BASE_URL?: string;
    STOREFRONT_URL?: string;
    R2_PUBLIC_URL?: string;
    CDN_DOMAIN_URL?: string;
    PURGE_URL?: string;
    PURGE_TOKEN?: string;
    PROJECT_CACHE_PREFIX?: string;
    FCM_SEND_CONCURRENCY?: string | number;
    [key: string]: unknown;
  };
}
