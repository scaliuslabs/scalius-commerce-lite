import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  commitAgentGrantNarrowing,
  createCredentialGrant,
} from "./agent-access.service";

const createHarness = () => createSqliteD1Database();
const expired = Math.floor(Date.now() / 1000) - 3600;

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
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, 'Owner', 'owner@example.com')")
    .run(input.owner ?? "owner-1");
  sqlite.prepare(`
    INSERT INTO agent_grants (
      id, kind, owner_user_id, resource, label, preset, permissions_json,
      risk_ceiling, authority_revision, status, expires_at, revoked_at,
      oauth_client_id, oauth_redirect_uris_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Parent', 'full', '["agent_access.manage"]',
      'security', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agr_0123456789abcdefghij",
    kind,
    input.owner ?? "owner-1",
    input.resource ?? "dashboard",
    input.revision ?? 1,
    input.status ?? "active",
    input.expiresAt ?? now + 3600,
    (input.status ?? "active") === "revoked" ? now : null,
    kind === "oauth" ? "client-1" : null,
    kind === "oauth" ? "[]" : null,
    now - 7200,
    now - 7200,
  );
  const credentialId = input.credentialId === undefined
    ? (kind === "pat" ? "agc_0123456789abcdefghij" : null)
    : input.credentialId;
  if (credentialId) {
    sqlite.prepare(`
      INSERT INTO agent_credentials (
        id, grant_id, kind, token_hash, token_hint, expires_at, revoked_at,
        created_at, updated_at
      ) VALUES (?, 'agr_0123456789abcdefghij', 'pat', ?, 'parent-token-hint', ?, ?, ?, ?)
    `).run(
      credentialId,
      "a".repeat(64),
      input.credentialExpiresAt ?? now + 3600,
      input.credentialRevokedAt ?? null,
      now - 7200,
      now - 7200,
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
  tokenHash: "b".repeat(64),
  tokenHint: "child-token-hint",
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
    ["expired grant", { expiresAt: expired }, {}],
    ["wrong owner", {}, { ownerUserId: "owner-2" }],
    ["wrong resource", {}, { resource: "storefront" as const }],
    ["wrong credential", {}, { credentialId: "agc_wrongwrongwrongwrongwr" }],
    ["revoked credential", { credentialRevokedAt: 1 }, {}],
    ["expired credential", { credentialExpiresAt: expired }, {}],
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
