// The seeded demo store the merchant tasks run against: the real migrations
// on the test D1, one super-admin owner with 2FA, and one agent grant per
// access level, resolved by the real principal code on every call.

import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { getAllPermissionNames } from "@scalius/core/auth/rbac/permissions";
import { resolveGrantSelection } from "@scalius/core/modules/agent-access";
import type { AgentOAuthProps } from "../types";
import { evalAuth } from "./auth-state";

export const EVAL_OWNER_ID = "00000000-0000-4000-8000-0000000e7a11";
export const EVAL_API_ORIGIN = "https://api.eval.test";

/** Operator is the spec's grant; Full and Custom record where a task needs more. */
export type EvalGrant = "operator" | "full" | "custom";

export const EVAL_GRANT_IDS: Record<EvalGrant, string> = {
  operator: "agr_evaloperator00000000",
  full: "agr_evalfullaccess000000",
  custom: "agr_evalcustomscopes0000",
};

export interface EvalStore {
  sqlite: DatabaseSync;
  db: Database;
  env: Env;
  ctx: ExecutionContext;
  /** Background work handed to waitUntil, settled between tasks. */
  settle(): Promise<void>;
  grants: Record<EvalGrant, { permissions: string[]; riskCeiling: string }>;
  useGrant(grant: EvalGrant): void;
  close(): void;
}

export function createEvalStore(): EvalStore {
  const harness = createSqliteD1Database();
  const { sqlite, db } = harness;
  const background: Promise<unknown>[] = [];
  const now = Math.floor(Date.now() / 1000);

  sqlite.prepare(`INSERT INTO user (id, name, email, email_verified, is_super_admin, two_factor_enabled, created_at, updated_at)
    VALUES (?, 'Ayesha Owner', 'owner@eval.test', 1, 1, 1, ?, ?)`).run(EVAL_OWNER_ID, now - 86_400, now - 86_400);

  const all = getAllPermissionNames();
  const selections = {
    operator: resolveGrantSelection({ resource: "dashboard", preset: "operator" }, all, "oauth"),
    full: resolveGrantSelection({ resource: "dashboard", preset: "full" }, all, "oauth"),
    // Custom is the only grant that reaches the opt-in scopes (inbox, review moderation).
    custom: resolveGrantSelection({ resource: "dashboard", preset: "custom", permissions: all, riskCeiling: "security" }, all, "oauth"),
  };
  const grants = {} as EvalStore["grants"];
  for (const [grant, selection] of Object.entries(selections) as Array<[EvalGrant, typeof selections.operator]>) {
    sqlite.prepare(`INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, oauth_client_id, oauth_redirect_uris_json,
      preset, permissions_json, risk_ceiling, authority_revision, status, expires_at, created_at, updated_at)
      VALUES (?, 'oauth', ?, 'dashboard', ?, 'eval-client', '[]', ?, ?, ?, 1, 'active', ?, ?, ?)`)
      .run(EVAL_GRANT_IDS[grant], EVAL_OWNER_ID, `Eval ${grant}`, selection.preset, JSON.stringify(selection.permissions),
        selection.riskCeiling, now + 86_400, now - 60, now - 60);
    grants[grant] = { permissions: selection.permissions, riskCeiling: selection.riskCeiling };
  }

  const env = {
    DB: harness.binding,
    PUBLIC_API_BASE_URL: EVAL_API_ORIGIN,
    STOREFRONT_URL: "https://shop.eval.test",
    BETTER_AUTH_URL: "https://admin.eval.test",
    SCALIUS_SECRET: "agent-eval-master-secret-0123456789abcdef",
    AGENT_TOKEN_PEPPER: "agent-eval-pepper",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    RL_STANDARD: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => { background.push(promise); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  return {
    sqlite,
    db,
    env,
    ctx,
    grants,
    async settle() {
      while (background.length > 0) await Promise.allSettled(background.splice(0));
    },
    useGrant(grant) {
      const props: AgentOAuthProps = {
        grantId: EVAL_GRANT_IDS[grant],
        ownerUserId: EVAL_OWNER_ID,
        resource: "dashboard",
        permissions: [...grants[grant].permissions].sort(),
        riskCeiling: grants[grant].riskCeiling as AgentOAuthProps["riskCeiling"],
        audience: [`${EVAL_API_ORIGIN}/api/v1/mcp/dashboard`],
      };
      evalAuth.props = props;
    },
    close() {
      sqlite.close();
    },
  };
}
