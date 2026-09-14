import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
  AGENT_GRANT_PURGE_CHUNK_SIZE,
  listAgentConnections,
  purgeRevokedAgentGrants,
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

const D1_MAX_BOUND_PARAMETERS = 100;

function rows(statement: StatementSync, values: SQLInputValue[]) {
  return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function createHarness() {
  const sqlite = new DatabaseSync(":memory:");
  // Foreign keys stay OFF on purpose: the purge must delete dependent rows
  // explicitly rather than relying on provider cascade/set-null actions.
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
      grant_id TEXT NOT NULL,
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
    CREATE TABLE agent_browser_handoffs (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      credential_id TEXT,
      owner_user_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      authority_revision INTEGER NOT NULL,
      encrypted_action TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_authorization_requests (
      id TEXT PRIMARY KEY,
      resource TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      status TEXT NOT NULL,
      grant_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_device_authorizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      grant_id TEXT,
      credential_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_audit_events (
      id TEXT PRIMARY KEY,
      grant_id TEXT,
      credential_id TEXT,
      owner_user_id TEXT,
      resource TEXT,
      operation_id TEXT NOT NULL,
      risk TEXT NOT NULL,
      outcome TEXT NOT NULL,
      resource_ids_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_storefront_contexts (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      cart_json TEXT NOT NULL DEFAULT '[]',
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_storefront_order_grants (
      context_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      authority_kind TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (context_id, order_id)
    );
    CREATE TABLE agent_storefront_continuations (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT
    );
  `);
  let batchCount = 0;
  let maxBoundParameters = 0;
  const statement = (query: string, values: SQLInputValue[] = []): D1Statement => {
    const execute = (): D1Result => {
      maxBoundParameters = Math.max(maxBoundParameters, values.length);
      return { results: rows(sqlite.prepare(query), values), success: true, meta: {} };
    };
    return {
      bind: (...next) => statement(query, next),
      run: async () => execute(),
      all: async () => execute(),
      raw: async () => {
        maxBoundParameters = Math.max(maxBoundParameters, values.length);
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
  };
  const binding = {
    prepare: (query: string) => statement(query),
    async batch(statements: D1Statement[]) {
      batchCount += 1;
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
    getBatchCount: () => batchCount,
    getMaxBoundParameters: () => maxBoundParameters,
  };
}

const NOW = Math.floor(Date.now() / 1000);

function grantId(seed: string): string {
  return `agr_${seed.padEnd(20, "0").slice(0, 20)}`;
}

function seedGrant(
  sqlite: DatabaseSync,
  id: string,
  input: {
    status?: "pending" | "active" | "revoked";
    resource?: "dashboard" | "storefront";
    expiresAt?: number;
    withRows?: boolean;
  } = {},
) {
  const status = input.status ?? "active";
  sqlite.prepare(`
    INSERT INTO agent_grants (
      id, kind, owner_user_id, resource, label, preset, permissions_json,
      risk_ceiling, status, expires_at, revoked_at, created_at, updated_at
    ) VALUES (?, 'pat', 'owner-1', ?, 'Agent', 'read', '[]', 'read', ?, ?, ?, ?, ?)
  `).run(
    id,
    input.resource ?? "dashboard",
    status,
    input.expiresAt ?? NOW + 3600,
    status === "revoked" ? NOW - 5 : null,
    NOW - 100,
    NOW - 100,
  );
  if (!input.withRows) return;
  const credentialId = `agc_${id.slice(4)}`;
  const contextId = `asc_${id.slice(4)}`;
  sqlite.prepare(`
    INSERT INTO agent_credentials (id, grant_id, kind, token_hash, token_hint, expires_at, created_at, updated_at)
    VALUES (?, ?, 'pat', ?, 'hint', ?, ?, ?)
  `).run(credentialId, id, `hash-${id}`, NOW + 3600, NOW - 100, NOW - 100);
  sqlite.prepare(`
    INSERT INTO agent_artifact_handles (
      id, grant_id, credential_id, resource, operation_id, r2_key, media_type,
      filename, size_bytes, sha256, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'dashboard', 'dashboard.orders.export', ?, 'text/csv',
      'orders.csv', 10, ?, 'consumed', ?, ?, ?)
  `).run(`aah_${id.slice(4)}`, id, credentialId, `agent-artifacts/${id}/object`, "a".repeat(64), NOW + 60, NOW - 100, NOW - 100);
  sqlite.prepare(`
    INSERT INTO agent_browser_handoffs (
      id, grant_id, credential_id, owner_user_id, resource, operation_id,
      authority_revision, encrypted_action, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'owner-1', 'dashboard', 'dashboard.orders.refund', 1, ?, 'active', ?, ?, ?)
  `).run(`abh_${id.slice(4)}`, id, credentialId, "x".repeat(40), NOW + 60, NOW - 100, NOW - 100);
  sqlite.prepare(`
    INSERT INTO agent_authorization_requests (id, resource, client_id, redirect_uri, status, grant_id, expires_at, created_at, updated_at)
    VALUES (?, 'dashboard', 'client', 'https://example.com/cb', 'completed', ?, ?, ?, ?)
  `).run(`aar_${id.slice(4)}`, id, NOW + 60, NOW - 100, NOW - 100);
  sqlite.prepare(`
    INSERT INTO agent_device_authorizations (id, status, grant_id, credential_id, expires_at, created_at, updated_at)
    VALUES (?, 'consumed', ?, ?, ?, ?, ?)
  `).run(`ada_${id.slice(4)}`, id, credentialId, NOW + 60, NOW - 100, NOW - 100);
  sqlite.prepare(`
    INSERT INTO agent_audit_events (id, grant_id, credential_id, owner_user_id, resource, operation_id, risk, outcome, created_at)
    VALUES (?, ?, ?, 'owner-1', 'dashboard', 'dashboard.orders.list', 'read', 'success', ?)
  `).run(`aae_${id.slice(4)}`, id, credentialId, NOW - 50);
  // An audit row that only references the credential (grant already nulled).
  sqlite.prepare(`
    INSERT INTO agent_audit_events (id, grant_id, credential_id, owner_user_id, resource, operation_id, risk, outcome, created_at)
    VALUES (?, NULL, ?, 'owner-1', 'dashboard', 'dashboard.orders.list', 'read', 'success', ?)
  `).run(`aae_c${id.slice(5)}`, credentialId, NOW - 40);
  sqlite.prepare(`
    INSERT INTO agent_storefront_contexts (id, grant_id, status, expires_at, created_at, updated_at)
    VALUES (?, ?, 'closed', ?, ?, ?)
  `).run(contextId, id, NOW + 60, NOW - 100, NOW - 100);
  sqlite.prepare(`
    INSERT INTO agent_storefront_order_grants (context_id, order_id, authority_kind, expires_at, created_at)
    VALUES (?, ?, 'created', ?, ?)
  `).run(contextId, `ord_${id.slice(4)}`, NOW + 60, NOW - 100);
  sqlite.prepare(`
    INSERT INTO agent_storefront_continuations (id, context_id, kind, status, expires_at, created_at, updated_at)
    VALUES (?, ?, 'payment', 'complete', ?, ?, ?)
  `).run(`asn_${id.slice(4)}`, contextId, NOW + 60, NOW - 100, NOW - 100);
}

function countRows(sqlite: DatabaseSync, table: string, column: string, value: string): number {
  const row = sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number };
  return row.n;
}

function grantRowCounts(sqlite: DatabaseSync, id: string) {
  const suffix = id.slice(4);
  return {
    grant: countRows(sqlite, "agent_grants", "id", id),
    credentials: countRows(sqlite, "agent_credentials", "grant_id", id),
    artifacts: countRows(sqlite, "agent_artifact_handles", "grant_id", id),
    handoffs: countRows(sqlite, "agent_browser_handoffs", "grant_id", id),
    authorizationRequests: countRows(sqlite, "agent_authorization_requests", "grant_id", id),
    deviceAuthorizations: countRows(sqlite, "agent_device_authorizations", "grant_id", id),
    auditByGrant: countRows(sqlite, "agent_audit_events", "grant_id", id),
    auditByCredential: countRows(sqlite, "agent_audit_events", "credential_id", `agc_${suffix}`),
    contexts: countRows(sqlite, "agent_storefront_contexts", "grant_id", id),
    orderGrants: countRows(sqlite, "agent_storefront_order_grants", "context_id", `asc_${suffix}`),
    continuations: countRows(sqlite, "agent_storefront_continuations", "context_id", `asc_${suffix}`),
  };
}

const FULL_ROWS = {
  grant: 1,
  credentials: 1,
  artifacts: 1,
  handoffs: 1,
  authorizationRequests: 1,
  deviceAuthorizations: 1,
  auditByGrant: 1,
  auditByCredential: 2,
  contexts: 1,
  orderGrants: 1,
  continuations: 1,
};
const NO_ROWS = Object.fromEntries(Object.keys(FULL_ROWS).map((key) => [key, 0]));

describe("purgeRevokedAgentGrants (D1 harness)", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("deletes revoked and expired grants with every dependent row, and leaves current grants intact", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const active = grantId("active");
    const pending = grantId("pending");
    const revoked = grantId("revoked");
    const expiredActive = grantId("expiredactive");
    const expiredPending = grantId("expiredpending");
    seedGrant(sqlite, active, { withRows: true });
    seedGrant(sqlite, pending, { status: "pending", withRows: true });
    seedGrant(sqlite, revoked, { status: "revoked", withRows: true });
    seedGrant(sqlite, expiredActive, { expiresAt: NOW - 1, withRows: true });
    seedGrant(sqlite, expiredPending, { status: "pending", expiresAt: NOW - 1, withRows: true });

    const purgingArtifacts: Array<{ id: string; r2Key: string }> = [];
    const onArtifactsPurging = vi.fn(async (artifacts: ReadonlyArray<{ id: string; r2Key: string }>) => {
      // Rows must still exist when the object hook runs.
      expect(countRows(harness.sqlite, "agent_artifact_handles", "grant_id", revoked)).toBe(1);
      purgingArtifacts.push(...artifacts);
    });

    const result = await purgeRevokedAgentGrants(harness.db, { onArtifactsPurging });

    expect(result).toEqual({ status: "purged", count: 3, credentials: 3, artifacts: 3 });
    expect(onArtifactsPurging).toHaveBeenCalledTimes(1);
    expect(purgingArtifacts.map((artifact) => artifact.r2Key).sort()).toEqual([
      `agent-artifacts/${expiredActive}/object`,
      `agent-artifacts/${expiredPending}/object`,
      `agent-artifacts/${revoked}/object`,
    ].sort());
    for (const id of [revoked, expiredActive, expiredPending]) {
      expect(grantRowCounts(sqlite, id)).toEqual(NO_ROWS);
    }
    for (const id of [active, pending]) {
      expect(grantRowCounts(sqlite, id)).toEqual(FULL_ROWS);
    }
    expect(harness.getBatchCount()).toBe(1);
  });

  it("honors the resource filter and reports zero when nothing matches", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const dashboardRevoked = grantId("dashrevoked");
    const storefrontRevoked = grantId("storerevoked");
    seedGrant(sqlite, dashboardRevoked, { status: "revoked", withRows: true });
    seedGrant(sqlite, storefrontRevoked, { status: "revoked", resource: "storefront", withRows: true });

    await expect(purgeRevokedAgentGrants(harness.db, { resource: "storefront" })).resolves.toEqual({
      status: "purged",
      count: 1,
      credentials: 1,
      artifacts: 1,
    });
    expect(grantRowCounts(sqlite, storefrontRevoked)).toEqual(NO_ROWS);
    expect(grantRowCounts(sqlite, dashboardRevoked)).toEqual(FULL_ROWS);

    await expect(purgeRevokedAgentGrants(harness.db, { resource: "storefront" })).resolves.toEqual({
      status: "purged",
      count: 0,
      credentials: 0,
      artifacts: 0,
    });
    expect(harness.getBatchCount()).toBe(1);
  });

  it("chunks IDs below the D1 bound-parameter limit and still purges every candidate", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const total = AGENT_GRANT_PURGE_CHUNK_SIZE * 2 + 7;
    for (let index = 0; index < total; index += 1) {
      seedGrant(sqlite, grantId(`bulk${index.toString().padStart(4, "0")}`), {
        status: index % 2 === 0 ? "revoked" : "active",
        expiresAt: index % 2 === 0 ? NOW + 3600 : NOW - 1,
      });
    }
    seedGrant(sqlite, grantId("survivor"), { withRows: true });

    const result = await purgeRevokedAgentGrants(harness.db);

    expect(result.count).toBe(total);
    expect(harness.getBatchCount()).toBe(3);
    expect(harness.getMaxBoundParameters()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect(countRows(sqlite, "agent_grants", "status", "revoked")).toBe(0);
    expect(grantRowCounts(sqlite, grantId("survivor"))).toEqual(FULL_ROWS);
  });

  it("lists `current` as pending plus active unexpired grants, matching what the purge leaves behind", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    seedGrant(sqlite, grantId("active"));
    seedGrant(sqlite, grantId("pending"), { status: "pending" });
    seedGrant(sqlite, grantId("revoked"), { status: "revoked" });
    seedGrant(sqlite, grantId("expired"), { expiresAt: NOW - 1 });

    const current = await listAgentConnections(harness.db, { page: 1, limit: 10, status: "current" });
    expect(current.connections.map((connection) => connection.id).sort()).toEqual([
      grantId("active"),
      grantId("pending"),
    ].sort());
    expect(current.pagination.total).toBe(2);

    const revoked = await listAgentConnections(harness.db, { page: 1, limit: 1, status: "revoked" });
    const expired = await listAgentConnections(harness.db, { page: 1, limit: 1, status: "expired" });
    expect(revoked.pagination.total + expired.pagination.total).toBe(2);

    await purgeRevokedAgentGrants(harness.db);
    const all = await listAgentConnections(harness.db, { page: 1, limit: 10 });
    expect(all.connections.map((connection) => connection.id).sort()).toEqual(
      current.connections.map((connection) => connection.id).sort(),
    );
  });
});
