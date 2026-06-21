import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { customerAuthOtpRateLimits } from "@scalius/database/schema";
import { RateLimitError } from "@scalius/core/errors";
import {
  cleanupExpiredCustomerAuthOtpRateLimits,
  CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_WINDOW_SECONDS,
  enforceCustomerAuthOtpIpRateLimit,
} from "./customer-auth-rate-limit";

type RateLimitRow = {
  key: string;
  scope: "ip";
  attempts: number;
  windowExpiresAt: number;
  createdAt: number;
  updatedAt: number;
};

describe("customer auth OTP D1 rate limits", () => {
  it("allows five OTP sends per IP window and rejects the sixth", async () => {
    const fake = createFakeCustomerOtpRateLimitDb();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await enforceCustomerAuthOtpIpRateLimit(fake.db, {
        ip: "203.0.113.20",
        hashKey: "otp-rate-limit-key",
        nowSeconds: 2_000 + attempt,
      });
    }

    await expect(enforceCustomerAuthOtpIpRateLimit(fake.db, {
      ip: "203.0.113.20",
      hashKey: "otp-rate-limit-key",
      nowSeconds: 2_010,
    })).rejects.toBeInstanceOf(RateLimitError);

    const row = [...fake.rows.values()][0];
    expect(row?.attempts).toBe(5);
    expect(row?.windowExpiresAt).toBe(2_000 + CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_WINDOW_SECONDS);
  });

  it("resets an expired IP window and stores no raw IP in the key", async () => {
    const fake = createFakeCustomerOtpRateLimitDb();

    await enforceCustomerAuthOtpIpRateLimit(fake.db, {
      ip: "203.0.113.20",
      hashKey: "otp-rate-limit-key",
      nowSeconds: 2_000,
    });
    await enforceCustomerAuthOtpIpRateLimit(fake.db, {
      ip: "203.0.113.20",
      hashKey: "otp-rate-limit-key",
      nowSeconds: 2_000 + CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_WINDOW_SECONDS,
    });

    const row = [...fake.rows.values()][0];
    expect(row?.attempts).toBe(1);
    expect(row?.key).not.toContain("203.0.113.20");
  });

  it("counts unknown client identity in a shared fail-closed bucket", async () => {
    const fake = createFakeCustomerOtpRateLimitDb();

    await enforceCustomerAuthOtpIpRateLimit(fake.db, {
      ip: "unknown",
      hashKey: "otp-rate-limit-key",
      nowSeconds: 2_000,
    });

    const row = [...fake.rows.values()][0];
    expect(row).toMatchObject({ attempts: 1, scope: "ip" });
  });

  it("keeps concurrent calls within the configured quota", async () => {
    const fake = createFakeCustomerOtpRateLimitDb();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => enforceCustomerAuthOtpIpRateLimit(fake.db, {
        ip: "203.0.113.30",
        hashKey: "otp-rate-limit-key",
        nowSeconds: 3_000 + index,
      })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect([...fake.rows.values()][0]?.attempts).toBe(5);
  });

  it("cleans expired rate-limit rows in bounded batches", async () => {
    const fake = createFakeCustomerOtpRateLimitDb();
    fake.rows.set("expired_1", createRow("expired_1", 1_000));
    fake.rows.set("expired_2", createRow("expired_2", 1_000));
    fake.rows.set("fresh_1", createRow("fresh_1", 9_999));

    const result = await cleanupExpiredCustomerAuthOtpRateLimits(fake.db, 2_000, { limit: 1 });

    expect(result).toEqual({
      scanned: 1,
      deleted: 1,
      limit: 1,
      hasMore: true,
    });
    expect(fake.rows.has("fresh_1")).toBe(true);
    expect([...fake.rows.keys()].filter((key) => key.startsWith("expired_"))).toHaveLength(1);
  });
});

function createFakeCustomerOtpRateLimitDb(): {
  db: Database;
  rows: Map<string, RateLimitRow>;
} {
  const state: {
    rows: Map<string, RateLimitRow>;
    cleanupKeys: string[];
  } = {
    rows: new Map(),
    cleanupKeys: [],
  };

  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== customerAuthOtpRateLimits) return [];
            const key = String(values.key);
            if (state.rows.has(key)) return [];
            state.rows.set(key, {
              key,
              scope: "ip",
              attempts: Number(values.attempts),
              windowExpiresAt: Number(values.windowExpiresAt),
              createdAt: Number(values.createdAt),
              updatedAt: Number(values.updatedAt),
            });
            return [{ key }];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table !== customerAuthOtpRateLimits) return [];
            const changedKey = updateRateLimit(state.rows, values);
            return changedKey
              ? [{ key: changedKey, attempts: state.rows.get(changedKey)?.attempts }]
              : [];
          },
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          get: async () => table === customerAuthOtpRateLimits
            ? [...state.rows.values()][0] ?? null
            : null,
          limit: async (limit: number) => {
            if (table !== customerAuthOtpRateLimits) return [];
            const now = Math.max(
              0,
              ...[...state.rows.values()]
                .filter((row) => row.windowExpiresAt < 9_999)
                .map((row) => row.windowExpiresAt),
            );
            const rows = [...state.rows.values()]
              .filter((row) => row.windowExpiresAt <= now)
              .slice(0, limit);
            state.cleanupKeys = rows.slice(0, Math.max(0, limit - 1)).map((row) => row.key);
            return rows.map((row) => ({ key: row.key }));
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table !== customerAuthOtpRateLimits) return;
        for (const key of state.cleanupKeys) {
          state.rows.delete(key);
        }
      },
    }),
  } as unknown as Database;

  return {
    db,
    rows: state.rows,
  };
}

function updateRateLimit(
  rows: Map<string, RateLimitRow>,
  values: Record<string, unknown>,
): string | null {
  const row = [...rows.values()][0];
  if (!row) return null;
  const nowSeconds = Number(values.updatedAt);

  if (typeof values.windowExpiresAt === "number") {
    if (row.windowExpiresAt > nowSeconds) return null;
    row.attempts = 1;
    row.windowExpiresAt = values.windowExpiresAt;
    row.updatedAt = nowSeconds;
    return row.key;
  }

  if (
    row.windowExpiresAt <= nowSeconds ||
    row.attempts >= 5
  ) {
    return null;
  }

  row.attempts += 1;
  row.updatedAt = nowSeconds;
  return row.key;
}

function createRow(key: string, windowExpiresAt: number): RateLimitRow {
  return {
    key,
    scope: "ip",
    attempts: 1,
    windowExpiresAt,
    createdAt: 1,
    updatedAt: 1,
  };
}
