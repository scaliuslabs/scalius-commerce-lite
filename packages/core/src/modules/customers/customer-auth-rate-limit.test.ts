import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { RateLimitError } from "@scalius/core/errors";
import {
  cleanupExpiredCustomerAuthOtpRateLimits,
  enforceOtpSendRateLimits,
  OTP_CONTACT_RATE_LIMIT,
  OTP_CONTACT_SENDER_RATE_LIMIT,
  OTP_IP_RATE_LIMIT,
  OtpContactCeilingError,
} from "./customer-auth-rate-limit";

let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => ({ sqlite, db } = createSqliteD1Database()));
afterEach(() => sqlite.close());

const send = (identifier: string, ip: string, nowSeconds: number) =>
  enforceOtpSendRateLimits(db, { ip, identifiers: [identifier], hashKey: "rate-key", nowSeconds });

describe("OTP send rate limits (R2-BA-06)", () => {
  it("stops one sender flooding a contact without blocking the owner on another network", async () => {
    for (let attempt = 0; attempt < OTP_CONTACT_SENDER_RATE_LIMIT.attempts; attempt += 1) {
      await send("email:victim@example.test", "198.51.100.66", 1_000 + attempt);
    }
    const error = await send("email:victim@example.test", "198.51.100.66", 1_100).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).not.toBeInstanceOf(OtpContactCeilingError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(1_000 + OTP_CONTACT_SENDER_RATE_LIMIT.windowSeconds - 1_100);

    // The owner, from their own connection, still gets a code.
    await expect(send("email:victim@example.test", "203.0.113.5", 1_101)).resolves.toMatchObject({
      resendCooldownSeconds: expect.any(Number),
    });
  });

  it("escalates the resend cooldown with a contact's recent sends and caps it", async () => {
    const cooldowns: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { resendCooldownSeconds } = await send("email:a@example.test", `203.0.113.${attempt}`, 2_000 + attempt);
      cooldowns.push(resendCooldownSeconds);
    }
    expect(cooldowns).toEqual([60, 60, 120, 240, 480, 600, 600, 600]);
  });

  it("caps a contact across all senders with a distinct error, so sign-in keeps the last code usable", async () => {
    for (let attempt = 0; attempt < OTP_CONTACT_RATE_LIMIT.attempts; attempt += 1) {
      await send("email:a@example.test", `203.0.113.${attempt}`, 3_000);
    }
    const ceiling = await send("email:a@example.test", "203.0.113.99", 3_000).catch((caught: unknown) => caught);
    expect(ceiling).toBeInstanceOf(OtpContactCeilingError);
    expect((ceiling as RateLimitError).message).toBe("Too many codes. Enter the latest code we sent.");
  });

  it("keeps the shared IP bucket as a generous flood ceiling only", async () => {
    for (let buyer = 0; buyer < OTP_IP_RATE_LIMIT.attempts; buyer += 1) {
      await send(`email:buyer${buyer}@example.test`, "198.51.100.1", 4_000);
    }
    await expect(send("email:late@example.test", "198.51.100.1", 4_000)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("stores only hashed keys and cleans expired windows in bounded batches", async () => {
    await send("email:a@example.test", "203.0.113.20", 5_000);
    const keys = sqlite.prepare("SELECT key, scope FROM customer_auth_otp_rate_limits").all();
    expect(keys.map((row) => row.scope).sort()).toEqual(["identifier", "identifier", "ip"]);
    expect(JSON.stringify(keys)).not.toMatch(/203\.0\.113\.20|a@example/);

    const cleaned = await cleanupExpiredCustomerAuthOtpRateLimits(db, 5_000 + OTP_CONTACT_RATE_LIMIT.windowSeconds, { limit: 1 });
    expect(cleaned).toMatchObject({ deleted: 1, hasMore: true });
  });
});
