import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";

const TOTP_ISSUER = "Scalius Commerce";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TWO_FACTOR_METHOD_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const TWO_FACTOR_METHOD_CHALLENGE_PREFIX = "tfmc_";
export const TWO_FACTOR_METHOD_CHALLENGE_PURPOSE = "admin:2fa-method";

export interface PendingTotpMethodChallenge {
  version: 1;
  userId: string;
  sessionId: string;
  method: "totp";
  secret: string;
  encryptedSecret: string;
  backupCodes: string[];
  storedBackupCodes: string;
  expiresAt: number;
}

export interface PendingEmailMethodChallenge {
  version: 1;
  userId: string;
  sessionId: string;
  method: "email";
  expiresAt: number;
}

export type PendingTwoFactorMethodChallenge =
  | PendingTotpMethodChallenge
  | PendingEmailMethodChallenge;

export interface CreatedTotpMethodChallenge {
  challengeId: string;
  identifier: string;
  encryptedValue: string;
  totpUri: string;
  expiresAt: Date;
}

export interface CreatedEmailMethodChallenge {
  challengeId: string;
  identifier: string;
  encryptedValue: string;
  expiresAt: Date;
}

export function getTwoFactorMethodChallengeIdentifier(
  userId: string,
  sessionId: string,
): string {
  return `${TWO_FACTOR_METHOD_CHALLENGE_PURPOSE}:${userId}:${sessionId}`;
}

export function createTwoFactorRecoveryCodeStorage(authSecret: string) {
  return {
    encrypt: (value: string) =>
      symmetricEncrypt({ key: authSecret, data: value }),
    decrypt: (value: string) => {
      // Better Auth stored recovery-code JSON in plaintext before encrypted
      // storage was enabled. Read that legacy shape, but encrypt every write.
      if (value.trimStart().startsWith("[")) return Promise.resolve(value);
      return symmetricDecrypt({ key: authSecret, data: value });
    },
  };
}

async function createBackupCodes(authSecret: string): Promise<{
  backupCodes: string[];
  storedBackupCodes: string;
}> {
  // Match Better Auth's recovery-code format so the existing verifier can
  // consume these codes after the staged method change is committed.
  const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const value = generateRandomString(
      BACKUP_CODE_LENGTH,
      "a-z",
      "0-9",
      "A-Z",
    );
    return `${value.slice(0, 5)}-${value.slice(5)}`;
  });
  const storedBackupCodes = await createTwoFactorRecoveryCodeStorage(
    authSecret,
  ).encrypt(JSON.stringify(backupCodes));

  return { backupCodes, storedBackupCodes };
}

function encodeBase32(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bits = 0;
  let buffer = 0;
  let encoded = "";

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }

  if (bits > 0) {
    encoded += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }

  return encoded;
}

export function buildTotpUri(secret: string, email: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret: encodeBase32(secret),
    issuer: TOTP_ISSUER,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export async function createPendingTotpMethodChallenge(input: {
  authSecret: string;
  userId: string;
  sessionId: string;
  email: string;
  now?: Date;
}): Promise<CreatedTotpMethodChallenge> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TWO_FACTOR_METHOD_CHALLENGE_TTL_MS);
  const secret = generateRandomString(32);
  const encryptedSecret = await symmetricEncrypt({
    key: input.authSecret,
    data: secret,
  });
  const backupCodeResult = await createBackupCodes(input.authSecret);
  const payload: PendingTotpMethodChallenge = {
    version: 1,
    userId: input.userId,
    sessionId: input.sessionId,
    method: "totp",
    secret,
    encryptedSecret,
    backupCodes: backupCodeResult.backupCodes,
    storedBackupCodes: backupCodeResult.storedBackupCodes,
    expiresAt: expiresAt.getTime(),
  };
  const encryptedValue = await symmetricEncrypt({
    key: input.authSecret,
    data: JSON.stringify(payload),
  });

  return {
    challengeId: `${TWO_FACTOR_METHOD_CHALLENGE_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
    identifier: getTwoFactorMethodChallengeIdentifier(
      input.userId,
      input.sessionId,
    ),
    encryptedValue,
    totpUri: buildTotpUri(secret, input.email),
    expiresAt,
  };
}

export async function createPendingEmailMethodChallenge(input: {
  authSecret: string;
  userId: string;
  sessionId: string;
  now?: Date;
}): Promise<CreatedEmailMethodChallenge> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TWO_FACTOR_METHOD_CHALLENGE_TTL_MS);
  const payload: PendingEmailMethodChallenge = {
    version: 1,
    userId: input.userId,
    sessionId: input.sessionId,
    method: "email",
    expiresAt: expiresAt.getTime(),
  };

  return {
    challengeId: `${TWO_FACTOR_METHOD_CHALLENGE_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
    identifier: getTwoFactorMethodChallengeIdentifier(
      input.userId,
      input.sessionId,
    ),
    encryptedValue: await symmetricEncrypt({
      key: input.authSecret,
      data: JSON.stringify(payload),
    }),
    expiresAt,
  };
}

function isPendingTotpMethodChallenge(
  value: unknown,
): value is PendingTotpMethodChallenge {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingTotpMethodChallenge>;
  return (
    candidate.version === 1 &&
    candidate.method === "totp" &&
    typeof candidate.userId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.secret === "string" &&
    candidate.secret.length >= 32 &&
    typeof candidate.encryptedSecret === "string" &&
    Array.isArray(candidate.backupCodes) &&
    candidate.backupCodes.length === BACKUP_CODE_COUNT &&
    candidate.backupCodes.every((code) => typeof code === "string") &&
    typeof candidate.storedBackupCodes === "string" &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt)
  );
}

function isPendingEmailMethodChallenge(
  value: unknown,
): value is PendingEmailMethodChallenge {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingEmailMethodChallenge>;
  return (
    candidate.version === 1 &&
    candidate.method === "email" &&
    typeof candidate.userId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt)
  );
}

export async function readPendingTwoFactorMethodChallenge(input: {
  authSecret: string;
  encryptedValue: string;
  userId: string;
  sessionId: string;
  expectedMethod: "totp" | "email";
  now?: Date;
}): Promise<PendingTwoFactorMethodChallenge | null> {
  try {
    const decrypted = await symmetricDecrypt({
      key: input.authSecret,
      data: input.encryptedValue,
    });
    const parsed = JSON.parse(decrypted) as unknown;
    const now = input.now ?? new Date();
    let payload: PendingTwoFactorMethodChallenge;
    if (input.expectedMethod === "totp") {
      if (!isPendingTotpMethodChallenge(parsed)) return null;
      payload = parsed;
    } else {
      if (!isPendingEmailMethodChallenge(parsed)) return null;
      payload = parsed;
    }
    if (
      payload.method !== input.expectedMethod ||
      payload.userId !== input.userId ||
      payload.sessionId !== input.sessionId ||
      payload.expiresAt <= now.getTime()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function readPendingTotpMethodChallenge(input: {
  authSecret: string;
  encryptedValue: string;
  userId: string;
  sessionId: string;
  now?: Date;
}): Promise<PendingTotpMethodChallenge | null> {
  const pending = await readPendingTwoFactorMethodChallenge({
    ...input,
    expectedMethod: "totp",
  });
  return pending?.method === "totp" ? pending : null;
}

export async function verifyPendingTotpCode(
  secret: string,
  code: string,
): Promise<boolean> {
  return createOTP(secret, {
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).verify(code, { window: 1 });
}
