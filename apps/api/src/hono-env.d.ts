// apps/api/src/hono-env.d.ts
// Hono context augmentation for the API worker.
//
// The Cloudflare `Env` bindings are declared exactly once, in
// `apps/api/src/env.d.ts`. This file only augments Hono's context variable map
// and references that single global `Env`.

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
    /** The single global `Env` declared in apps/api/src/env.d.ts. */
    env: Env;
  }
}
