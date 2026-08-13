import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { splitSchemaMigrationStatements } from "../src/schema-upgrade";

const migrationPath = resolve(
  import.meta.dirname,
  "../migrations/0056_agent_access.sql",
);
const postgresMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/postgres/0056_agent_access.sql",
);

const validId = (prefix: string, fill: string) => `${prefix}${fill.repeat(20)}`;

function createPreAgentDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE user (id text PRIMARY KEY NOT NULL);
    CREATE TABLE customer_sessions (token_hash text PRIMARY KEY NOT NULL);
    CREATE TABLE orders (id text PRIMARY KEY NOT NULL);
    CREATE TABLE payment_session_attempts (id text PRIMARY KEY NOT NULL);
    CREATE TABLE scalius_schema_migrations (
      version integer PRIMARY KEY NOT NULL,
      name text NOT NULL UNIQUE,
      source_sha256 text NOT NULL
    );
    INSERT INTO user (id) VALUES ('owner');
  `);
  return database;
}

function applyAgentMigration(database: DatabaseSync): void {
  for (const statement of splitSchemaMigrationStatements(
    readFileSync(migrationPath, "utf8"),
  )) {
    database.exec(statement);
  }
}

describe("agent access authority migration", () => {
  it("creates exactly nine durable authority tables and its release identity", () => {
    const database = createPreAgentDatabase();
    try {
      applyAgentMigration(database);
      expect(database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'agent_%'
        ORDER BY name
      `).all()).toEqual([
        { name: "agent_artifact_handles" },
        { name: "agent_audit_events" },
        { name: "agent_authorization_requests" },
        { name: "agent_credentials" },
        { name: "agent_device_authorizations" },
        { name: "agent_grants" },
        { name: "agent_storefront_contexts" },
        { name: "agent_storefront_continuations" },
        { name: "agent_storefront_order_grants" },
      ]);
      expect(database.prepare(`
        SELECT version, name, source_sha256 AS sourceSha256
        FROM scalius_schema_migrations
      `).get()).toEqual({
        version: 56,
        name: "0056_agent_access",
        sourceSha256: "ca86ab76f26135b9e6ea259c40c474e6e83ef510ed7544ecb990a4fbc09d1af4",
      });
    } finally {
      database.close();
    }
  });

  it("enforces credential shape, grant metadata, JSON, and rotation invariants", () => {
    const database = createPreAgentDatabase();
    try {
      applyAgentMigration(database);
      const now = Math.floor(Date.now() / 1_000);
      const grantId = validId("agr_", "g");
      const credentialId = validId("agc_", "c");
      database.prepare(`
        INSERT INTO agent_grants (
          id, kind, owner_user_id, resource, label, preset,
          permissions_json, risk_ceiling, status, expires_at
        ) VALUES (?, 'pat', 'owner', 'dashboard', 'Automation', 'full',
          '[]', 'security', 'active', ?)
      `).run(grantId, now + 3_600);
      database.prepare(`
        INSERT INTO agent_credentials (
          id, grant_id, kind, token_hash, token_hint, expires_at
        ) VALUES (?, ?, 'pat', ?, 'sc_pat_safe_hint', ?)
      `).run(credentialId, grantId, "a".repeat(64), now + 3_600);

      expect(database.prepare(`
        SELECT authority_revision AS authorityRevision
        FROM agent_grants WHERE id = ?
      `).get(grantId)).toEqual({ authorityRevision: 1 });
      expect(() => database.prepare(`
        UPDATE agent_grants SET authority_revision = 0 WHERE id = ?
      `).run(grantId)).toThrow(/check constraint/i);

      expect(() => database.prepare(`
        INSERT INTO agent_credentials (
          id, grant_id, kind, token_hash, token_hint, expires_at
        ) VALUES ('bad', ?, 'pat', ?, 'sc_pat_safe_hint', ?)
      `).run(grantId, "b".repeat(64), now + 3_600)).toThrow(/check constraint/i);
      expect(() => database.prepare(`
        INSERT INTO agent_grants (
          id, kind, resource, label, preset, permissions_json,
          risk_ceiling, status, expires_at
        ) VALUES (?, 'pat', 'dashboard', 'Bad JSON', 'full', 'not-json',
          'security', 'active', ?)
      `).run(validId("agr_", "j"), now + 3_600)).toThrow(/malformed json|check constraint/i);
      expect(() => database.prepare(`
        UPDATE agent_credentials
        SET rotated_at = ?
        WHERE id = ?
      `).run(now, credentialId)).toThrow(/check constraint/i);
    } finally {
      database.close();
    }
  });

  it("enforces bounded single-use artifact authority and retained principals", () => {
    const database = createPreAgentDatabase();
    try {
      applyAgentMigration(database);
      const now = Math.floor(Date.now() / 1_000);
      const grantId = validId("agr_", "a");
      const credentialId = validId("agc_", "a");
      database.prepare(`
        INSERT INTO agent_grants (
          id, kind, owner_user_id, resource, label, preset,
          permissions_json, risk_ceiling, status, expires_at
        ) VALUES (?, 'pat', 'owner', 'dashboard', 'Artifact export', 'full',
          '[]', 'security', 'active', ?)
      `).run(grantId, now + 3_600);
      database.prepare(`
        INSERT INTO agent_credentials (
          id, grant_id, kind, token_hash, token_hint, expires_at
        ) VALUES (?, ?, 'pat', ?, 'sc_pat_artifact_hint', ?)
      `).run(credentialId, grantId, "a".repeat(64), now + 3_600);

      const insertArtifact = (input: {
        id: string;
        r2Key: string;
        filename?: string;
        sizeBytes?: number;
        sha256?: string;
        expiresAt?: number;
      }) => database.prepare(`
        INSERT INTO agent_artifact_handles (
          id, grant_id, credential_id, resource, operation_id, r2_key,
          media_type, filename, size_bytes, sha256, expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'dashboard', 'orders.export', ?,
          'text/csv; charset=utf-8', ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        grantId,
        credentialId,
        input.r2Key,
        input.filename ?? "orders.csv",
        input.sizeBytes ?? 1_024,
        input.sha256 ?? "b".repeat(64),
        input.expiresAt ?? now + 300,
        now,
        now,
      );

      const artifactId = validId("aah_", "h");
      const r2Key = `agent-artifacts/${grantId}/${artifactId}`;
      insertArtifact({ id: artifactId, r2Key });
      expect(database.prepare(`
        SELECT status, claimed_at AS claimedAt, failure_class AS failureClass
        FROM agent_artifact_handles WHERE id = ?
      `).get(artifactId)).toEqual({
        status: "active",
        claimedAt: null,
        failureClass: null,
      });

      expect(() => insertArtifact({ id: "bad", r2Key: "bad-id" }))
        .toThrow(/check constraint/i);
      expect(() => insertArtifact({ id: validId("aah_", "d"), r2Key }))
        .toThrow(/unique constraint/i);
      expect(() => insertArtifact({
        id: validId("aah_", "s"),
        r2Key: "bad-sha",
        sha256: "B".repeat(64),
      })).toThrow(/check constraint/i);
      expect(() => insertArtifact({
        id: validId("aah_", "f"),
        r2Key: "bad-filename",
        filename: "../orders.csv",
      })).toThrow(/check constraint/i);
      expect(() => insertArtifact({
        id: validId("aah_", "z"),
        r2Key: "too-large",
        sizeBytes: 16_777_217,
      })).toThrow(/check constraint/i);
      expect(() => insertArtifact({
        id: validId("aah_", "t"),
        r2Key: "too-long-lived",
        expiresAt: now + 301,
      })).toThrow(/check constraint/i);

      const claim = database.prepare(`
        UPDATE agent_artifact_handles
        SET status = 'consumed', claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND expires_at > ?
      `).run(now, now, artifactId, now - 1);
      expect(claim.changes).toBe(1);
      expect(database.prepare(`
        UPDATE agent_artifact_handles
        SET status = 'consumed', claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND expires_at > ?
      `).run(now, now, artifactId, now - 1).changes).toBe(0);
      database.prepare(`
        UPDATE agent_artifact_handles
        SET status = 'failed', failure_class = 'r2_missing', updated_at = ?
        WHERE id = ? AND status = 'consumed'
      `).run(now, artifactId);
      expect(database.prepare(`
        SELECT status, failure_class AS failureClass
        FROM agent_artifact_handles WHERE id = ?
      `).get(artifactId)).toEqual({ status: "failed", failureClass: "r2_missing" });

      expect(() => database.prepare(`
        UPDATE agent_artifact_handles
        SET status = 'active', failure_class = NULL WHERE id = ?
      `).run(artifactId)).toThrow(/check constraint/i);
      expect(() => database.prepare(`
        DELETE FROM agent_credentials WHERE id = ?
      `).run(credentialId)).toThrow(/foreign key constraint/i);
    } finally {
      database.close();
    }
  });

  it("enforces the OAuth completion lease and terminal cleanup state machine", () => {
    const database = createPreAgentDatabase();
    try {
      applyAgentMigration(database);
      const now = Math.floor(Date.now() / 1_000);
      const grantId = validId("agr_", "o");
      const requestId = validId("aar_", "r");
      database.prepare(`
        INSERT INTO agent_grants (
          id, kind, owner_user_id, resource, label, oauth_client_id,
          oauth_client_name, oauth_redirect_uris_json, preset,
          permissions_json, risk_ceiling, status, expires_at
        ) VALUES (?, 'oauth', 'owner', 'dashboard', 'OAuth consent',
          'oauth-client', 'OAuth client', '["https://client.example/callback"]',
          'full', '[]', 'security', 'active', ?)
      `).run(grantId, now + 3_600);
      database.prepare(`
        INSERT INTO agent_authorization_requests (
          id, encrypted_request, resource, client_id, redirect_uri, expires_at
        ) VALUES (?, 'sealed-request', 'dashboard', 'oauth-client',
          'https://client.example/callback', ?)
      `).run(requestId, now + 600);

      expect(() => database.prepare(`
        INSERT INTO agent_authorization_requests (
          id, resource, client_id, redirect_uri, expires_at
        ) VALUES (?, 'dashboard', 'oauth-client',
          'https://client.example/callback', ?)
      `).run(validId("aar_", "p"), now + 600)).toThrow(/check constraint/i);

      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'approved', decided_by_user_id = 'owner',
          decided_at = ?, grant_id = ?, updated_at = ?
        WHERE id = ?
      `).run(now, grantId, now, requestId);
      expect(() => database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'completing', updated_at = ?
        WHERE id = ?
      `).run(now, requestId)).toThrow(/check constraint/i);
      expect(() => database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'completing', completion_claim_hash = ?,
          completion_claim_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run("x".repeat(63), now + 60, now, requestId)).toThrow(/check constraint/i);
      expect(() => database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'completing', completion_claim_hash = ?,
          completion_claim_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run("x".repeat(64), now + 60, now + 60, requestId)).toThrow(/check constraint/i);

      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'completing', completion_claim_hash = ?,
          completion_claim_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run("x".repeat(64), now + 60, now, requestId);
      expect(() => database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now + 1, now + 1, requestId)).toThrow(/check constraint/i);

      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'approved', completion_claim_hash = NULL,
          completion_claim_expires_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now + 1, requestId);
      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'completing', completion_claim_hash = ?,
          completion_claim_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run("y".repeat(64), now + 61, now + 1, requestId);
      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'completed', encrypted_request = NULL,
          completion_claim_hash = NULL, completion_claim_expires_at = NULL,
          completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now + 2, now + 2, requestId);
      expect(database.prepare(`
        SELECT status, encrypted_request AS encryptedRequest,
          completion_claim_hash AS completionClaimHash,
          completion_claim_expires_at AS completionClaimExpiresAt,
          completed_at AS completedAt
        FROM agent_authorization_requests WHERE id = ?
      `).get(requestId)).toEqual({
        status: "completed",
        encryptedRequest: null,
        completionClaimHash: null,
        completionClaimExpiresAt: null,
        completedAt: now + 2,
      });

      const expiredRequestId = validId("aar_", "e");
      database.prepare(`
        INSERT INTO agent_authorization_requests (
          id, encrypted_request, resource, client_id, redirect_uri, expires_at
        ) VALUES (?, 'sealed-request', 'dashboard', 'oauth-client',
          'https://client.example/callback', ?)
      `).run(expiredRequestId, now + 600);
      expect(() => database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'expired', decided_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, expiredRequestId)).toThrow(/check constraint/i);
      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'expired', encrypted_request = NULL,
          decided_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, expiredRequestId);

      const deniedRequestId = validId("aar_", "d");
      database.prepare(`
        INSERT INTO agent_authorization_requests (
          id, encrypted_request, resource, client_id, redirect_uri, expires_at
        ) VALUES (?, 'sealed-request', 'dashboard', 'oauth-client',
          'https://client.example/callback', ?)
      `).run(deniedRequestId, now + 600);
      expect(() => database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'denied', decided_by_user_id = 'owner',
          decided_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, deniedRequestId)).toThrow(/check constraint/i);
      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'denying',
          decided_by_user_id = 'owner', decided_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, deniedRequestId);
      expect(database.prepare(`
        SELECT status, encrypted_request AS encryptedRequest,
          completion_claim_hash AS completionClaimHash
        FROM agent_authorization_requests WHERE id = ?
      `).get(deniedRequestId)).toEqual({
        status: "denying",
        encryptedRequest: "sealed-request",
        completionClaimHash: null,
      });
      expect(() => database.prepare(`
        UPDATE agent_authorization_requests
        SET completion_claim_hash = ?, updated_at = ?
        WHERE id = ?
      `).run("z".repeat(64), now, deniedRequestId)).toThrow(/check constraint/i);

      database.prepare(`
        UPDATE agent_authorization_requests
        SET completion_claim_hash = ?, completion_claim_expires_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run("z".repeat(64), now + 1, now, deniedRequestId);
      database.prepare(`
        UPDATE agent_authorization_requests
        SET completion_claim_hash = NULL, completion_claim_expires_at = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(now + 1, deniedRequestId);
      database.prepare(`
        UPDATE agent_authorization_requests
        SET completion_claim_hash = ?, completion_claim_expires_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run("w".repeat(64), now + 62, now + 2, deniedRequestId);
      database.prepare(`
        UPDATE agent_authorization_requests
        SET status = 'denied', encrypted_request = NULL,
          completion_claim_hash = NULL, completion_claim_expires_at = NULL,
          completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now + 3, now + 3, deniedRequestId);
      expect(database.prepare(`
        SELECT id, status, encrypted_request AS encryptedRequest,
          completed_at AS completedAt
        FROM agent_authorization_requests
        WHERE id IN (?, ?)
        ORDER BY id
      `).all(deniedRequestId, expiredRequestId)).toEqual([
        {
          id: deniedRequestId,
          status: "denied",
          encryptedRequest: null,
          completedAt: now + 3,
        },
        {
          id: expiredRequestId,
          status: "expired",
          encryptedRequest: null,
          completedAt: null,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("enforces storefront revision, cart bounds, lifecycle, and authority kinds", () => {
    const database = createPreAgentDatabase();
    try {
      applyAgentMigration(database);
      const now = Math.floor(Date.now() / 1_000);
      const grantId = validId("agr_", "s");
      const contextId = validId("asc_", "x");
      database.prepare(`
        INSERT INTO agent_grants (
          id, kind, owner_user_id, resource, label, preset,
          permissions_json, risk_ceiling, status, expires_at
        ) VALUES (?, 'pat', 'owner', 'storefront', 'Storefront', 'full',
          '[]', 'security', 'active', ?)
      `).run(grantId, now + 3_600);
      database.prepare(`
        INSERT INTO agent_storefront_contexts (id, grant_id, expires_at)
        VALUES (?, ?, ?)
      `).run(contextId, grantId, now + 3_600);

      const oneHundredLines = JSON.stringify(Array.from(
        { length: 100 },
        (_, index) => ({ variantId: `variant-${index}`, quantity: 1 }),
      ));
      expect(() => database.prepare(`
        UPDATE agent_storefront_contexts SET cart_json = ? WHERE id = ?
      `).run(oneHundredLines, contextId)).toThrow(/check constraint/i);
      expect(() => database.prepare(`
        UPDATE agent_storefront_contexts SET revision = 0 WHERE id = ?
      `).run(contextId)).toThrow(/check constraint/i);
      expect(() => database.prepare(`
        UPDATE agent_storefront_contexts SET status = 'closed' WHERE id = ?
      `).run(contextId)).toThrow(/check constraint/i);

      const continuationId = validId("acn_", "b");
      const bootstrapHash = "c".repeat(64);
      database.prepare(`
        INSERT INTO agent_storefront_continuations (
          id, context_id, kind, status, expires_at, bootstrap_code_hash,
          created_at, updated_at
        ) VALUES (?, ?, 'customer_auth', 'pending', ?, ?, ?, ?)
      `).run(continuationId, contextId, now + 300, bootstrapHash, now, now);
      expect(() => database.prepare(`
        INSERT INTO agent_storefront_continuations (
          id, context_id, kind, status, expires_at, bootstrap_code_hash,
          created_at, updated_at
        ) VALUES (?, ?, 'customer_auth', 'pending', ?, ?, ?, ?)
      `).run(
        validId("acn_", "u"), contextId, now + 300,
        bootstrapHash.toUpperCase(), now, now,
      )).toThrow(/check constraint/i);

      const claim = database.prepare(`
        UPDATE agent_storefront_continuations
        SET bootstrap_code_hash = NULL, bootstrap_claimed_at = ?, updated_at = ?
        WHERE id = ? AND context_id = ? AND status = 'pending'
          AND expires_at > ? AND bootstrap_code_hash = ?
      `).run(now + 1, now + 1, continuationId, contextId, now, bootstrapHash);
      expect(claim.changes).toBe(1);
      expect(database.prepare(`
        UPDATE agent_storefront_continuations
        SET bootstrap_code_hash = NULL, bootstrap_claimed_at = ?, updated_at = ?
        WHERE id = ? AND context_id = ? AND status = 'pending'
          AND expires_at > ? AND bootstrap_code_hash = ?
      `).run(now + 2, now + 2, continuationId, contextId, now, bootstrapHash).changes)
        .toBe(0);
      expect(() => database.prepare(`
        UPDATE agent_storefront_continuations
        SET status = 'complete', completed_at = ?, safe_result_json = '{}',
          bootstrap_code_hash = ?, updated_at = ?
        WHERE id = ?
      `).run(now + 2, bootstrapHash, now + 2, continuationId))
        .toThrow(/check constraint/i);
      database.prepare(`
        UPDATE agent_storefront_continuations
        SET status = 'complete', completed_at = ?, safe_result_json = '{}',
          bootstrap_code_hash = NULL, updated_at = ?
        WHERE id = ?
      `).run(now + 2, now + 2, continuationId);
      expect(database.prepare(`
        SELECT status, bootstrap_code_hash AS bootstrapCodeHash,
          bootstrap_claimed_at AS bootstrapClaimedAt
        FROM agent_storefront_continuations WHERE id = ?
      `).get(continuationId)).toEqual({
        status: "complete",
        bootstrapCodeHash: null,
        bootstrapClaimedAt: now + 1,
      });

      database.exec("INSERT INTO orders (id) VALUES ('order-1')");
      expect(() => database.prepare(`
        INSERT INTO agent_storefront_order_grants (
          context_id, order_id, authority_kind, expires_at
        ) VALUES (?, 'order-1', 'arbitrary', ?)
      `).run(contextId, now + 3_600)).toThrow(/check constraint/i);
    } finally {
      database.close();
    }
  });

  it("keeps the PostgreSQL sidecar native and structurally equivalent", () => {
    const sqlite = splitSchemaMigrationStatements(
      readFileSync(migrationPath, "utf8"),
    );
    const postgresSource = readFileSync(postgresMigrationPath, "utf8");
    const postgres = splitSchemaMigrationStatements(postgresSource);

    expect(sqlite).toHaveLength(46);
    expect(postgres).toHaveLength(46);
    expect(sqlite.filter((statement) => /^CREATE TABLE/i.test(statement))).toHaveLength(9);
    expect(postgres.filter((statement) => /^CREATE TABLE/i.test(statement))).toHaveLength(9);
    expect(postgresSource).not.toMatch(/json_valid|json_type\(|json_array_length|strftime|\?/i);
    expect(postgresSource).toContain("jsonb_typeof");
    expect(postgresSource).toContain("jsonb_array_length");
    expect(postgresSource).toContain("extract(epoch from now())::bigint");
    expect(postgres.at(-1)?.replaceAll('"', "").replace(/\s+/g, " "))
      .toContain("VALUES (56, '0056_agent_access', 'ca86ab76f26135b9e6ea259c40c474e6e83ef510ed7544ecb990a4fbc09d1af4')");
  });
});
