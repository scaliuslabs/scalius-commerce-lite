import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { issueAgentCredential } from "./pat";
import { resolveAgentPrincipalFromBearer, resolveAgentPrincipalFromGrant } from "./principal";

const PEPPER = "agent-principal-test-pepper-longer-than-thirty-two-chars";
const grantId = "agr_0123456789abcdefghij";
const credentialId = "agc_0123456789abcdefghij";
const now = () => Math.floor(Date.now() / 1000);

interface Fixture {
  grant?: { status?: string; expiresIn?: number; resource?: string; kind?: "pat" | "oauth" };
  credential?: { revoked?: boolean; expiresIn?: number };
  owner?: { banned?: boolean; banExpiresIn?: number | null; mustChangePassword?: boolean; mustEnrollTwoFactor?: boolean; twoFactorEnabled?: boolean };
  livePermissions?: string[];
}

async function seed(fixture: Fixture = {}) {
  const { sqlite, db } = createSqliteD1Database();
  const t = now();
  const owner = { banned: false, banExpiresIn: null, mustChangePassword: false, mustEnrollTwoFactor: false, twoFactorEnabled: true, ...fixture.owner };
  sqlite.prepare(`INSERT INTO user (id, name, email, banned, ban_expires, two_factor_enabled, must_change_password, must_enroll_two_factor)
    VALUES ('owner-1', 'Owner', 'owner@example.test', ?, ?, ?, ?, ?)`).run(
    Number(owner.banned),
    owner.banExpiresIn === null ? null : t + owner.banExpiresIn,
    Number(owner.twoFactorEnabled),
    Number(owner.mustChangePassword),
    Number(owner.mustEnrollTwoFactor),
  );
  grantLivePermissions(sqlite, fixture.livePermissions ?? ["products.view", "orders.view"]);

  const kind = fixture.grant?.kind ?? "pat";
  const status = fixture.grant?.status ?? "active";
  sqlite.prepare(`INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, oauth_client_id, oauth_redirect_uris_json,
      preset, permissions_json, risk_ceiling, status, revoked_at, expires_at, created_at, updated_at)
    VALUES (?, ?, 'owner-1', ?, 'Agent', ?, ?, 'custom', '["products.view","customers.view"]', 'read', ?, ?, ?, ?, ?)`).run(
    grantId,
    kind,
    fixture.grant?.resource ?? "dashboard",
    kind === "oauth" ? "client-1" : null,
    kind === "oauth" ? "[]" : null,
    status,
    status === "revoked" ? t : null,
    t + (fixture.grant?.expiresIn ?? 7200),
    t - 7200,
    t - 7200,
  );
  const issued = await issueAgentCredential("pat", credentialId, PEPPER);
  if (kind === "pat") {
    sqlite.prepare(`INSERT INTO agent_credentials (id, grant_id, kind, token_hash, token_hint, expires_at, revoked_at, created_at, updated_at)
      VALUES (?, ?, 'pat', ?, ?, ?, ?, ?, ?)`).run(
      credentialId,
      grantId,
      issued.tokenHash,
      issued.tokenHint,
      t + (fixture.credential?.expiresIn ?? 3600),
      fixture.credential?.revoked ? t : null,
      t - 7200,
      t - 7200,
    );
  }
  return { db, token: issued.token };
}

function grantLivePermissions(sqlite: DatabaseSync, names: string[]) {
  sqlite.exec(`INSERT INTO roles (id, name, display_name) VALUES ('role-1', 'agent-owner', 'Agent owner');
    INSERT INTO user_roles (id, user_id, role_id) VALUES ('user-role-1', 'owner-1', 'role-1');`);
  names.forEach((name, index) => {
    sqlite.prepare(`INSERT INTO permissions (id, name, display_name, resource, action, category) VALUES (?, ?, ?, 'x', 'view', 'x')`)
      .run(`permission-${index}`, name, name);
    sqlite.prepare(`INSERT INTO role_permissions (id, role_id, permission_id) VALUES (?, 'role-1', ?)`)
      .run(`role-permission-${index}`, `permission-${index}`);
  });
}

async function resolveBearer(fixture: Fixture = {}) {
  const { db, token } = await seed(fixture);
  return resolveAgentPrincipalFromBearer(db, `Bearer ${token}`, PEPPER);
}

describe("agent principal live authority", () => {
  it("intersects the immutable grant snapshot with the owner's live RBAC", async () => {
    const principal = await resolveBearer();

    expect(principal).toMatchObject({ grantId, credentialId, ownerUserId: "owner-1", resource: "dashboard" });
    expect(principal?.permissions).toEqual(new Set(["products.view"]));
    expect(principal!.expiresAt.getTime()).toBeLessThan(Date.now() + 3601_000);
  });

  it.each<[string, Fixture]>([
    ["a revoked grant", { grant: { status: "revoked" } }],
    ["an expired grant", { grant: { expiresIn: -1 } }],
    ["a revoked credential", { credential: { revoked: true } }],
    ["an expired credential", { credential: { expiresIn: -1 } }],
    ["a banned owner", { owner: { banned: true } }],
    ["an owner still under a timed ban", { owner: { banned: true, banExpiresIn: 600 } }],
    ["an owner who must change password", { owner: { mustChangePassword: true } }],
    ["an owner who must enroll 2FA", { owner: { mustEnrollTwoFactor: true } }],
    ["an owner without 2FA", { owner: { twoFactorEnabled: false } }],
    ["an owner whose RBAC was removed", { livePermissions: [] }],
  ])("rejects %s", async (_label, fixture) => {
    await expect(resolveBearer(fixture)).resolves.toBeNull();
  });

  it("accepts an owner whose ban has expired", async () => {
    await expect(resolveBearer({ owner: { banned: true, banExpiresIn: -1 } })).resolves.not.toBeNull();
  });

  it("rejects a credential hashed under another pepper", async () => {
    const { db, token } = await seed();

    await expect(resolveAgentPrincipalFromBearer(db, token, "another-pepper-longer-than-thirty-two-chars")).resolves.toBeNull();
  });

  it("binds OAuth grants to their exact resource", async () => {
    const { db } = await seed({ grant: { kind: "oauth", resource: "storefront" } });

    await expect(resolveAgentPrincipalFromGrant(db, { grantId, credentialId: null, resource: "dashboard" })).resolves.toBeNull();
    await expect(resolveAgentPrincipalFromGrant(db, { grantId, credentialId: null, resource: "storefront" }))
      .resolves.toMatchObject({ grantId, credentialId: null, resource: "storefront", grantKind: "oauth" });
  });
});
