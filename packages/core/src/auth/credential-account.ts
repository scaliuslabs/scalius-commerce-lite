import { hashPassword } from "better-auth/crypto";
import { and, eq, gt, sql } from "drizzle-orm";

import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  account,
  adminInvitations,
  adminSetupClaims,
  user,
  userRoles,
} from "@scalius/database/schema";

import { ConflictError, ValidationError } from "../errors";
import type { ClaimedAdminSetup } from "./admin-setup";

export const AUTH_PASSWORD_MIN_LENGTH = 12;
export const AUTH_PASSWORD_MAX_LENGTH = 128;
const SETUP_COMMIT_GUARD_CODE = "ADMIN_SETUP_CREDENTIAL_COMMIT_CONFLICT";

export interface PreparedCredentialIdentity {
  userId: string;
  accountRowId: string;
  name: string;
  normalizedEmail: string;
  passwordHash: string;
  createdAt: Date;
}

export interface PrepareCredentialIdentityInput {
  name: string;
  email: string;
  password: string;
  userId?: string;
  accountRowId?: string;
  createdAt?: Date;
}

export interface CreateInvitedAdminInput {
  invitedByUserId: string;
  roleId?: string;
  invitationId?: string;
  roleAssignmentId?: string;
}

export interface CompleteFirstAdminInput {
  nowSeconds?: number;
}

export class CredentialIdentityConflictError extends ConflictError {
  constructor() {
    super("A user with this email already exists");
    this.name = "CredentialIdentityConflictError";
  }
}

/**
 * Prepare Better Auth-compatible credential rows without performing writes.
 * Callers can compose the returned values into a larger provider-native batch
 * so user, credential, and domain state share one commit boundary.
 */
export async function prepareCredentialIdentity(
  input: PrepareCredentialIdentityInput,
): Promise<PreparedCredentialIdentity> {
  const name = input.name.trim();
  const normalizedEmail = input.email.trim().toLowerCase();

  if (!name) throw new ValidationError("Name is required");
  if (!normalizedEmail) throw new ValidationError("Email is required");
  if (
    input.password.length < AUTH_PASSWORD_MIN_LENGTH
    || input.password.length > AUTH_PASSWORD_MAX_LENGTH
  ) {
    throw new ValidationError(
      `Password must be between ${AUTH_PASSWORD_MIN_LENGTH} and ${AUTH_PASSWORD_MAX_LENGTH} characters`,
    );
  }

  return {
    userId: input.userId ?? crypto.randomUUID(),
    accountRowId: input.accountRowId ?? crypto.randomUUID(),
    name,
    normalizedEmail,
    passwordHash: await hashPassword(input.password),
    createdAt: input.createdAt ?? new Date(),
  };
}

/**
 * Create a blocked invited administrator, its credential, invitation, and
 * optional RBAC assignment in one atomic D1/Turso/PostgreSQL batch.
 */
export async function createInvitedAdminCredentialAccount(
  db: Database,
  credential: PreparedCredentialIdentity,
  input: CreateInvitedAdminInput,
): Promise<{ userId: string; invitationId: string; email: string }> {
  const invitationId = input.invitationId ?? `invite_${crypto.randomUUID()}`;
  const userInsert = db.insert(user).values({
    id: credential.userId,
    name: credential.name,
    email: credential.normalizedEmail,
    emailVerified: true,
    role: "admin",
    isSuperAdmin: false,
    mustChangePassword: true,
    mustEnrollTwoFactor: true,
    createdAt: credential.createdAt,
    updatedAt: credential.createdAt,
  });
  const accountInsert = db.insert(account).values({
    id: credential.accountRowId,
    userId: credential.userId,
    accountId: credential.userId,
    providerId: "credential",
    password: credential.passwordHash,
    createdAt: credential.createdAt,
    updatedAt: credential.createdAt,
  });
  const invitationInsert = db.insert(adminInvitations).values({
    id: invitationId,
    userId: credential.userId,
    invitedByUserId: input.invitedByUserId,
    name: credential.name,
    email: credential.normalizedEmail,
    status: "pending",
    deliveryStatus: "pending",
    createdAt: credential.createdAt,
    updatedAt: credential.createdAt,
  });

  try {
    if (input.roleId) {
      await safeBatch(db, [
        userInsert,
        accountInsert,
        invitationInsert,
        db.insert(userRoles).values({
          id: input.roleAssignmentId ?? crypto.randomUUID(),
          userId: credential.userId,
          roleId: input.roleId,
          assignedBy: input.invitedByUserId,
          createdAt: credential.createdAt,
        }),
      ] as const);
    } else {
      await safeBatch(db, [
        userInsert,
        accountInsert,
        invitationInsert,
      ] as const);
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new CredentialIdentityConflictError();
    }
    throw error;
  }

  return {
    userId: credential.userId,
    invitationId,
    email: credential.normalizedEmail,
  };
}

/**
 * Create the first administrator and consume the active setup claim in one
 * guarded provider-native transaction. A lost/expired claim rolls back both
 * Better Auth rows instead of leaving an orphan account for a recovery pass.
 */
export async function completeAdminSetupClaimWithCredentialIdentity(
  db: Database,
  claim: ClaimedAdminSetup,
  credential: PreparedCredentialIdentity,
  input: CompleteFirstAdminInput = {},
): Promise<void> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const completion = db
    .update(adminSetupClaims)
    .set({
      status: "completed",
      claimId: null,
      claimExpiresAt: null,
      completedUserId: credential.userId,
      lastError: null,
      updatedAt: nowSeconds,
    })
    .where(and(
      eq(adminSetupClaims.singletonKey, claim.singletonKey),
      eq(adminSetupClaims.claimId, claim.claimId),
      eq(adminSetupClaims.status, "processing"),
      gt(adminSetupClaims.claimExpiresAt, nowSeconds),
    ));
  const commitGuard = buildBatchGuard(db, sql`EXISTS (
    SELECT 1 FROM ${adminSetupClaims}
    WHERE ${adminSetupClaims.singletonKey} = ${claim.singletonKey}
      AND ${adminSetupClaims.status} = 'completed'
      AND ${adminSetupClaims.claimId} IS NULL
      AND ${adminSetupClaims.completedUserId} = ${credential.userId}
  )`, SETUP_COMMIT_GUARD_CODE);

  try {
    await safeBatch(db, [
      db.insert(user).values({
        id: credential.userId,
        name: credential.name,
        email: credential.normalizedEmail,
        emailVerified: true,
        role: "admin",
        isSuperAdmin: true,
        createdAt: credential.createdAt,
        updatedAt: credential.createdAt,
      }),
      db.insert(account).values({
        id: credential.accountRowId,
        userId: credential.userId,
        accountId: credential.userId,
        providerId: "credential",
        password: credential.passwordHash,
        createdAt: credential.createdAt,
        updatedAt: credential.createdAt,
      }),
      completion,
      commitGuard,
    ] as const);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new CredentialIdentityConflictError();
    }
    if (isBatchGuardError(error, SETUP_COMMIT_GUARD_CODE)) {
      throw new ConflictError(
        "Admin setup claim expired or was replaced before account creation completed.",
      );
    }
    throw error;
  }
}

export function isCredentialIdentityConflictError(
  error: unknown,
): error is CredentialIdentityConflictError {
  return error instanceof CredentialIdentityConflictError;
}

function isUniqueConstraintError(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return true;
  }

  return /(?:unique constraint|duplicate key value violates unique constraint|SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY))/i
    .test(errorDescription(error));
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return candidate.cause === undefined ? null : errorCode(candidate.cause);
}

function errorDescription(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause === undefined
      ? error.message
      : `${error.message} ${errorDescription(cause)}`;
  }
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";
    return candidate.cause === undefined
      ? message
      : `${message} ${errorDescription(candidate.cause)}`;
  }
  return String(error ?? "");
}
