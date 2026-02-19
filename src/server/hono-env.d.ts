// src/server/hono-env.d.ts

import "@cloudflare/workers-types";
import type { Database } from "@/db";

// Extend Hono's context variable map for type-safe c.get("db")
declare module "hono" {
  interface ContextVariableMap {
    db: Database;
  }
}

declare global {
  // Cloudflare Workers environment bindings.
  // DB, CACHE, BUCKET come from wrangler.jsonc bindings.
  // Secrets are set in the Cloudflare dashboard (or via wrangler secret put).
  type Env = {
    // Service / resource bindings
    ASSETS: Fetcher;
    DB: D1Database;
    CACHE: KVNamespace;
    BUCKET: R2Bucket;
    SHARED_AUTH_CACHE: KVNamespace;

    // Cloudflare Email Workers binding (optional)
    EMAIL?: SendEmail;

    // Secrets
    BETTER_AUTH_SECRET: string;
    API_TOKEN?: string;
    JWT_SECRET?: string;
    FIREBASE_SERVICE_ACCOUNT_CRED_JSON?: string;

    // Variables (set in wrangler.jsonc [vars] or dashboard)
    BETTER_AUTH_URL?: string;
    PUBLIC_API_BASE_URL?: string;
    R2_PUBLIC_URL?: string;
    CDN_DOMAIN_URL?: string;
    PURGE_URL?: string;
    PURGE_TOKEN?: string;
    PROJECT_CACHE_PREFIX?: string;
    [key: string]: unknown;
  };
}
