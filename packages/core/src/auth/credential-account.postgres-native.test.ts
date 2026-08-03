import { randomUUID } from "node:crypto";

import { verifyPassword } from "better-auth/crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  connectNeonPostgres,
  createPostgresDatabase,
} from "@scalius/database/postgres-adapter";
import { safeBatch } from "@scalius/database/client";
import {
  account,
  adminInvitations,
  adminSetupClaims,
  roles,
  user,
  userRoles,
} from "@scalius/database/schema";

import {
  CredentialIdentityConflictError,
  completeAdminSetupClaimWithCredentialIdentity,
  createInvitedAdminCredentialAccount,
  prepareCredentialIdentity,
} from "./credential-account";
import { ConflictError } from "../errors";

// Opt-in because this suite mutates its target. Use only an isolated,
// disposable PostgreSQL database or branch; normal test runs stay offline.
const nativePostgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

describe.runIf(nativePostgresUrl)("native PostgreSQL credential conformance", () => {
  it("atomically creates a Better Auth-compatible invited administrator", async () => {
    const db = createPostgresDatabase(nativePostgresUrl!, {
      connect: connectNeonPostgres,
    });
    const scope = randomUUID().replaceAll("-", "");
    const inviterId = `credential_pg_inviter_${scope}`;
    const invitedUserId = `credential_pg_user_${scope}`;
    const duplicateUserId = `credential_pg_duplicate_${scope}`;
    const accountId = `credential_pg_account_${scope}`;
    const duplicateAccountId = `credential_pg_duplicate_account_${scope}`;
    const invitationId = `credential_pg_invite_${scope}`;
    const duplicateInvitationId = `credential_pg_duplicate_invite_${scope}`;
    const setupClaimKey = `credential_pg_setup_${scope}`;
    const setupClaimId = `credential_pg_setup_claim_${scope}`;
    const setupUserId = `credential_pg_setup_user_${scope}`;
    const setupAccountId = `credential_pg_setup_account_${scope}`;
    const expiredClaimKey = `credential_pg_expired_${scope}`;
    const expiredClaimId = `credential_pg_expired_claim_${scope}`;
    const orphanUserId = `credential_pg_orphan_user_${scope}`;
    const orphanAccountId = `credential_pg_orphan_account_${scope}`;
    const roleId = `credential_pg_role_${scope}`;
    const roleAssignmentId = `credential_pg_user_role_${scope}`;
    const email = `credential-pg-${scope}@example.test`;
    const password = "NativePostgresCredential123!";
    const createdAt = new Date();

    try {
      await safeBatch(db, [
        db.insert(user).values({
          id: inviterId,
          name: "PostgreSQL test owner",
          email: `credential-pg-owner-${scope}@example.test`,
          emailVerified: true,
          role: "admin",
          isSuperAdmin: true,
          createdAt,
          updatedAt: createdAt,
        }),
        db.insert(roles).values({
          id: roleId,
          name: roleId,
          displayName: "PostgreSQL credential test role",
          createdAt,
          updatedAt: createdAt,
        }),
      ] as const);

      const credential = await prepareCredentialIdentity({
        userId: invitedUserId,
        accountRowId: accountId,
        name: "Native PostgreSQL Admin",
        email: email.toUpperCase(),
        password,
        createdAt,
      });
      await createInvitedAdminCredentialAccount(db, credential, {
        invitedByUserId: inviterId,
        roleId,
        invitationId,
        roleAssignmentId,
      });

      const storedAccount = await db.select({
        providerId: account.providerId,
        accountId: account.accountId,
        password: account.password,
      }).from(account).where(eq(account.id, accountId)).get();
      expect(storedAccount).toMatchObject({
        providerId: "credential",
        accountId: invitedUserId,
      });
      expect(await verifyPassword({
        hash: storedAccount?.password ?? "",
        password,
      })).toBe(true);

      const duplicate = await prepareCredentialIdentity({
        userId: duplicateUserId,
        accountRowId: duplicateAccountId,
        name: "Duplicate PostgreSQL Admin",
        email,
        password,
        createdAt,
      });
      await expect(createInvitedAdminCredentialAccount(db, duplicate, {
        invitedByUserId: inviterId,
        invitationId: duplicateInvitationId,
      })).rejects.toBeInstanceOf(CredentialIdentityConflictError);
      await expect(db.select({ id: user.id })
        .from(user)
        .where(eq(user.id, duplicateUserId))
        .get()).resolves.toBeUndefined();

      const nowSeconds = Math.floor(Date.now() / 1_000);
      await safeBatch(db, [
        db.insert(adminSetupClaims).values({
          singletonKey: setupClaimKey,
          status: "processing",
          claimId: setupClaimId,
          claimExpiresAt: nowSeconds + 60,
          createdAt: nowSeconds,
          updatedAt: nowSeconds,
        }),
        db.insert(adminSetupClaims).values({
          singletonKey: expiredClaimKey,
          status: "processing",
          claimId: expiredClaimId,
          claimExpiresAt: nowSeconds - 1,
          createdAt: nowSeconds - 120,
          updatedAt: nowSeconds - 120,
        }),
      ] as const);
      const setupCredential = await prepareCredentialIdentity({
        userId: setupUserId,
        accountRowId: setupAccountId,
        name: "Native PostgreSQL First Admin",
        email: `credential-pg-setup-${scope}@example.test`,
        password,
        createdAt,
      });
      await completeAdminSetupClaimWithCredentialIdentity(
        db,
        { singletonKey: setupClaimKey as "first_admin", claimId: setupClaimId },
        setupCredential,
        { nowSeconds },
      );
      await expect(db.select({
        status: adminSetupClaims.status,
        completedUserId: adminSetupClaims.completedUserId,
      }).from(adminSetupClaims).where(eq(
        adminSetupClaims.singletonKey,
        setupClaimKey,
      )).get()).resolves.toEqual({
        status: "completed",
        completedUserId: setupUserId,
      });

      const orphanCredential = await prepareCredentialIdentity({
        userId: orphanUserId,
        accountRowId: orphanAccountId,
        name: "Native PostgreSQL Orphan",
        email: `credential-pg-orphan-${scope}@example.test`,
        password,
        createdAt,
      });
      await expect(completeAdminSetupClaimWithCredentialIdentity(
        db,
        {
          singletonKey: expiredClaimKey as "first_admin",
          claimId: expiredClaimId,
        },
        orphanCredential,
        { nowSeconds },
      )).rejects.toBeInstanceOf(ConflictError);
      await expect(db.select({ id: user.id })
        .from(user)
        .where(eq(user.id, orphanUserId))
        .get()).resolves.toBeUndefined();
    } finally {
      await db.delete(userRoles).where(inArray(userRoles.id, [roleAssignmentId]));
      await db.delete(adminInvitations).where(inArray(adminInvitations.id, [
        invitationId,
        duplicateInvitationId,
      ]));
      await db.delete(account).where(inArray(account.id, [
        accountId,
        duplicateAccountId,
        setupAccountId,
        orphanAccountId,
      ]));
      await db.delete(adminSetupClaims).where(inArray(
        adminSetupClaims.singletonKey,
        [setupClaimKey, expiredClaimKey],
      ));
      await db.delete(roles).where(eq(roles.id, roleId));
      await db.delete(user).where(inArray(user.id, [
        invitedUserId,
        duplicateUserId,
        setupUserId,
        orphanUserId,
        inviterId,
      ]));
    }
  });
});
