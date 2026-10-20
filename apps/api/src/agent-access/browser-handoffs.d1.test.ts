import type { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { AgentPrincipal } from "./types";
import {
  claimAgentBrowserHandoff,
  createAgentBrowserHandoff,
  expireAgentBrowserHandoffs,
} from "./browser-handoffs";
import {
  decideAgentApproval,
  readAgentApproval,
  redeemAgentApproval,
  requestAgentApproval,
} from "./approvals";

const harness = () => createSqliteD1Database();

const grantId = "agr_0123456789abcdefghij";
const credentialId = "agc_0123456789abcdefghij";
const ownerUserId = "owner-1";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const env = {
  BETTER_AUTH_URL: "https://dashboard.example.test",
  PUBLIC_API_BASE_URL: "https://api.example.test",
  STOREFRONT_URL: "https://shop.example.test",
  CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
} as Env;
const action = {
  url: "https://shop.example.test/theme-preview/continue",
  method: "POST" as const,
  fields: {
    continuationCode: `tpc_${"x".repeat(48)}`,
    path: "/products/example",
    device: "desktop",
  },
};

function seed(sqlite: DatabaseSync, kind: "pat" | "oauth" = "pat") {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, 'Owner', 'owner@example.test')").run(ownerUserId);
  sqlite.prepare(`
    INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, oauth_client_id, oauth_redirect_uris_json,
      preset, risk_ceiling, authority_revision, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'dashboard', 'Agent', ?, ?, 'full', 'security', 1, 'active', ?, ?, ?)
  `).run(grantId, kind, ownerUserId, kind === "oauth" ? "client-1" : null, kind === "oauth" ? "[]" : null, now + 3600, now - 600, now - 600);
  if (kind === "pat") {
    sqlite.prepare(`
      INSERT INTO agent_credentials (id, grant_id, kind, token_hash, token_hint, expires_at, created_at, updated_at)
      VALUES (?, ?, 'pat', ?, 'sc_pat_...hint', ?, ?, ?)
    `).run(credentialId, grantId, "a".repeat(64), now + 3600, now - 600, now - 600);
  }
}

function principal(kind: "pat" | "oauth" = "pat"): AgentPrincipal {
  return {
    kind: "agent",
    grantId,
    credentialId: kind === "oauth" ? null : credentialId,
    ownerUserId,
    isSuperAdmin: true,
    resource: "dashboard",
    grantKind: kind,
    preset: "full",
    permissions: new Set(["settings.general.view"]),
    riskCeiling: "security",
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 3600_000),
  };
}

describe("agent browser handoff relational authority", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("stores only encrypted fields and returns a non-secret authenticated URL", async () => {
    const test = harness();
    sqlite = test.sqlite;
    seed(sqlite);
    const created = await createAgentBrowserHandoff(
      test.db,
      principal(),
      "dashboard.theme.preview_session_create",
      action,
      env,
    );
    expect(created.url).toBe(
      `https://dashboard.example.test/admin/settings/agent-access/continue/${created.handoffId}`,
    );
    const row = sqlite.prepare("SELECT encrypted_action encryptedAction FROM agent_browser_handoffs").get() as {
      encryptedAction: string;
    };
    expect(row.encryptedAction).toMatch(/^enc:/);
    expect(row.encryptedAction).not.toContain(action.fields.continuationCode);
    expect(created.url).not.toContain("continuationCode");
  });

  it("rejects actions outside the configured storefront origin", async () => {
    const test = harness();
    sqlite = test.sqlite;
    seed(sqlite);
    await expect(createAgentBrowserHandoff(
      test.db,
      principal(),
      "dashboard.theme.preview_session_create",
      { ...action, url: "https://attacker.example/continue" },
      env,
    )).rejects.toThrow(/invalid/i);
  });

  it("permits exactly one same-owner claim and rejects replay", async () => {
    const test = harness();
    sqlite = test.sqlite;
    seed(sqlite);
    const created = await createAgentBrowserHandoff(
      test.db,
      principal(),
      "dashboard.theme.preview_session_create",
      action,
      env,
    );
    const claims = await Promise.all([
      claimAgentBrowserHandoff(test.db, created.handoffId, ownerUserId, env),
      claimAgentBrowserHandoff(test.db, created.handoffId, ownerUserId, env),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.action).toEqual(action);
    expect(await claimAgentBrowserHandoff(test.db, created.handoffId, ownerUserId, env)).toBeNull();
  });

  it("denies the wrong browser identity and a narrowed or revoked authority", async () => {
    const test = harness();
    sqlite = test.sqlite;
    seed(sqlite);
    const created = await createAgentBrowserHandoff(
      test.db,
      principal(),
      "dashboard.theme.preview_session_create",
      action,
      env,
    );
    expect(await claimAgentBrowserHandoff(test.db, created.handoffId, "owner-2", env)).toBeNull();
    sqlite.exec("UPDATE agent_grants SET authority_revision = 2");
    expect(await claimAgentBrowserHandoff(test.db, created.handoffId, ownerUserId, env)).toBeNull();
  });

  it("supports OAuth null-credential binding and bounded expiry cleanup", async () => {
    const test = harness();
    sqlite = test.sqlite;
    seed(sqlite, "oauth");
    const created = await createAgentBrowserHandoff(
      test.db,
      principal("oauth"),
      "dashboard.theme.preview_session_create",
      action,
      env,
    );
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("UPDATE agent_browser_handoffs SET created_at = ?, expires_at = ? WHERE id = ?")
      .run(now - 60, now - 1, created.handoffId);
    expect(await expireAgentBrowserHandoffs(test.db)).toBe(1);
    expect(sqlite.prepare("SELECT count(*) count FROM agent_browser_handoffs").get())
      .toEqual({ count: 0 });
  });

  it("drains expired handoffs in deterministic bounded pages", async () => {
    const test = harness();
    sqlite = test.sqlite;
    seed(sqlite, "oauth");
    const now = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(`
      INSERT INTO agent_browser_handoffs (
        id, grant_id, credential_id, owner_user_id, resource, operation_id,
        authority_revision, encrypted_action, status, expires_at, consumed_at,
        created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'dashboard', 'dashboard.theme.preview_session_create',
        1, ?, 'active', ?, NULL, ?, ?)
    `);
    for (let index = 0; index < 2_050; index += 1) {
      insert.run(
        `abh_${index.toString().padStart(20, "0")}`,
        grantId,
        ownerUserId,
        `enc:${"x".repeat(60)}`,
        now - 1,
        now - 301,
        now - 301,
      );
    }
    insert.run(
      "abh_active00000000000000",
      grantId,
      ownerUserId,
      `enc:${"x".repeat(60)}`,
      now + 299,
      now,
      now,
    );

    expect(await expireAgentBrowserHandoffs(test.db)).toBe(2_000);
    expect(await expireAgentBrowserHandoffs(test.db)).toBe(50);
    expect(await expireAgentBrowserHandoffs(test.db)).toBe(0);
    expect(sqlite.prepare("SELECT id FROM agent_browser_handoffs").all()).toEqual([
      { id: "abh_active00000000000000" },
    ]);
  });

  describe("approvals of gated agent changes (audit R2 F3)", () => {
    const request = (db: Parameters<typeof requestAgentApproval>[0], who = principal()) =>
      requestAgentApproval(db, env, who, { binding: "b".repeat(64), summary: "Process order refund: id=ord_1, amount=500", operationIds: ["dashboard.orders.refund"] });

    it("is never claimable as a browser continuation", async () => {
      const test = harness();
      sqlite = test.sqlite;
      seed(sqlite);
      const link = await request(test.db);
      expect(link.approvalUrl).toBe(`https://dashboard.example.test/admin/settings/agent-access/approve/${link.approvalId}`);
      expect(await claimAgentBrowserHandoff(test.db, link.approvalId, ownerUserId, env)).toBeNull();
      expect(await readAgentApproval(test.db, env, link.approvalId, ownerUserId)).toMatchObject({ status: "pending", summary: expect.stringContaining("amount=500") });
      expect(await readAgentApproval(test.db, env, link.approvalId, "owner-2")).toBeNull();
    });

    it("cannot be approved once the grant is revoked or expired", async () => {
      const test = harness();
      sqlite = test.sqlite;
      seed(sqlite);
      const link = await request(test.db);
      sqlite.prepare("UPDATE agent_grants SET expires_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 1, grantId);
      expect(await decideAgentApproval(test.db, link.approvalId, ownerUserId, "approve")).toBe(false);
    });

    it("is redeemed only by the same grant, credential and authority revision, once", async () => {
      const test = harness();
      sqlite = test.sqlite;
      seed(sqlite);
      const link = await request(test.db);
      expect(await decideAgentApproval(test.db, link.approvalId, ownerUserId, "approve")).toBe(true);
      await expect(redeemAgentApproval(test.db, env, { ...principal(), authorityRevision: 2 }, link.approvalId, "b".repeat(64)))
        .rejects.toMatchObject({ code: "approval_invalid" });
      await expect(redeemAgentApproval(test.db, env, { ...principal(), credentialId: "agc_otherotherotherother" }, link.approvalId, "b".repeat(64)))
        .rejects.toMatchObject({ code: "approval_invalid" });
      await expect(redeemAgentApproval(test.db, env, principal(), link.approvalId, "c".repeat(64)))
        .rejects.toMatchObject({ code: "approval_invalid" });
      await expect(redeemAgentApproval(test.db, env, principal(), link.approvalId, "b".repeat(64))).resolves.toBeUndefined();
      await expect(redeemAgentApproval(test.db, env, principal(), link.approvalId, "b".repeat(64)))
        .rejects.toMatchObject({ code: "approval_invalid" });
    });

    it("refuses to open a request for a revoked credential", async () => {
      const test = harness();
      sqlite = test.sqlite;
      seed(sqlite);
      sqlite.prepare("UPDATE agent_credentials SET revoked_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), credentialId);
      await expect(request(test.db)).rejects.toMatchObject({ code: "agent_grant_inactive" });
    });
  });
});
