import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
  commitAgentGrantNarrowing,
  createCredentialGrant,
} from "./agent-access.service";

interface D1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface D1Statement {
  bind(...values: SQLInputValue[]): D1Statement;
  run(): Promise<D1Result>;
  all(): Promise<D1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): D1Result;
}

function rows(statement: StatementSync, values: SQLInputValue[]) {
  return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function statement(sqlite: DatabaseSync, query: string, values: SQLInputValue[] = []): D1Statement {
  const execute = (): D1Result => ({
    results: rows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...next) => statement(sqlite, query, next),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const prepared = sqlite.prepare(query);
      prepared.setReturnArrays(true);
      return prepared.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = rows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createHarness() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE agent_grants (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      owner_user_id TEXT,
      resource TEXT NOT NULL,
      label TEXT NOT NULL,
      oauth_client_id TEXT,
      oauth_client_name TEXT,
      oauth_redirect_uris_json TEXT,
      preset TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      risk_ceiling TEXT NOT NULL,
      authority_revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      last_operation_id TEXT,
      revoked_by_user_id TEXT,
      revoked_reason TEXT,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_credentials (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES agent_grants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_hint TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER,
      rotated_at INTEGER,
      rotated_from_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const binding = {
    prepare: (query: string) => statement(sqlite, query),
    async batch(statements: D1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((item) => item.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return {
    sqlite,
    db: drizzle(binding, { schema }) as unknown as Database,
  };
}

function seedParent(
  sqlite: DatabaseSync,
  input: {
    kind?: "pat" | "oauth";
    status?: "active" | "revoked";
    owner?: string;
    resource?: "dashboard" | "storefront";
    revision?: number;
    expiresAt?: number;
    credentialId?: string | null;
    credentialRevokedAt?: number | null;
    credentialExpiresAt?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const kind = input.kind ?? "pat";
  sqlite.prepare(`
    INSERT INTO agent_grants (
      id, kind, owner_user_id, resource, label, preset, permissions_json,
      risk_ceiling, authority_revision, status, expires_at, revoked_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Parent', 'full', '["agent_access.manage"]',
      'security', ?, ?, ?, ?, ?, ?)
  `).run(
    "agr_0123456789abcdefghij",
    kind,
    input.owner ?? "owner-1",
    input.resource ?? "dashboard",
    input.revision ?? 1,
    input.status ?? "active",
    input.expiresAt ?? now + 3600,
    (input.status ?? "active") === "revoked" ? now : null,
    now - 10,
    now - 10,
  );
  const credentialId = input.credentialId === undefined
    ? (kind === "pat" ? "agc_0123456789abcdefghij" : null)
    : input.credentialId;
  if (credentialId) {
    sqlite.prepare(`
      INSERT INTO agent_credentials (
        id, grant_id, kind, token_hash, token_hint, expires_at, revoked_at,
        created_at, updated_at
      ) VALUES (?, 'agr_0123456789abcdefghij', 'pat', 'hash', 'hint', ?, ?, ?, ?)
    `).run(
      credentialId,
      input.credentialExpiresAt ?? now + 3600,
      input.credentialRevokedAt ?? null,
      now - 10,
      now - 10,
    );
  }
}

const selection = {
  label: "Child",
  resource: "dashboard" as const,
  preset: "read" as const,
  permissions: ["agent_access.view"],
  riskCeiling: "read" as const,
  expiresAt: new Date(Date.now() + 30 * 60_000),
};

const issued = {
  credentialId: "agc_abcdefghij0123456789",
  kind: "pat" as const,
  tokenHash: "child-hash",
  tokenHint: "child-hint",
};

describe("agent management D1 commit-time races", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  async function attemptChild(
    parent: Parameters<typeof seedParent>[1] = {},
    authority: Partial<NonNullable<Parameters<typeof createCredentialGrant>[1]["parentAuthority"]>> = {},
  ) {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedParent(sqlite, parent);
    const promise = createCredentialGrant(harness.db, {
      ownerUserId: "owner-1",
      kind: "pat",
      selection,
      issued,
      parentAuthority: {
        grantId: "agr_0123456789abcdefghij",
        credentialId: parent.kind === "oauth" ? null : "agc_0123456789abcdefghij",
        ownerUserId: "owner-1",
        resource: "dashboard",
        authorityRevision: 1,
        ...authority,
      },
    });
    return { ...harness, promise };
  }

  it("creates under an exact active PAT parent", async () => {
    const harness = await attemptChild();
    await expect(harness.promise).resolves.toMatchObject({ credentialId: issued.credentialId });
    expect(sqlite!.prepare("SELECT count(*) count FROM agent_grants").get()).toEqual({ count: 2 });
    expect(sqlite!.prepare("SELECT count(*) count FROM agent_credentials").get()).toEqual({ count: 2 });
  });

  it.each([
    ["revoked grant", { status: "revoked" as const }, {}],
    ["expired grant", { expiresAt: 1 }, {}],
    ["wrong owner", {}, { ownerUserId: "owner-2" }],
    ["wrong resource", {}, { resource: "storefront" as const }],
    ["wrong credential", {}, { credentialId: "agc_wrongwrongwrongwrongwr" }],
    ["revoked credential", { credentialRevokedAt: 1 }, {}],
    ["expired credential", { credentialExpiresAt: 1 }, {}],
    ["stale authority revision", { revision: 2 }, { authorityRevision: 1 }],
  ])("rolls back child inserts for %s", async (_label, parent, authority) => {
    const harness = await attemptChild(parent, authority);
    await expect(harness.promise).rejects.toThrow();
    expect(sqlite!.prepare("SELECT count(*) count FROM agent_grants").get()).toEqual({ count: 1 });
    expect(sqlite!.prepare("SELECT count(*) count FROM agent_credentials").get()).toEqual({ count: 1 });
  });

  it("rolls back an inactive OAuth parent without a credential", async () => {
    const harness = await attemptChild({ kind: "oauth", status: "revoked", credentialId: null });
    await expect(harness.promise).rejects.toThrow();
    expect(sqlite!.prepare("SELECT count(*) count FROM agent_grants").get()).toEqual({ count: 1 });
    expect(sqlite!.prepare("SELECT count(*) count FROM agent_credentials").get()).toEqual({ count: 0 });
  });

  it("commits one narrowing and rejects a stale concurrent revision without re-adding", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedParent(sqlite);
    const first = await commitAgentGrantNarrowing(harness.db, {
      grantId: "agr_0123456789abcdefghij",
      expectedAuthorityRevision: 1,
      label: "First narrow",
      permissions: ["agent_access.view"],
      riskCeiling: "read",
      expiresAt: new Date(Date.now() + 1200_000),
    });
    expect(first).toEqual({ authorityRevision: 2 });
    await expect(commitAgentGrantNarrowing(harness.db, {
      grantId: "agr_0123456789abcdefghij",
      expectedAuthorityRevision: 1,
      label: "Stale wider write",
      permissions: ["agent_access.view", "agent_access.manage"],
      riskCeiling: "security",
      expiresAt: new Date(Date.now() + 2400_000),
    })).rejects.toThrow("AGENT_GRANT_AUTHORITY_CHANGED");
    expect(sqlite.prepare(`
      SELECT label, permissions_json permissionsJson, risk_ceiling riskCeiling,
             authority_revision authorityRevision
      FROM agent_grants WHERE id = 'agr_0123456789abcdefghij'
    `).get()).toEqual({
      label: "First narrow",
      permissionsJson: '["agent_access.view"]',
      riskCeiling: "read",
      authorityRevision: 2,
    });
  });
});
