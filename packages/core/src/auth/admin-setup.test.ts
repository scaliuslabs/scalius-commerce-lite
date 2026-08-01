import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { Database } from "@scalius/database/client";
import { adminSetupClaims, adminSetupRateLimits, user } from "@scalius/database/schema";
import { ConflictError, ForbiddenError, RateLimitError } from "../errors";
import {
  adminPrincipalExists,
  claimAdminSetup,
  completeAdminSetupClaimWithUserPromotion,
  enforceAdminSetupRateLimit,
  markAdminSetupClaimCompleted,
  markAdminSetupClaimFailed,
} from "./admin-setup";

type ClaimRow = {
  singletonKey: "first_admin";
  status: "processing" | "completed" | "failed";
  claimId: string | null;
  claimExpiresAt: number | null;
  completedUserId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

type RateLimitRow = {
  key: string;
  attempts: number;
  windowExpiresAt: number;
  createdAt: number;
  updatedAt: number;
};

type UserRow = {
  id: string;
  name: string;
  role: string | null;
  isSuperAdmin: boolean;
  emailVerified: boolean;
  hasRbacPermission?: boolean;
};

describe("admin setup coordination", () => {
  it("checks admin existence through super-admin and RBAC permission state", async () => {
    const db = {
      get: vi.fn(async (_query: SQL) => ({ found: 1 })),
    };

    await expect(
      adminPrincipalExists(db as unknown as Parameters<typeof adminPrincipalExists>[0]),
    ).resolves.toBe(true);

    expect(db.get).toHaveBeenCalledTimes(1);
    const query = new SQLiteSyncDialect().sqlToQuery(
      db.get.mock.calls[0]?.[0] as SQL,
    ).sql;
    expect(query).not.toContain("admin_user.role = 'admin'");
    expect(query).toContain("is_super_admin = 1");
    expect(query).toContain("from user_roles");
    expect(query).toContain("inner join role_permissions");
    expect(query).toContain("from user_permissions as granted_permissions");
    expect(query).toContain("granted_permissions.granted = 1");
    expect(query).toContain("denied_permissions.granted = 0");
  });

  it("allows only one active first-admin setup claim", async () => {
    const fake = createFakeAdminSetupDb(1_000);

    const first = await claimAdminSetup(fake.db, { nowSeconds: 1_000 });

    await expect(claimAdminSetup(fake.db, { nowSeconds: 1_001 })).rejects.toBeInstanceOf(ConflictError);
    expect(fake.claim?.claimId).toBe(first.claimId);
    expect(fake.claim?.status).toBe("processing");
  });

  it("reclaims stale or failed setup claims", async () => {
    const fake = createFakeAdminSetupDb(1_000);

    const first = await claimAdminSetup(fake.db, { nowSeconds: 1_000 });
    await markAdminSetupClaimFailed(fake.db, first, new Error("signup failed"), { nowSeconds: 1_010 });
    const afterFailure = await claimAdminSetup(fake.db, { nowSeconds: 1_011 });
    expect(afterFailure.claimId).not.toBe(first.claimId);

    await expect(claimAdminSetup(fake.db, { nowSeconds: 1_012 })).rejects.toBeInstanceOf(ConflictError);
    const afterStaleLease = await claimAdminSetup(fake.db, { nowSeconds: 1_200 });
    expect(afterStaleLease.claimId).not.toBe(afterFailure.claimId);
    expect(fake.claim?.status).toBe("processing");
  });

  it("blocks setup once bootstrap is completed and an admin still exists", async () => {
    const fake = createFakeAdminSetupDb(1_000);
    const claim = await claimAdminSetup(fake.db, { nowSeconds: 1_000 });
    fake.users.set("admin_1", {
      id: "admin_1",
      name: "First Admin",
      role: "admin",
      isSuperAdmin: true,
      emailVerified: true,
    });

    await markAdminSetupClaimCompleted(fake.db, claim, "admin_1", { nowSeconds: 1_005 });

    await expect(claimAdminSetup(fake.db, { nowSeconds: 1_200 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.claim?.completedUserId).toBe("admin_1");
  });

  it("blocks setup recovery when an RBAC-only admin principal still exists", async () => {
    const fake = createFakeAdminSetupDb(1_000);
    const claim = await claimAdminSetup(fake.db, { nowSeconds: 1_000 });
    fake.users.set("rbac_admin", {
      id: "rbac_admin",
      name: "RBAC Admin",
      role: "user",
      isSuperAdmin: false,
      emailVerified: true,
      hasRbacPermission: true,
    });

    await markAdminSetupClaimCompleted(fake.db, claim, "rbac_admin", { nowSeconds: 1_005 });

    await expect(claimAdminSetup(fake.db, { nowSeconds: 1_200 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.claim?.completedUserId).toBe("rbac_admin");
  });

  it("reclaims a completed setup claim when only a legacy role-only user remains", async () => {
    const fake = createFakeAdminSetupDb(1_000);
    const claim = await claimAdminSetup(fake.db, { nowSeconds: 1_000 });
    fake.users.set("legacy_admin", {
      id: "legacy_admin",
      name: "Legacy Admin",
      role: "admin",
      isSuperAdmin: false,
      emailVerified: true,
    });

    await markAdminSetupClaimCompleted(fake.db, claim, "legacy_admin", { nowSeconds: 1_005 });

    const nextClaim = await claimAdminSetup(fake.db, { nowSeconds: 1_200 });

    expect(nextClaim.claimId).not.toBe(claim.claimId);
    expect(fake.claim).toMatchObject({
      status: "processing",
      completedUserId: null,
    });
  });

  it("reclaims a completed setup claim when no admin user exists anymore", async () => {
    const fake = createFakeAdminSetupDb(1_000);
    const claim = await claimAdminSetup(fake.db, { nowSeconds: 1_000 });

    await markAdminSetupClaimCompleted(fake.db, claim, "admin_1", { nowSeconds: 1_005 });

    const nextClaim = await claimAdminSetup(fake.db, { nowSeconds: 1_200 });

    expect(nextClaim.claimId).not.toBe(claim.claimId);
    expect(fake.claim).toMatchObject({
      status: "processing",
      completedUserId: null,
    });
  });

  it("enforces setup attempts through the D1 rate-limit row", async () => {
    const fake = createFakeAdminSetupDb(2_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await enforceAdminSetupRateLimit(fake.db, "203.0.113.10", { nowSeconds: 2_000 + attempt });
    }

    await expect(
      enforceAdminSetupRateLimit(fake.db, "203.0.113.10", { nowSeconds: 2_010 }),
    ).rejects.toBeInstanceOf(RateLimitError);

    await enforceAdminSetupRateLimit(fake.db, "203.0.113.10", { nowSeconds: 5_601 });
    expect([...fake.rateLimits.values()][0]?.attempts).toBe(1);
  });

  it("promotes the first admin and completes the setup claim in one guarded finish", async () => {
    const fake = createFakeAdminSetupDb(3_000);
    fake.users.set("admin_1", {
      id: "admin_1",
      name: "Pending Admin",
      role: "user",
      isSuperAdmin: false,
      emailVerified: false,
    });
    const claim = await claimAdminSetup(fake.db, { nowSeconds: 3_000 });
    fake.setNow(3_010);

    await completeAdminSetupClaimWithUserPromotion(fake.db, claim, {
      userId: "admin_1",
      name: "First Admin",
      nowSeconds: 3_010,
    });

    expect(fake.users.get("admin_1")).toMatchObject({
      name: "First Admin",
      role: "admin",
      isSuperAdmin: true,
      emailVerified: true,
    });
    expect(fake.claim).toMatchObject({
      status: "completed",
      completedUserId: "admin_1",
      claimId: null,
    });
  });

  it("does not promote when the setup claim is stale before the finish batch", async () => {
    const fake = createFakeAdminSetupDb(4_000);
    fake.users.set("admin_1", {
      id: "admin_1",
      name: "Pending Admin",
      role: "user",
      isSuperAdmin: false,
      emailVerified: false,
    });
    const claim = await claimAdminSetup(fake.db, { nowSeconds: 4_000 });
    fake.setNow(4_100);

    await expect(
      completeAdminSetupClaimWithUserPromotion(fake.db, claim, {
        userId: "admin_1",
        nowSeconds: 4_100,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(fake.users.get("admin_1")).toMatchObject({
      role: "user",
      isSuperAdmin: false,
      emailVerified: false,
    });
    expect(fake.claim?.status).toBe("processing");
  });
});

function createFakeAdminSetupDb(nowSeconds: number): {
  db: Database;
  claim: ClaimRow | null;
  rateLimits: Map<string, RateLimitRow>;
  users: Map<string, UserRow>;
  setNow: (nextNowSeconds: number) => void;
} {
  const state: {
    claim: ClaimRow | null;
    rateLimits: Map<string, RateLimitRow>;
    users: Map<string, UserRow>;
    nowSeconds: number;
  } = {
    claim: null,
    rateLimits: new Map(),
    users: new Map(),
    nowSeconds,
  };

  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table === adminSetupClaims) {
              if (state.claim) return [];
              state.claim = {
                singletonKey: "first_admin",
                status: "processing",
                claimId: String(values.claimId),
                claimExpiresAt: Number(values.claimExpiresAt),
                completedUserId: null,
                lastError: null,
                createdAt: Number(values.createdAt),
                updatedAt: Number(values.updatedAt),
              };
              return [{ singletonKey: state.claim.singletonKey }];
            }

            if (table === adminSetupRateLimits) {
              const key = String(values.key);
              if (state.rateLimits.has(key)) return [];
              state.rateLimits.set(key, {
                key,
                attempts: Number(values.attempts),
                windowExpiresAt: Number(values.windowExpiresAt),
                createdAt: Number(values.createdAt),
                updatedAt: Number(values.updatedAt),
              });
              return [{ key }];
            }

            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (table === adminSetupClaims) {
            const changed = updateClaim(state, values);
            return { returning: async () => changed ? [{ singletonKey: "first_admin" }] : [] };
          }

          if (table === user) {
            const changedId = updateUser(state, values);
            return { returning: async () => changedId ? [{ id: changedId }] : [] };
          }

          if (table === adminSetupRateLimits) {
            const changedKey = updateRateLimit(state, values);
            return {
              returning: async () => changedKey ? [{ key: changedKey, attempts: state.rateLimits.get(changedKey)?.attempts }] : [],
            };
          }

          return { returning: async () => [] };
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          get: async () => {
            if (table === adminSetupClaims) return state.claim;
            if (table === adminSetupRateLimits) return [...state.rateLimits.values()][0] ?? null;
            return null;
          },
        }),
      }),
    }),
    batch: async (statements: unknown[]) => await Promise.all(statements),
  } as unknown as Database;

  return {
    db,
    get claim() {
      return state.claim;
    },
    rateLimits: state.rateLimits,
    users: state.users,
    setNow(nextNowSeconds: number) {
      state.nowSeconds = nextNowSeconds;
    },
  };
}

function updateClaim(
  state: { claim: ClaimRow | null; users: Map<string, UserRow>; nowSeconds: number },
  values: Record<string, unknown>,
): boolean {
  if (!state.claim) return false;

  if (values.status === "completed") {
    if (
      state.claim.status !== "processing" ||
      !state.claim.claimId ||
      state.claim.claimExpiresAt === null ||
      state.claim.claimExpiresAt <= state.nowSeconds
    ) {
      return false;
    }
    state.claim = {
      ...state.claim,
      status: "completed",
      claimId: null,
      claimExpiresAt: null,
      completedUserId: (values.completedUserId as string | null | undefined) ?? null,
      lastError: null,
      updatedAt: Number(values.updatedAt),
    };
    return true;
  }

  if (values.status === "failed") {
    if (state.claim.status !== "processing" || !state.claim.claimId) return false;
    state.claim = {
      ...state.claim,
      status: "failed",
      claimId: null,
      claimExpiresAt: null,
      lastError: String(values.lastError ?? ""),
      updatedAt: Number(values.updatedAt),
    };
    return true;
  }

  if (values.status === "processing") {
    const hasAdmin = [...state.users.values()].some((row) =>
      row.isSuperAdmin || row.hasRbacPermission === true,
    );
    const stale =
      state.claim.status === "failed" ||
      (state.claim.status === "completed" && !hasAdmin) ||
      (state.claim.status === "processing" &&
        (state.claim.claimExpiresAt === null || state.claim.claimExpiresAt <= Number(values.updatedAt)));
    if (!stale) return false;
    state.claim = {
      ...state.claim,
      status: "processing",
      claimId: String(values.claimId),
      claimExpiresAt: Number(values.claimExpiresAt),
      completedUserId: (values.completedUserId as string | null | undefined) ?? null,
      lastError: null,
      updatedAt: Number(values.updatedAt),
    };
    return true;
  }

  return false;
}

function updateUser(
  state: { claim: ClaimRow | null; users: Map<string, UserRow>; nowSeconds: number },
  values: Record<string, unknown>,
): string | null {
  const target = [...state.users.values()][0];
  const claimIsActive =
    state.claim?.status === "processing" &&
    state.claim.claimExpiresAt !== null &&
    state.claim.claimExpiresAt > state.nowSeconds;

  if (!target || !claimIsActive) return null;

  const updated: UserRow = {
    ...target,
    role: String(values.role ?? target.role),
    isSuperAdmin: Boolean(values.isSuperAdmin ?? target.isSuperAdmin),
    emailVerified: Boolean(values.emailVerified ?? target.emailVerified),
  };

  if (typeof values.name === "string") {
    updated.name = values.name;
  }

  state.users.set(updated.id, updated);
  return updated.id;
}

function updateRateLimit(
  state: { rateLimits: Map<string, RateLimitRow> },
  values: Record<string, unknown>,
): string | null {
  const row = [...state.rateLimits.values()][0];
  if (!row) return null;
  const nowSeconds = Number(values.updatedAt);

  if (typeof values.windowExpiresAt === "number") {
    if (row.windowExpiresAt > nowSeconds) return null;
    row.attempts = 1;
    row.windowExpiresAt = values.windowExpiresAt;
    row.updatedAt = nowSeconds;
    return row.key;
  }

  if (row.windowExpiresAt <= nowSeconds || row.attempts >= 5) return null;
  row.attempts += 1;
  row.updatedAt = nowSeconds;
  return row.key;
}
