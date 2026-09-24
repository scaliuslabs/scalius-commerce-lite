// Challenge storage on the real schema. Claiming, wrong attempts, locking and
// replaced codes are exercised end to end in customer-auth.service.test.ts.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { RateLimitError, ServiceUnavailableError } from "@scalius/core/errors";

import {
  buildCustomerAuthOtpStorageKey,
  cleanupExpiredCustomerAuthOtpChallenges,
  deleteCustomerAuthOtpChallenge,
  persistCustomerAuthOtpChallenge,
  type PersistCustomerAuthOtpChallengeInput,
} from "./customer-auth-otp-challenges";

const signingKey = "test-signing-key";
const contactKey = Buffer.alloc(32, 7).toString("base64");

let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => ({ sqlite, db } = createSqliteD1Database()));
afterEach(() => sqlite.close());

async function challenge(overrides: Partial<PersistCustomerAuthOtpChallengeInput> = {}) {
  const otpKey = await buildCustomerAuthOtpStorageKey("email", "buyer@example.com", signingKey);
  return {
    otpKey,
    deliveryKey: "otp_delivery_1",
    method: "email" as const,
    channel: "email" as const,
    identifier: "buyer@example.com",
    deliveryTarget: "buyer@example.com",
    code: "123456",
    encryptionKey: signingKey,
    contactEncryptionKey: contactKey,
    ttlSeconds: 300,
    resendCooldownSeconds: 60,
    maxAttempts: 5,
    ...overrides,
  };
}

describe("customer auth OTP challenges", () => {
  it("stores only hashes and the encrypted delivery target", async () => {
    const input = await challenge();
    expect(input.otpKey).toMatch(/^cust_otp:email:[a-f0-9]{64}$/);
    const result = await persistCustomerAuthOtpChallenge(db, input);
    expect(result.resendAvailableAt - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(59);

    const row = sqlite.prepare("SELECT * FROM customer_auth_otp_challenges").get()!;
    expect(row).toMatchObject({ status: "pending", attempts: 0, identifier_masked: "b***@example.com", delivery_name_encrypted: null });
    expect(String(row.delivery_target_encrypted)).toMatch(/^enc:/);
    expect(JSON.stringify(row)).not.toMatch(/buyer@example\.com|123456/);
  });

  it("fails closed without a signing key and enforces the resend cooldown", async () => {
    await expect(persistCustomerAuthOtpChallenge(db, await challenge({ encryptionKey: undefined })))
      .rejects.toBeInstanceOf(ServiceUnavailableError);
    await persistCustomerAuthOtpChallenge(db, await challenge());
    await expect(persistCustomerAuthOtpChallenge(db, await challenge({ deliveryKey: "otp_delivery_2" })))
      .rejects.toBeInstanceOf(RateLimitError);
  });

  it("deletes a pending challenge after a failed queue handoff and cleans expired ones", async () => {
    const input = await challenge();
    await persistCustomerAuthOtpChallenge(db, input);
    await deleteCustomerAuthOtpChallenge(db, { otpKey: input.otpKey, deliveryKey: "other" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM customer_auth_otp_challenges").get()?.n).toBe(1);
    await deleteCustomerAuthOtpChallenge(db, { otpKey: input.otpKey, deliveryKey: input.deliveryKey });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM customer_auth_otp_challenges").get()?.n).toBe(0);

    await persistCustomerAuthOtpChallenge(db, input);
    const cleaned = await cleanupExpiredCustomerAuthOtpChallenges(db, Math.floor(Date.now() / 1000) + 301);
    expect(cleaned).toMatchObject({ deleted: 1, hasMore: false });
  });
});
