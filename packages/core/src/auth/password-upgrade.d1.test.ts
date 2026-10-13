import { hashPassword as hashWithBetterAuth } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@scalius/database/client";
import { account } from "@scalius/database/schema";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { EMPTY_PLATFORM_CONFIG } from "@scalius/shared/platform-config";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";

import { createAuth } from "./auth";
import { hashPassword, verifyPassword } from "./password-hash";

const KEY = btoa("0123456789abcdef0123456789abcdef");
const PASSWORD = "Correct-Horse-Battery-9";

let database: SqliteTestDatabase | null = null;

function env() {
  database = createSqliteD1Database();
  return {
    DB: database.binding,
    BETTER_AUTH_SECRET: "password-upgrade-test-secret-0123456789abcdef",
    BETTER_AUTH_URL: "https://admin.shop.test",
    STOREFRONT_URL: "https://shop.test",
    CREDENTIAL_ENCRYPTION_KEY: KEY,
    PLATFORM_CONFIG: { ...EMPTY_PLATFORM_CONFIG, dashboardUrl: "https://admin.shop.test", storefrontUrl: "https://shop.test" },
  } as unknown as Env;
}

const credentialRow = async (db: ReturnType<typeof getDb>) =>
  (await db.select({ password: account.password }).from(account).where(eq(account.providerId, "credential")).get())?.password ?? "";

afterEach(() => {
  database?.sqlite.close();
  database = null;
  vi.unstubAllGlobals();
});

describe("password hashes through Better Auth", () => {
  it("signs up with the plan's self-describing hash and signs in without rewriting it", async () => {
    const environment = env();
    const auth = createAuth(environment);
    const db = getDb(environment);
    await auth.api.signUpEmail({ body: { email: "owner@shop.test", password: PASSWORD, name: "Owner" } });
    const stored = await credentialRow(db);
    expect(stored).toMatch(/^\$sc1\$pbkdf2-sha256\$i=30000,k=1\$/);

    const signedIn = await auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } });
    expect(signedIn.user.email).toBe("owner@shop.test");
    expect(await credentialRow(db)).toBe(stored);
    await expect(auth.api.signInEmail({ body: { email: "owner@shop.test", password: `${PASSWORD}x` } })).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(await credentialRow(db)).toBe(stored);
  });

  it("moves a Better Auth scrypt hash to the plan's format at the next successful sign-in only", async () => {
    const environment = env();
    const auth = createAuth(environment);
    const db = getDb(environment);
    await auth.api.signUpEmail({ body: { email: "owner@shop.test", password: PASSWORD, name: "Owner" } });
    const legacy = await hashWithBetterAuth(PASSWORD);
    await db.update(account).set({ password: legacy }).where(eq(account.providerId, "credential"));

    // A wrong password neither signs in nor touches the stored hash.
    await expect(auth.api.signInEmail({ body: { email: "owner@shop.test", password: "wrong-Password-1" } })).rejects.toBeTruthy();
    expect(await credentialRow(db)).toBe(legacy);

    await auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } });
    const upgraded = await credentialRow(db);
    expect(upgraded).toMatch(/^\$sc1\$pbkdf2-sha256\$i=30000,k=1\$/);
    expect(await verifyPassword(upgraded, PASSWORD, { pepperKey: KEY })).toEqual({ valid: true, needsRehash: false });
    // And the upgraded hash signs in again.
    await auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } });
    expect(await credentialRow(db)).toBe(upgraded);
  });

  it("Free to Paid: the next sign-in upgrades a Free hash to scrypt; back on Free it is cheap again after one sign-in", async () => {
    const environment = env();
    const auth = createAuth(environment);
    const db = getDb(environment);
    await auth.api.signUpEmail({ body: { email: "owner@shop.test", password: PASSWORD, name: "Owner" } });
    expect(await credentialRow(db)).toContain("$pbkdf2-sha256$");

    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    await auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } });
    const onPaid = await credentialRow(db);
    expect(onPaid).toContain(`$scrypt$N=${PLAN_LIMITS.paid.password.algorithm === "scrypt" ? PLAN_LIMITS.paid.password.N : 0},`);

    vi.unstubAllGlobals();
    await auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } });
    expect(await credentialRow(db)).toContain("$pbkdf2-sha256$");
  });

  it("a failed upgrade write never fails the sign-in, and concurrent sign-ins cannot clobber each other", async () => {
    const environment = env();
    const auth = createAuth(environment);
    const db = getDb(environment);
    await auth.api.signUpEmail({ body: { email: "owner@shop.test", password: PASSWORD, name: "Owner" } });
    const legacy = await hashWithBetterAuth(PASSWORD);
    await db.update(account).set({ password: legacy }).where(eq(account.providerId, "credential"));

    const results = await Promise.all([
      auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } }),
      auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } }),
    ]);
    expect(results.every((result) => result.user.email === "owner@shop.test")).toBe(true);
    const stored = await credentialRow(db);
    expect(stored.startsWith("$sc1$")).toBe(true);
    expect((await verifyPassword(stored, PASSWORD, { pepperKey: KEY })).valid).toBe(true);

    // Reset the row, then make the upgrade write fail: the sign-in still succeeds on the old hash.
    await db.update(account).set({ password: legacy }).where(eq(account.providerId, "credential"));
    database!.sqlite.exec("CREATE TRIGGER block_account_update BEFORE UPDATE ON account BEGIN SELECT RAISE(ABORT, 'locked'); END");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const signedIn = await auth.api.signInEmail({ body: { email: "owner@shop.test", password: PASSWORD } });
    expect(signedIn.user.email).toBe("owner@shop.test");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Password hash upgrade failed"));
    database!.sqlite.exec("DROP TRIGGER block_account_update");
    expect(await credentialRow(db)).toBe(legacy);
    warn.mockRestore();
  });

  it("hashes with the deployed plan's profile: the same call is PBKDF2 on Free and scrypt on Paid", async () => {
    expect(await hashPassword(PASSWORD)).toContain("$pbkdf2-sha256$");
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    expect(await hashPassword(PASSWORD)).toContain("$scrypt$");
  });
});
