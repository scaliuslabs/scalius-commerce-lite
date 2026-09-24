import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { RateLimitError } from "@scalius/core/errors";
import {
  cleanupExpiredCustomerAuthOtpRateLimits,
  enforceOtpSendRateLimits,
  OTP_IDENTIFIER_RATE_LIMIT,
  OTP_IP_RATE_LIMIT,
} from "./customer-auth-rate-limit";

let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => ({ sqlite, db } = createSqliteD1Database()));
afterEach(() => sqlite.close());

const send = (identifier: string, ip: string, nowSeconds: number) =>
  enforceOtpSendRateLimits(db, { ip, identifiers: [identifier], hashKey: "rate-key", nowSeconds });

describe("OTP send rate limits", () => {
  it("limits each contact and reports the honest wait", async () => {
    for (let attempt = 0; attempt < OTP_IDENTIFIER_RATE_LIMIT.attempts; attempt += 1) {
      await send("email:a@example.test", `203.0.113.${attempt}`, 1_000 + attempt);
    }
    const error = await send("email:a@example.test", "203.0.113.99", 1_100).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(1_000 + OTP_IDENTIFIER_RATE_LIMIT.windowSeconds - 1_100);
    // A new window opens after the reset.
    await expect(send("email:a@example.test", "203.0.113.99", 1_000 + OTP_IDENTIFIER_RATE_LIMIT.windowSeconds))
      .resolves.toBeUndefined();
  });

  it("keeps the shared IP bucket as a generous flood ceiling only", async () => {
    for (let buyer = 0; buyer < OTP_IP_RATE_LIMIT.attempts; buyer += 1) {
      await send(`email:buyer${buyer}@example.test`, "198.51.100.1", 2_000);
    }
    await expect(send("email:late@example.test", "198.51.100.1", 2_000)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("stores only hashed keys and cleans expired windows in bounded batches", async () => {
    await send("email:a@example.test", "203.0.113.20", 3_000);
    const keys = sqlite.prepare("SELECT key, scope FROM customer_auth_otp_rate_limits").all();
    expect(keys.map((row) => row.scope).sort()).toEqual(["identifier", "ip"]);
    expect(JSON.stringify(keys)).not.toMatch(/203\.0\.113\.20|a@example/);

    const cleaned = await cleanupExpiredCustomerAuthOtpRateLimits(db, 3_000 + OTP_IDENTIFIER_RATE_LIMIT.windowSeconds, { limit: 1 });
    expect(cleaned).toMatchObject({ deleted: 1, hasMore: true });
  });
});
