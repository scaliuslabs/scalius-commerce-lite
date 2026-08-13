import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import type { AgentPrincipal } from "./types";
import {
  claimAgentArtifact,
  createAgentArtifact,
  deleteAgentArtifactRecords,
  failClaimedAgentArtifact,
  getAgentArtifactForAuthorization,
  listAgentArtifactCleanupCandidates,
  verifyAgentArtifactBytes,
} from "./artifacts";

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
      preset TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      risk_ceiling TEXT NOT NULL,
      authority_revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_credentials (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_hint TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_artifact_handles (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      credential_id TEXT,
      resource TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      r2_key TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      failure_class TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  let prepareCount = 0;
  const binding = {
    prepare: (query: string) => {
      prepareCount += 1;
      return statement(sqlite, query);
    },
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
    getPrepareCount: () => prepareCount,
  };
}

const grantId = "agr_0123456789abcdefghij";
const credentialId = "agc_0123456789abcdefghij";

function seedAuthority(
  sqlite: DatabaseSync,
  input: {
    kind?: "pat" | "oauth";
    resource?: "dashboard" | "storefront";
    grantStatus?: "active" | "revoked";
    credentialStatus?: "active" | "revoked";
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const kind = input.kind ?? "pat";
  sqlite.prepare(`
    INSERT INTO agent_grants (
      id, kind, owner_user_id, resource, label, preset, permissions_json,
      risk_ceiling, authority_revision, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, 'owner-1', ?, 'Agent', 'read', '["agent_access.view"]',
      'read', 1, ?, ?, ?, ?)
  `).run(
    grantId,
    kind,
    input.resource ?? "dashboard",
    input.grantStatus ?? "active",
    now + 3600,
    now - 10,
    now - 10,
  );
  if (kind !== "oauth") {
    sqlite.prepare(`
      INSERT INTO agent_credentials (
        id, grant_id, kind, token_hash, token_hint, expires_at, revoked_at,
        created_at, updated_at
      ) VALUES (?, ?, 'pat', ?, 'sc_pat_...cdefghij', ?, ?, ?, ?)
    `).run(
      credentialId,
      grantId,
      "a".repeat(64),
      now + 3600,
      input.credentialStatus === "revoked" ? now : null,
      now - 10,
      now - 10,
    );
  }
}

function principal(input: Partial<AgentPrincipal> = {}): AgentPrincipal {
  return {
    kind: "agent",
    grantId,
    credentialId,
    ownerUserId: "owner-1",
    isSuperAdmin: true,
    resource: "dashboard",
    grantKind: "pat",
    preset: "read",
    permissions: new Set(["agent_access.view"]),
    riskCeiling: "read",
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 3600_000),
    ...input,
  };
}

const artifactInput = {
  grantId,
  credentialId,
  resource: "dashboard" as const,
  operationId: "dashboard.orders.export",
  mediaType: "text/csv",
  filename: "orders.csv",
  sizeBytes: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  r2Key: "agent-artifacts/one",
};

describe("agent artifact D1 authority and one-use claims", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("creates a PAT-bound handle and exposes only its authenticated API URL", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite);
    const created = await createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env);

    expect(created.artifactId).toMatch(/^aah_[A-Za-z0-9_-]{20}$/);
    expect(created.downloadUrl).toBe(`https://api.example.com/api/v1/agent-artifacts/${created.artifactId}`);
    expect(sqlite.prepare(`
      SELECT grant_id grantId, credential_id credentialId, status
      FROM agent_artifact_handles WHERE id = ?
    `).get(created.artifactId)).toEqual({ grantId, credentialId, status: "active" });
  });

  it("rolls back handle creation when the exact credential is revoked at commit", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite, { credentialStatus: "revoked" });
    await expect(createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env)).rejects.toThrow();
    expect(sqlite.prepare("SELECT count(*) count FROM agent_artifact_handles").get()).toEqual({ count: 0 });
  });

  it("allows an OAuth handle only with a null credential binding", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite, { kind: "oauth" });
    const created = await createAgentArtifact(harness.db, {
      ...artifactInput,
      credentialId: null,
    }, { PUBLIC_API_BASE_URL: "https://api.example.com" } as Env);
    expect(created.downloadUrl).toBe(
      `https://api.example.com/api/v1/mcp/dashboard/artifacts/${created.artifactId}`,
    );
    expect(sqlite.prepare("SELECT credential_id credentialId FROM agent_artifact_handles WHERE id = ?").get(
      created.artifactId,
    )).toEqual({ credentialId: null });
  });

  it("atomically permits exactly one claim and rejects replay", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite);
    const created = await createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env);
    const claims = await Promise.all([
      claimAgentArtifact(harness.db, created.artifactId, principal()),
      claimAgentArtifact(harness.db, created.artifactId, principal()),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(sqlite.prepare("SELECT status, claimed_at claimedAt FROM agent_artifact_handles").get()).toMatchObject({
      status: "consumed",
    });
    expect(await claimAgentArtifact(harness.db, created.artifactId, principal())).toBeNull();
  });

  it.each([
    ["grant revocation", "UPDATE agent_grants SET status = 'revoked' WHERE id = ?"],
    ["credential revocation", "UPDATE agent_credentials SET revoked_at = unixepoch() WHERE id = ?"],
    ["authority narrowing", "UPDATE agent_grants SET authority_revision = 2 WHERE id = ?"],
  ])("rejects a stale claim after %s between resolution and commit", async (_label, mutation) => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite);
    const created = await createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env);
    sqlite.prepare(mutation).run(mutation.includes("credential") ? credentialId : grantId);
    await expect(claimAgentArtifact(harness.db, created.artifactId, principal())).resolves.toBeNull();
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles").get()).toEqual({ status: "active" });
  });

  it("does not consume a handle for a different credential, grant, or resource", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite);
    const created = await createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env);

    await expect(claimAgentArtifact(harness.db, created.artifactId, principal({
      credentialId: "agc_wrongwrongwrongwrongwr",
    }))).resolves.toBeNull();
    await expect(claimAgentArtifact(harness.db, created.artifactId, principal({
      grantId: "agr_wrongwrongwrongwrongwr",
    }))).resolves.toBeNull();
    await expect(claimAgentArtifact(harness.db, created.artifactId, principal({
      resource: "storefront",
    }))).resolves.toBeNull();
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles").get()).toEqual({ status: "active" });
  });

  it("loads operation metadata only for the exact live artifact authority", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite);
    const created = await createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env);
    await expect(getAgentArtifactForAuthorization(
      harness.db,
      created.artifactId,
      principal(),
    )).resolves.toMatchObject({
      operationId: artifactInput.operationId,
      mediaType: "text/csv",
    });
    await expect(getAgentArtifactForAuthorization(
      harness.db,
      created.artifactId,
      principal({ credentialId: "agc_wrongwrongwrongwrongwr" }),
    )).resolves.toBeUndefined();
  });

  it("keeps a failed R2 read terminal and verifies bounded bytes", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite);
    const created = await createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env);
    const claim = await claimAgentArtifact(harness.db, created.artifactId, principal());
    expect(claim).not.toBeNull();
    await failClaimedAgentArtifact(harness.db, created.artifactId, "r2_missing");
    expect(sqlite.prepare("SELECT status, failure_class failureClass FROM agent_artifact_handles").get()).toEqual({
      status: "failed",
      failureClass: "r2_missing",
    });

    const abc = new TextEncoder().encode("abc").buffer as ArrayBuffer;
    expect(await verifyAgentArtifactBytes(artifactInput, abc)).toBeNull();
    expect(await verifyAgentArtifactBytes({ ...artifactInput, sizeBytes: 4 }, abc)).toBe("size_mismatch");
    expect(await verifyAgentArtifactBytes({ ...artifactInput, sha256: "0".repeat(64) }, abc)).toBe("digest_mismatch");
  });

  it("never bulk-deletes an active one-use handle", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedAuthority(sqlite);
    const created = await createAgentArtifact(harness.db, artifactInput, {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    } as Env);
    await expect(deleteAgentArtifactRecords(harness.db, [created.artifactId])).resolves.toBe(0);
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles WHERE id = ?").get(
      created.artifactId,
    )).toEqual({ status: "active" });
  });

  it("drains a 1,050-row tied-expiry backlog deterministically past a poison object", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const now = Math.floor(Date.now() / 1000);
    const idFor = (index: number) => `aah_${index.toString(36).padStart(20, "0")}`;
    const insert = sqlite.prepare(`
      INSERT INTO agent_artifact_handles (
        id, grant_id, credential_id, resource, operation_id, r2_key,
        media_type, filename, size_bytes, sha256, status, expires_at,
        claimed_at, failure_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'dashboard', 'dashboard.orders.export', ?,
        'text/csv', 'orders.csv', 3, ?, 'consumed', ?, ?, NULL, ?, ?)
    `);
    sqlite.exec("BEGIN");
    for (let index = 0; index < 1_050; index += 1) {
      const expiresAt = now - 300 + Math.floor(index / 10);
      insert.run(
        idFor(index),
        grantId,
        credentialId,
        `agent-artifacts/cleanup-${index}`,
        "a".repeat(64),
        expiresAt,
        expiresAt - 1,
        now - 600,
        now - 1,
      );
    }
    sqlite.exec("COMMIT");

    const poisonId = idFor(0);
    let after: { expiresAt: Date; id: string } | undefined;
    const seen: Array<{ expiresAt: Date; id: string }> = [];
    let pageCount = 0;
    const prepareCountBefore = harness.getPrepareCount();
    while (seen.length < 2_000) {
      const page = await listAgentArtifactCleanupCandidates(harness.db, {
        limit: 100,
        ...(after ? { after } : {}),
      });
      if (page.length === 0) break;
      pageCount += 1;
      seen.push(...page.map(({ expiresAt, id }) => ({ expiresAt, id })));
      const successfulIds = page
        .map(({ id }) => id)
        .filter((id) => id !== poisonId);
      for (let offset = 0; offset < successfulIds.length; offset += 90) {
        await deleteAgentArtifactRecords(
          harness.db,
          successfulIds.slice(offset, offset + 90),
        );
      }
      const last = page.at(-1)!;
      after = { expiresAt: last.expiresAt, id: last.id };
      if (page.length < 100) break;
    }

    expect(pageCount).toBe(11);
    expect(seen).toHaveLength(1_050);
    expect(seen[0]?.id).toBe(poisonId);
    for (let index = 1; index < seen.length; index += 1) {
      const previous = seen[index - 1]!;
      const current = seen[index]!;
      expect(
        current.expiresAt.getTime() > previous.expiresAt.getTime() ||
        current.expiresAt.getTime() === previous.expiresAt.getTime() && current.id > previous.id,
      ).toBe(true);
    }
    expect(sqlite.prepare("SELECT id FROM agent_artifact_handles").all()).toEqual([{ id: poisonId }]);
    expect(await listAgentArtifactCleanupCandidates(harness.db, { limit: 100 })).toEqual([
      expect.objectContaining({ id: poisonId }),
    ]);
    expect(harness.getPrepareCount() - prepareCountBefore).toBe(33);
    await expect(deleteAgentArtifactRecords(
      harness.db,
      Array.from({ length: 91 }, (_, index) => idFor(index)),
    )).rejects.toThrow("limited to 90 IDs");
  });
});
