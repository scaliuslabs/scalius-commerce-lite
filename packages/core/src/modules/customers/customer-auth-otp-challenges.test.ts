import { describe, expect, it, vi } from "vitest";
import { RateLimitError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";

import {
  claimCustomerAuthOtpChallenge,
  cleanupExpiredCustomerAuthOtpChallenges,
  deleteCustomerAuthOtpChallenge,
  persistCustomerAuthOtpChallenge,
} from "./customer-auth-otp-challenges";

function createDb(options: {
  insertRows?: unknown[];
  updateRows?: unknown[][];
  selectGet?: unknown;
  selectRows?: unknown[];
} = {}) {
  const updateRows = [...(options.updateRows ?? [])];
  const calls = {
    insertValues: undefined as unknown,
    onConflictDoUpdate: undefined as unknown,
    updateSets: [] as unknown[],
    deleteWhereCalls: 0,
  };

  return {
    calls,
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        calls.insertValues = values;
        return {
          onConflictDoUpdate: vi.fn((config: unknown) => {
            calls.onConflictDoUpdate = config;
            return {
              returning: vi.fn(async () => options.insertRows ?? []),
            };
          }),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        calls.updateSets.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateRows.shift() ?? []),
          })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => options.selectGet ?? null),
          limit: vi.fn(async () => options.selectRows ?? []),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        calls.deleteWhereCalls += 1;
      }),
    })),
  };
}

describe("customer auth OTP D1 challenges", () => {
  it("persists hashed OTP challenge state without storing the plaintext code", async () => {
    const db = createDb({
      insertRows: [{
        otpKey: "cust_otp:email:buyer@example.com",
        deliveryKey: "otp_delivery_1",
        expiresAt: 4_102_444_800,
      }],
    });

    const result = await persistCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:email:buyer@example.com",
      deliveryKey: "otp_delivery_1",
      method: "email",
      channel: "email",
      intent: "sign_in",
      identifier: "buyer@example.com",
      contactEmail: "buyer@example.com",
      code: "123456",
      encryptionKey: "test-signing-key",
      ttlSeconds: 300,
      resendCooldownSeconds: 120,
      maxAttempts: 5,
    });

    expect(result).toMatchObject({
      otpKey: "cust_otp:email:buyer@example.com",
      deliveryKey: "otp_delivery_1",
    });
    expect(db.calls.insertValues).toMatchObject({
      otpKey: "cust_otp:email:buyer@example.com",
      deliveryKey: "otp_delivery_1",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
    });
    expect((db.calls.insertValues as { codeHash: string }).codeHash).not.toBe("123456");
    expect((db.calls.insertValues as { codeHash: string }).codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.calls.onConflictDoUpdate).toBeDefined();
  });

  it("fails closed before persistence when the OTP signing key is missing", async () => {
    const db = createDb();

    await expect(persistCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:email:buyer@example.com",
      deliveryKey: "otp_delivery_1",
      method: "email",
      channel: "email",
      intent: "sign_in",
      identifier: "buyer@example.com",
      code: "123456",
      ttlSeconds: 300,
      resendCooldownSeconds: 120,
      maxAttempts: 5,
    })).rejects.toBeInstanceOf(ServiceUnavailableError);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("turns a no-op cooldown upsert into a rate limit error", async () => {
    const db = createDb({ insertRows: [] });

    await expect(persistCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:email:buyer@example.com",
      deliveryKey: "otp_delivery_1",
      method: "email",
      channel: "email",
      intent: "sign_in",
      identifier: "buyer@example.com",
      code: "123456",
      encryptionKey: "test-signing-key",
      ttlSeconds: 300,
      resendCooldownSeconds: 120,
      maxAttempts: 5,
    })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("claims a correct OTP by consuming the challenge in one guarded update", async () => {
    const db = createDb({
      updateRows: [[{
        otpKey: "cust_otp:sms:+8801712345678",
        method: "phone",
        channel: "sms",
        intent: "sign_up",
        identifier: "+8801712345678",
        contactEmail: "buyer@example.com",
        phone: "+8801712345678",
        expiresAt: 4_102_444_800,
        attempts: 1,
        maxAttempts: 5,
      }]],
    });

    const result = await claimCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      encryptionKey: "test-signing-key",
    });

    expect(result).toMatchObject({
      intent: "sign_up",
      identifier: "+8801712345678",
      contactEmail: "buyer@example.com",
    });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.calls.updateSets[0]).toMatchObject({ status: "consumed" });
  });

  it("increments wrong OTP attempts and returns attempts left", async () => {
    const db = createDb({
      updateRows: [
        [],
        [{ attempts: 2, maxAttempts: 5, status: "pending" }],
      ],
    });

    await expect(claimCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "000000",
      encryptionKey: "test-signing-key",
    })).rejects.toMatchObject({
      message: "Incorrect code. Please try again.",
      details: { attemptsLeft: 3 },
    });

    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it("locks the challenge after the final wrong attempt", async () => {
    const db = createDb({
      updateRows: [
        [],
        [{ attempts: 5, maxAttempts: 5, status: "locked" }],
      ],
    });

    await expect(claimCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "000000",
      encryptionKey: "test-signing-key",
    })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("rejects already consumed challenges without touching customer state", async () => {
    const db = createDb({
      updateRows: [[], []],
      selectGet: {
        otpKey: "cust_otp:sms:+8801712345678",
        method: "phone",
        channel: "sms",
        identifier: "+8801712345678",
        status: "consumed",
        attempts: 1,
        maxAttempts: 5,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      },
    });

    await expect(claimCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      encryptionKey: "test-signing-key",
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(claimCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      encryptionKey: "test-signing-key",
    })).rejects.toThrow("Verification code has already been used. Please request a new code.");
  });

  it("deletes failed queue handoff challenges only by matching otp and delivery keys", async () => {
    const db = createDb();

    await deleteCustomerAuthOtpChallenge(db as never, {
      otpKey: "cust_otp:email:buyer@example.com",
      deliveryKey: "otp_delivery_1",
    });

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.calls.deleteWhereCalls).toBe(1);
  });

  it("bounds scheduled cleanup batches and reports whether more work remains", async () => {
    const db = createDb({
      selectRows: [
        { otpKey: "otp_1" },
        { otpKey: "otp_2" },
        { otpKey: "otp_3" },
      ],
    });

    const result = await cleanupExpiredCustomerAuthOtpChallenges(db as never, 4_102_444_800, {
      limit: 2,
    });

    expect(result).toEqual({
      scanned: 2,
      deleted: 2,
      limit: 2,
      hasMore: true,
    });
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});
