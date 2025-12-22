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
  // Define the type for Cloudflare environment bindings
  // This will be used by Hono
  type Env = {
    // Bindings
    ASSETS: Fetcher;
    SHARED_AUTH_CACHE: KVNamespace;

    // Secrets
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN: string;
    CLERK_SECRET_KEY: string;
    FIREBASE_SERVICE_ACCOUNT_CRED_JSON: string;
    API_TOKEN: string;
    JWT_SECRET: string;
    // ... add other secrets as needed

    // Variables
    PROJECT_CACHE_PREFIX: string;
    PUBLIC_API_BASE_URL: string;
    // ... add other vars as needed
  };
}
