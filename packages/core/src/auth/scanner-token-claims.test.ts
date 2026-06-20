import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { scannerTokenClaims } from "@scalius/database/schema";
import { sha256Hex } from "@scalius/shared/scanner-auth";
import { UnauthorizedError } from "../errors";
import {
  cleanupExpiredScannerTokenClaims,
  consumeScannerTokenClaim,
  createScannerTokenClaim,
} from "./scanner-token-claims";

type ScannerTokenClaimRow = {
  tokenHash: string;
  adminId: string;
  adminName: string;
  consumedAt: number | null;
  consumedSessionHash: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

describe("scanner token claims", () => {
  it("stores QR tokens by hash instead of raw token value", async () => {
    const fake = createFakeScannerTokenDb(1_000);

    await createScannerTokenClaim(fake.db, {
      token: "raw-scanner-token",
      adminId: "admin_1",
      adminName: "Inventory Admin",
      nowMs: 1_000_000,
    });

    const tokenHash = await sha256Hex("raw-scanner-token");
    expect(fake.claims.get(tokenHash)).toMatchObject({
      tokenHash,
      adminId: "admin_1",
      adminName: "Inventory Admin",
      consumedAt: null,
      consumedSessionHash: null,
      createdAt: 1_000,
    });
    expect([...fake.claims.keys()]).not.toContain("raw-scanner-token");
  });

  it("consumes a QR token exactly once and binds it to the scanner session hash", async () => {
    const fake = createFakeScannerTokenDb(2_000);
    await createScannerTokenClaim(fake.db, {
      token: "scanner-token",
      adminId: "admin_1",
      adminName: "Inventory Admin",
      nowMs: 2_000_000,
    });

    const consumed = await consumeScannerTokenClaim(fake.db, {
      token: "scanner-token",
      sessionId: "scanner-session-1",
      nowMs: 2_001_000,
    });

    const tokenHash = await sha256Hex("scanner-token");
    expect(consumed).toMatchObject({
      tokenHash,
      adminId: "admin_1",
      adminName: "Inventory Admin",
    });
    expect(fake.claims.get(tokenHash)).toMatchObject({
      consumedAt: 2_001,
      consumedSessionHash: await sha256Hex("scanner-session-1"),
    });

    await expect(
      consumeScannerTokenClaim(fake.db, {
        token: "scanner-token",
        sessionId: "scanner-session-2",
        nowMs: 2_002_000,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects expired QR tokens without consuming them", async () => {
    const fake = createFakeScannerTokenDb(3_000);
    await createScannerTokenClaim(fake.db, {
      token: "expired-token",
      adminId: "admin_1",
      adminName: "Inventory Admin",
      nowMs: 3_000_000,
    });

    await expect(
      consumeScannerTokenClaim(fake.db, {
        token: "expired-token",
        sessionId: "scanner-session",
        nowMs: 4_000_000,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(fake.claims.get(await sha256Hex("expired-token"))?.consumedAt).toBeNull();
  });

  it("cleans expired scanner token claims", async () => {
    const fake = createFakeScannerTokenDb(4_000);
    await createScannerTokenClaim(fake.db, {
      token: "expired-token",
      adminId: "admin_1",
      adminName: "Inventory Admin",
      nowMs: 3_000_000,
    });
    await createScannerTokenClaim(fake.db, {
      token: "live-token",
      adminId: "admin_1",
      adminName: "Inventory Admin",
      nowMs: 4_900_000,
    });

    const result = await cleanupExpiredScannerTokenClaims(fake.db, { nowSeconds: 4_000 });

    expect(result).toMatchObject({
      scanned: 1,
      deleted: 1,
      hasMore: false,
    });
    expect(result.deleted).toBe(1);
    expect(fake.claims.has(await sha256Hex("expired-token"))).toBe(false);
    expect(fake.claims.has(await sha256Hex("live-token"))).toBe(true);
  });
});

function createFakeScannerTokenDb(nowSeconds: number): {
  db: Database;
  claims: Map<string, ScannerTokenClaimRow>;
} {
  const state = {
    claims: new Map<string, ScannerTokenClaimRow>(),
    nowSeconds,
  };

  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== scannerTokenClaims) return [];
            const tokenHash = String(values.tokenHash);
            if (state.claims.has(tokenHash)) return [];
            state.claims.set(tokenHash, {
              tokenHash,
              adminId: String(values.adminId),
              adminName: String(values.adminName),
              consumedAt: values.consumedAt === null ? null : Number(values.consumedAt),
              consumedSessionHash: values.consumedSessionHash === null
                ? null
                : String(values.consumedSessionHash),
              expiresAt: Number(values.expiresAt),
              createdAt: Number(values.createdAt),
              updatedAt: Number(values.updatedAt),
            });
            return [{ tokenHash }];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table !== scannerTokenClaims) return [];
            const nowSeconds = Number(values.consumedAt);
            const row = [...state.claims.values()].find(
              (claim) => claim.consumedAt === null && claim.expiresAt > nowSeconds,
            );
            if (!row) return [];
            row.consumedAt = Number(values.consumedAt);
            row.consumedSessionHash = String(values.consumedSessionHash);
            row.updatedAt = Number(values.updatedAt);
            return [{
              tokenHash: row.tokenHash,
              adminId: row.adminId,
              adminName: row.adminName,
            }];
          },
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (limit: number) => {
            if (table !== scannerTokenClaims) return [];
            return [...state.claims.values()]
              .filter((row) =>
                (row.consumedAt === null && row.expiresAt <= state.nowSeconds) ||
                (row.consumedAt !== null && row.consumedAt <= state.nowSeconds - 6 * 60 * 60),
              )
              .slice(0, limit)
              .map((row) => ({ tokenHash: row.tokenHash }));
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table !== scannerTokenClaims) return;
        for (const [tokenHash, row] of state.claims) {
          if (
            (row.consumedAt === null && row.expiresAt <= state.nowSeconds) ||
            (row.consumedAt !== null && row.consumedAt <= state.nowSeconds - 6 * 60 * 60)
          ) {
            state.claims.delete(tokenHash);
          }
        }
      },
    }),
  } as unknown as Database;

  return { db, claims: state.claims };
}
