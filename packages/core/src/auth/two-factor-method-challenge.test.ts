import { describe, expect, it } from "vitest";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

import {
  buildTotpUri,
  createPendingEmailMethodChallenge,
  createPendingTotpMethodChallenge,
  createTwoFactorRecoveryCodeStorage,
  getTwoFactorMethodChallengeIdentifier,
  readPendingTotpMethodChallenge,
  readPendingTwoFactorMethodChallenge,
  TWO_FACTOR_METHOD_CHALLENGE_TTL_MS,
  verifyPendingTotpCode,
} from "./two-factor-method-challenge";
import { createOTP } from "@better-auth/utils/otp";

const AUTH_SECRET = "test-better-auth-secret-with-enough-entropy";
const NOW = new Date("2026-07-13T12:00:00.000Z");

describe("staged TOTP method challenge", () => {
  it("keeps raw and Better Auth recovery material inside one encrypted payload", async () => {
    const created = await createPendingTotpMethodChallenge({
      authSecret: AUTH_SECRET,
      userId: "user_1",
      sessionId: "session_1",
      email: "admin@example.com",
      now: NOW,
    });

    expect(created.challengeId).toMatch(/^tfmc_[a-f0-9]{32}$/);
    expect(created.identifier).toBe("admin:2fa-method:user_1:session_1");
    expect(created.encryptedValue).not.toContain("admin@example.com");
    expect(created.expiresAt.getTime()).toBe(
      NOW.getTime() + TWO_FACTOR_METHOD_CHALLENGE_TTL_MS,
    );

    const pending = await readPendingTotpMethodChallenge({
      authSecret: AUTH_SECRET,
      encryptedValue: created.encryptedValue,
      userId: "user_1",
      sessionId: "session_1",
      now: NOW,
    });
    expect(pending?.backupCodes).toHaveLength(10);
    expect(pending?.storedBackupCodes).not.toContain(
      pending?.backupCodes[0] ?? "missing",
    );

    const storage = createTwoFactorRecoveryCodeStorage(AUTH_SECRET);
    await expect(storage.decrypt(pending?.storedBackupCodes ?? "")).resolves.toBe(
      JSON.stringify(pending?.backupCodes),
    );
  });

  it("binds the challenge to the initiating user and current session", async () => {
    const created = await createPendingTotpMethodChallenge({
      authSecret: AUTH_SECRET,
      userId: "user_1",
      sessionId: "session_1",
      email: "admin@example.com",
      now: NOW,
    });

    await expect(
      readPendingTotpMethodChallenge({
        authSecret: AUTH_SECRET,
        encryptedValue: created.encryptedValue,
        userId: "user_2",
        sessionId: "session_1",
        now: NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      readPendingTotpMethodChallenge({
        authSecret: AUTH_SECRET,
        encryptedValue: created.encryptedValue,
        userId: "user_1",
        sessionId: "session_2",
        now: NOW,
      }),
    ).resolves.toBeNull();
  });

  it("stages email changes without replacing authenticator authority", async () => {
    const created = await createPendingEmailMethodChallenge({
      authSecret: AUTH_SECRET,
      userId: "user_1",
      sessionId: "session_1",
      now: NOW,
    });

    const pending = await readPendingTwoFactorMethodChallenge({
      authSecret: AUTH_SECRET,
      encryptedValue: created.encryptedValue,
      userId: "user_1",
      sessionId: "session_1",
      expectedMethod: "email",
      now: NOW,
    });
    expect(pending).toEqual({
      version: 1,
      userId: "user_1",
      sessionId: "session_1",
      method: "email",
      expiresAt: created.expiresAt.getTime(),
    });
    await expect(
      readPendingTwoFactorMethodChallenge({
        authSecret: AUTH_SECRET,
        encryptedValue: created.encryptedValue,
        userId: "user_1",
        sessionId: "session_1",
        expectedMethod: "totp",
        now: NOW,
      }),
    ).resolves.toBeNull();
  });

  it("rejects expired and unreadable challenge payloads", async () => {
    const created = await createPendingTotpMethodChallenge({
      authSecret: AUTH_SECRET,
      userId: "user_1",
      sessionId: "session_1",
      email: "admin@example.com",
      now: NOW,
    });

    await expect(
      readPendingTotpMethodChallenge({
        authSecret: AUTH_SECRET,
        encryptedValue: created.encryptedValue,
        userId: "user_1",
        sessionId: "session_1",
        now: created.expiresAt,
      }),
    ).resolves.toBeNull();
    await expect(
      readPendingTotpMethodChallenge({
        authSecret: "wrong-secret",
        encryptedValue: created.encryptedValue,
        userId: "user_1",
        sessionId: "session_1",
        now: NOW,
      }),
    ).resolves.toBeNull();
  });

  it("keeps legacy plaintext recovery rows readable while encrypting new rows", async () => {
    const storage = createTwoFactorRecoveryCodeStorage(AUTH_SECRET);
    const legacy = '["legacy-code"]';
    await expect(storage.decrypt(legacy)).resolves.toBe(legacy);

    const encrypted = await storage.encrypt('["new-code"]');
    expect(encrypted).not.toContain("new-code");
    await expect(storage.decrypt(encrypted)).resolves.toBe('["new-code"]');
  });

  it("builds a standards-shaped URI without exposing the raw secret", () => {
    const uri = buildTotpUri("raw-secret", "admin+ops@example.com");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("issuer=Scalius+Commerce");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).not.toContain("raw-secret");
  });

  it("fails closed for a structurally valid encrypted payload with the wrong purpose data", async () => {
    const encryptedValue = await symmetricEncrypt({
      key: AUTH_SECRET,
      data: JSON.stringify({ version: 1, method: "email" }),
    });
    expect(await symmetricDecrypt({ key: AUTH_SECRET, data: encryptedValue })).toContain(
      '"email"',
    );
    await expect(
      readPendingTotpMethodChallenge({
        authSecret: AUTH_SECRET,
        encryptedValue,
        userId: "user_1",
        sessionId: "session_1",
        now: NOW,
      }),
    ).resolves.toBeNull();
  });

  it("uses a stable ownership identifier", () => {
    expect(getTwoFactorMethodChallengeIdentifier("u", "s")).toBe(
      "admin:2fa-method:u:s",
    );
  });

  it("uses the same one-step clock tolerance as the Better Auth verifier", async () => {
    const secret = "a-32-character-secret-for-totp!";
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    await expect(verifyPendingTotpCode(secret, code)).resolves.toBe(true);
    await expect(verifyPendingTotpCode(secret, "000000")).resolves.toBe(false);
  });
});
