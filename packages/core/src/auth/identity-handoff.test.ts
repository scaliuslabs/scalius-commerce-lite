import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import * as schema from "@scalius/database/schema";
import type { IdentityHandoffConfig } from "@scalius/shared/platform-config";

import {
  IDENTITY_HANDOFF_ACCOUNT_PROVIDER,
  IDENTITY_HANDOFF_AUDIT_RETENTION_SECONDS,
  IdentityHandoffError,
  hashHandoffJti,
  identityHandoff,
  mintIdentityHandoffToken,
  performIdentityHandoff,
  performIdentityRevocation,
  pruneExpiredIdentityHandoffEvents,
  verifyIdentityHandoffToken,
  type IdentityHandoffClaims,
} from "./identity-handoff";

const migrationDirectory = fileURLToPath(new URL("../../../database/migrations/", import.meta.url));

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function createSchemaDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationDirectory)
    .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
    .sort()) {
    sqlite.exec(compileSqliteMigrationForProvider(readFileSync(`${migrationDirectory}/${name}`, "utf8"), "d1"));
  }
  sqlite.exec("PRAGMA foreign_keys = ON");
  return sqlite;
}

function d1Statement(sqlite: DatabaseSync, query: string, values: SQLInputValue[] = []): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: (sqlite.prepare(query) as StatementSync).all(...values),
    success: true,
    meta: {},
  });
  return {
    bind: (...nextValues) => d1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = sqlite.prepare(query).all(...values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createDb(sqlite: DatabaseSync): Database {
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return drizzle(binding as unknown as D1Database, { schema }) as unknown as Database;
}

const SECRET = "identity-handoff-secret-for-tests-0123456789abcdefghijk";
const CONFIG: IdentityHandoffConfig = {
  enabled: true,
  issuer: "https://idp.example.com",
  audience: "scalius:store-1",
  jwksUrl: "",
  localLoginDisabled: false,
};
const NOW = new Date("2026-09-15T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REQUEST = { clientIp: "203.0.113.9", userAgent: "vitest" };

let counter = 0;
function jti(): string {
  counter += 1;
  return `jti-${counter}-${crypto.randomUUID()}`;
}

async function mint(overrides: Partial<Parameters<typeof mintIdentityHandoffToken>[0]> = {}) {
  return mintIdentityHandoffToken({
    hmacSecret: SECRET,
    issuer: CONFIG.issuer,
    audience: CONFIG.audience,
    purpose: "dashboard-handoff",
    email: "Ops@Example.com",
    jti: jti(),
    role: "manager",
    name: "Ops Person",
    subject: "idp-user-1",
    issuedAt: NOW_SECONDS,
    ...overrides,
  });
}

async function verify(token: string, options: Partial<Parameters<typeof verifyIdentityHandoffToken>[1]> = {}) {
  return verifyIdentityHandoffToken(token, { config: CONFIG, hmacSecret: SECRET, now: () => NOW, ...options });
}

async function expectHandoffError(promise: Promise<unknown>, code: string, status?: IdentityHandoffError["status"]) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(IdentityHandoffError);
  expect((error as IdentityHandoffError).code).toBe(code);
  if (status) expect((error as IdentityHandoffError).status).toBe(status);
}

describe("verifyIdentityHandoffToken", () => {
  it("round-trips an HS256 token minted with the derived secret", async () => {
    const claims = await verify(await mint());
    expect(claims).toEqual<IdentityHandoffClaims>({
      purpose: "dashboard-handoff",
      jti: expect.stringMatching(/^jti-/) as unknown as string,
      subject: "idp-user-1",
      email: "ops@example.com",
      name: "Ops Person",
      role: "manager",
      suspend: false,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
    });
  });

  it("is a 404 while the handoff is disabled and fails closed without a key", async () => {
    const token = await mint();
    await expectHandoffError(verify(token, { config: { ...CONFIG, enabled: false } }), "HANDOFF_DISABLED", "NOT_FOUND");
    await expectHandoffError(verify(token, { hmacSecret: null }), "HANDOFF_KEY_UNAVAILABLE", "UNAUTHORIZED");
  });

  it("rejects the wrong issuer, audience, or signing key", async () => {
    await expectHandoffError(verify(await mint({ issuer: "https://other.example.com" })), "HANDOFF_TOKEN_INVALID");
    await expectHandoffError(verify(await mint({ audience: "scalius:store-2" })), "HANDOFF_TOKEN_INVALID");
    await expectHandoffError(verify(await mint({ hmacSecret: "another-secret-that-is-long-enough-000" })), "HANDOFF_TOKEN_INVALID");
    await expectHandoffError(verify("not-a-token-at-all-not-a-token"), "HANDOFF_TOKEN_INVALID");
  });

  it("enforces the 120 second lifetime and the 30 second grace after expiry", async () => {
    await expectHandoffError(verify(await mint({ lifetimeSeconds: 121 })), "HANDOFF_LIFETIME_INVALID");
    const token = await mint({ lifetimeSeconds: 60 });
    await expect(verify(token, { now: () => new Date((NOW_SECONDS + 89) * 1000) })).resolves.toBeTruthy();
    await expectHandoffError(verify(token, { now: () => new Date((NOW_SECONDS + 91) * 1000) }), "HANDOFF_TOKEN_INVALID");
    // A token from the future is not accepted beyond the tolerance either.
    await expectHandoffError(verify(token, { now: () => new Date((NOW_SECONDS - 31) * 1000) }), "HANDOFF_TOKEN_INVALID");
  });

  it("requires the purpose, jti, and a verified e-mail", async () => {
    await expectHandoffError(
      verify(await mint({ purpose: "something-else" as never })),
      "HANDOFF_PURPOSE_INVALID",
    );
    await expectHandoffError(verify(await mint({ jti: "short" })), "HANDOFF_JTI_MISSING");
    await expectHandoffError(verify(await mint({ email: "not-an-email" })), "HANDOFF_EMAIL_INVALID");
    await expectHandoffError(verify(await mint({ emailVerified: false })), "HANDOFF_EMAIL_UNVERIFIED");
    await expect(verify(await mint({ emailVerified: true }))).resolves.toMatchObject({ email: "ops@example.com" });
  });
});

describe("performIdentityHandoff", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    counter = 0;
    sqlite = createSchemaDatabase();
    db = createDb(sqlite);
    sqlite.exec(`
      INSERT INTO roles (id, name, display_name, is_system) VALUES
        ('role_manager', 'manager', 'Manager', 1),
        ('role_sales', 'sales_rep', 'Sales Representative', 1);
    `);
  });

  async function claims(overrides: Partial<Parameters<typeof mint>[0]> = {}) {
    return verify(await mint(overrides));
  }

  function auditRows() {
    return sqlite.prepare(
      "SELECT kind, email, role, outcome, user_id AS userId, client_ip AS clientIp FROM admin_identity_handoff_events ORDER BY created_at, rowid",
    ).all();
  }

  it("creates the administrator, credential-free account, and role in one batch", async () => {
    const kv = { delete: vi.fn(async () => undefined) } as unknown as KVNamespace;
    const result = await performIdentityHandoff(db, {
      claims: await claims(),
      config: CONFIG,
      request: REQUEST,
      permissionCache: kv,
      now: () => NOW,
    });

    expect(result.created).toBe(true);
    expect(result.mapping).toEqual({ isSuperAdmin: false, roleId: "role_manager", roleName: "manager" });
    expect(sqlite.prepare("SELECT name, email, email_verified, role, is_super_admin, must_change_password, must_enroll_two_factor FROM user").get())
      .toEqual({
        name: "Ops Person",
        email: "ops@example.com",
        email_verified: 1,
        role: "admin",
        is_super_admin: 0,
        must_change_password: 0,
        must_enroll_two_factor: 0,
      });
    expect(sqlite.prepare("SELECT provider_id, issuer, account_id, password FROM account").get()).toEqual({
      provider_id: IDENTITY_HANDOFF_ACCOUNT_PROVIDER,
      issuer: CONFIG.issuer,
      account_id: "idp-user-1",
      password: null,
    });
    expect(sqlite.prepare("SELECT role_id FROM user_roles").all()).toEqual([{ role_id: "role_manager" }]);
    expect(auditRows()).toEqual([
      { kind: "handoff", email: "ops@example.com", role: "manager", outcome: "user_created", userId: result.userId, clientIp: "203.0.113.9" },
    ]);
  });

  it("refuses a replayed jti before touching the user", async () => {
    const token = await mint();
    const first = await verify(token);
    await performIdentityHandoff(db, { claims: first, config: CONFIG, request: REQUEST, now: () => NOW });
    await expectHandoffError(
      performIdentityHandoff(db, { claims: await verify(token), config: CONFIG, request: REQUEST, now: () => NOW }),
      "HANDOFF_TOKEN_REPLAYED",
      "UNAUTHORIZED",
    );
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM user").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_identity_handoff_events").get()).toEqual({ count: 1 });
    expect(await hashHandoffJti("handoff", first.jti)).toHaveLength(64);
  });

  it("re-maps an existing administrator's authority from the role claim", async () => {
    const created = await performIdentityHandoff(db, { claims: await claims(), config: CONFIG, request: REQUEST, now: () => NOW });
    const kv = { delete: vi.fn(async () => undefined) } as unknown as KVNamespace;

    const promoted = await performIdentityHandoff(db, {
      claims: await claims({ role: "owner", name: "Ops Owner" }),
      config: CONFIG,
      request: REQUEST,
      permissionCache: kv,
      now: () => NOW,
    });
    expect(promoted).toMatchObject({ userId: created.userId, created: false, mapping: { isSuperAdmin: true, roleId: null } });
    expect(sqlite.prepare("SELECT name, is_super_admin FROM user").get()).toEqual({ name: "Ops Owner", is_super_admin: 1 });
    // The owner mapping leaves existing role rows alone.
    expect(sqlite.prepare("SELECT role_id FROM user_roles").all()).toEqual([{ role_id: "role_manager" }]);
    const cacheDeletes = (kv.delete as ReturnType<typeof vi.fn>).mock.calls.map(([key]) => String(key));
    expect(cacheDeletes).toHaveLength(1);
    expect(cacheDeletes[0]).toMatch(new RegExp(`^rbac:perms:${created.userId}:`));

    const demoted = await performIdentityHandoff(db, {
      claims: await claims({ role: "sales_rep" }),
      config: CONFIG,
      request: REQUEST,
      now: () => NOW,
    });
    expect(demoted.mapping).toEqual({ isSuperAdmin: false, roleId: "role_sales", roleName: "sales_rep" });
    expect(sqlite.prepare("SELECT is_super_admin FROM user").get()).toEqual({ is_super_admin: 0 });
    expect(sqlite.prepare("SELECT role_id FROM user_roles").all()).toEqual([{ role_id: "role_sales" }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM account").get()).toEqual({ count: 1 });
    expect(auditRows().map((row) => row.outcome)).toEqual(["user_created", "signed_in", "signed_in"]);
  });

  it("rejects unknown or missing roles and records the rejection", async () => {
    await expectHandoffError(
      performIdentityHandoff(db, { claims: await claims({ role: "warehouse" }), config: CONFIG, request: REQUEST, now: () => NOW }),
      "HANDOFF_ROLE_UNKNOWN",
      "FORBIDDEN",
    );
    await expectHandoffError(
      performIdentityHandoff(db, { claims: await claims({ role: undefined }), config: CONFIG, request: REQUEST, now: () => NOW }),
      "HANDOFF_ROLE_MISSING",
      "FORBIDDEN",
    );
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM user").get()).toEqual({ count: 0 });
    expect(auditRows().map((row) => row.outcome)).toEqual(["rejected:HANDOFF_ROLE_UNKNOWN", "rejected:HANDOFF_ROLE_MISSING"]);
  });

  it("refuses a suspended administrator", async () => {
    const created = await performIdentityHandoff(db, { claims: await claims(), config: CONFIG, request: REQUEST, now: () => NOW });
    sqlite.prepare("UPDATE user SET banned = 1 WHERE id = ?").run(created.userId);

    await expectHandoffError(
      performIdentityHandoff(db, { claims: await claims(), config: CONFIG, request: REQUEST, now: () => NOW }),
      "HANDOFF_USER_SUSPENDED",
      "FORBIDDEN",
    );

    // An expired suspension no longer blocks the handoff.
    sqlite.prepare("UPDATE user SET ban_expires = ? WHERE id = ?").run(NOW_SECONDS - 60, created.userId);
    await expect(performIdentityHandoff(db, { claims: await claims(), config: CONFIG, request: REQUEST, now: () => NOW }))
      .resolves.toMatchObject({ created: false });
  });

  it("revokes sessions and suspends non-owner administrators on request", async () => {
    const created = await performIdentityHandoff(db, { claims: await claims(), config: CONFIG, request: REQUEST, now: () => NOW });
    sqlite.prepare(
      "INSERT INTO session (id, user_id, token, expires_at) VALUES ('s1', ?, 'tok-1', ?), ('s2', ?, 'tok-2', ?)",
    ).run(created.userId, NOW_SECONDS + 3600, created.userId, NOW_SECONDS + 3600);

    const revoked = await performIdentityRevocation(db, {
      claims: await claims({ purpose: "dashboard-revoke", suspend: true }),
      config: CONFIG,
      request: REQUEST,
      now: () => NOW,
    });
    expect(revoked).toMatchObject({ userId: created.userId, sessionsRevoked: 2, suspended: true, suspensionRefused: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM session").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT banned, ban_reason FROM user").get()).toEqual({ banned: 1, ban_reason: "Suspended by the identity provider" });
    expect(auditRows().at(-1)).toMatchObject({ kind: "revoke", outcome: "sessions_revoked_and_suspended", userId: created.userId });

    await expectHandoffError(
      performIdentityRevocation(db, {
        claims: await claims({ purpose: "dashboard-handoff" }),
        config: CONFIG,
        request: REQUEST,
        now: () => NOW,
      }),
      "HANDOFF_PURPOSE_INVALID",
    );
    await expectHandoffError(
      performIdentityRevocation(db, {
        claims: await claims({ purpose: "dashboard-revoke", email: "nobody@example.com" }),
        config: CONFIG,
        request: REQUEST,
        now: () => NOW,
      }),
      "HANDOFF_USER_NOT_FOUND",
      "NOT_FOUND",
    );
  });

  it("never suspends the store owner but still revokes the sessions", async () => {
    const owner = await performIdentityHandoff(db, {
      claims: await claims({ role: "owner" }),
      config: CONFIG,
      request: REQUEST,
      now: () => NOW,
    });
    sqlite.prepare("INSERT INTO session (id, user_id, token, expires_at) VALUES ('s1', ?, 'tok-1', ?)").run(owner.userId, NOW_SECONDS + 3600);

    const revoked = await performIdentityRevocation(db, {
      claims: await claims({ purpose: "dashboard-revoke", suspend: true }),
      config: CONFIG,
      request: REQUEST,
      now: () => NOW,
    });
    expect(revoked).toMatchObject({ sessionsRevoked: 1, suspended: false, suspensionRefused: "store_owner" });
    expect(sqlite.prepare("SELECT banned FROM user").get()).toEqual({ banned: 0 });
  });

  it("prunes audit rows only after the retention window", async () => {
    await performIdentityHandoff(db, { claims: await claims(), config: CONFIG, request: REQUEST, now: () => NOW });
    const later = new Date(NOW.getTime() + (IDENTITY_HANDOFF_AUDIT_RETENTION_SECONDS + 61) * 1000);

    await expect(pruneExpiredIdentityHandoffEvents(db, NOW)).resolves.toBe(0);
    await expect(pruneExpiredIdentityHandoffEvents(db, later)).resolves.toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_identity_handoff_events").get()).toEqual({ count: 0 });
  });
});

describe("identityHandoff plugin", () => {
  it("exposes the two endpoints with a sign-in style rate limit", () => {
    const plugin = identityHandoff({
      db: {} as Database,
      config: CONFIG,
      hmacSecret: SECRET,
      dashboardUrl: "https://shop.example.com/dashboard",
    });
    expect(plugin.id).toBe("identity-handoff");
    expect(Object.keys(plugin.endpoints ?? {})).toEqual(["identityHandoff", "identityHandoffRevoke"]);
    const [limit] = plugin.rateLimit ?? [];
    expect(limit).toMatchObject({ window: 60, max: 10 });
    expect(limit?.pathMatcher("/handoff")).toBe(true);
    expect(limit?.pathMatcher("/handoff/revoke")).toBe(true);
    expect(limit?.pathMatcher("/sign-in/email")).toBe(false);
  });
});
