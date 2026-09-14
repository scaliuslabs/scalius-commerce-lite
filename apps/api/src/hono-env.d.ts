// src/server/hono-env.d.ts

import "@cloudflare/workers-types";
import type { Database } from "@scalius/database/client";
import type { AgentPrincipal } from "./agent-access/types";

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
      mustChangePassword?: boolean;
      mustEnrollTwoFactor?: boolean;
    };
    session: {
      id: string;
      twoFactorVerified?: boolean | null;
      [key: string]: unknown;
    };
    adminPermissions: Set<string>;
    agentPrincipal: AgentPrincipal;
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
  // Secrets are installed with `wrangler secret put`; runtime origins come from
  // the dashboard Platform settings and are composed at Worker entry.
  type Env = {
    // Service / resource bindings
    DB?: D1Database;
    CACHE: KVNamespace;
    OAUTH_KV: KVNamespace;
    BUCKET: R2Bucket;
    AGENT_ARTIFACTS: R2Bucket;
    SHARED_AUTH_CACHE: KVNamespace;
    SEARCH_RATE_LIMITER: RateLimit;
    ORDER_IP_RATE_LIMITER: RateLimit;
    ORDER_PHONE_RATE_LIMITER: RateLimit;
    AGENT_RATE_LIMITER: RateLimit;
    OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
    CHECKOUT_COORDINATOR: DurableObjectNamespace;
    EMAIL?: CloudflareSendEmailBinding;

    // Cloudflare Queue bindings
    PAYMENT_EVENTS_QUEUE: Queue;
    ORDER_NOTIFICATIONS_QUEUE: Queue;
    AUTH_OTP_QUEUE: Queue;

    // Installed secrets (`wrangler secret put`). Exactly two per deployment.
    SCALIUS_SECRET?: string;
    CREDENTIAL_ENCRYPTION_KEY?: string;

    // Optional relational provider selection (only for non-D1 deployments).
    DATABASE_PROVIDER?: "d1" | "turso" | "postgres";
    TURSO_DATABASE_URL?: string;
    TURSO_AUTH_TOKEN?: string;
    POSTGRES_DATABASE_URL?: string;
    HYPERDRIVE?: Hyperdrive;
    // Operations-only cutover switch.
    DATABASE_MIGRATION_FREEZE?: string;

    // Derived at Worker entry from SCALIUS_SECRET (src/runtime/runtime-env.ts).
    // Never installed as secrets.
    BETTER_AUTH_SECRET: string;
    JWT_SECRET?: string;
    API_TOKEN?: string;
    PURGE_TOKEN?: string;
    AGENT_TOKEN_PEPPER?: string;
    CUSTOMER_SESSION_HASH_KEY?: string;

    // Resolved at Worker entry from Platform settings (dashboard -> Settings ->
    // System -> Platform). Never Wrangler vars.
    PLATFORM_CONFIG?: import("@scalius/shared/platform-config").PlatformConfig;
    STOREFRONT_URL?: string;
    PUBLIC_API_BASE_URL?: string;
    BETTER_AUTH_URL?: string;
    R2_PUBLIC_URL?: string;
    CDN_DOMAIN_URL?: string;
    PURGE_URL?: string;
    CUSTOMER_AUTH_COOKIE_DOMAIN?: string;
    CORS_ALLOWED_ORIGINS?: string;

    // Local development only (apps/api/wrangler.local.jsonc).
    LOCAL_MAILPIT_URL?: string;
    [key: string]: unknown;
  };
}
