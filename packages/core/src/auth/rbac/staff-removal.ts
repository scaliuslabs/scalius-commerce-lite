// Remove a staff member (Shopify "Remove staff"): their sign-in and access end
// for good, but the person row stays so orders, stock movements and other
// history keep naming who did what.

import { and, eq, like, sql } from "drizzle-orm";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  account,
  adminFcmTokens,
  adminInvitations,
  scannerTokenClaims,
  session,
  twoFactor,
  user,
  userPermissions,
  userRoles,
  verification,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { clearPermissionCache } from "./helpers";

/** The removed person's email is released so the address can be invited again. */
export function removedStaffEmail(userId: string): string {
  return `removed-${userId}@staff.invalid`;
}

export async function removeStaffMember(
  db: Database,
  input: { actorId: string; userId: string },
  kv?: KVNamespace,
): Promise<{ name: string }> {
  const { actorId, userId } = input;
  if (userId === actorId) throw new ValidationError("You can't remove yourself");

  const target = await db
    .select({ id: user.id, name: user.name, isSuperAdmin: user.isSuperAdmin })
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (!target) throw new NotFoundError("Staff member not found");
  if (target.isSuperAdmin) throw new ValidationError("The store owner can't be removed");

  const removedAt = new Date();
  try {
    await safeBatch(db, [
      // The owner check again, atomically with the writes.
      buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${user} WHERE ${user.id} = ${userId} AND ${user.isSuperAdmin} = ${false}
      )`, "STAFF_REMOVAL_CONFLICT"),
      db.delete(session).where(eq(session.userId, userId)),
      db.delete(account).where(eq(account.userId, userId)),
      db.delete(twoFactor).where(eq(twoFactor.userId, userId)),
      db.delete(userRoles).where(eq(userRoles.userId, userId)),
      db.delete(userPermissions).where(eq(userPermissions.userId, userId)),
      db.delete(adminFcmTokens).where(eq(adminFcmTokens.userId, userId)),
      db.delete(scannerTokenClaims).where(eq(scannerTokenClaims.adminId, userId)),
      db.delete(verification).where(and(
        like(verification.identifier, "reset-password:%"),
        eq(verification.value, userId),
      )),
      db.update(adminInvitations)
        .set({ status: "revoked", revokedAt: removedAt, updatedAt: removedAt })
        .where(and(eq(adminInvitations.userId, userId), eq(adminInvitations.status, "pending"))),
      db.update(user)
        .set({
          email: removedStaffEmail(userId),
          emailVerified: false,
          image: null,
          role: "user",
          banned: true,
          banReason: "Removed from staff",
          banExpires: null,
          twoFactorEnabled: false,
          twoFactorMethod: null,
          mustChangePassword: false,
          mustEnrollTwoFactor: false,
          updatedAt: removedAt,
        })
        .where(eq(user.id, userId)),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, "STAFF_REMOVAL_CONFLICT")) {
      throw new ConflictError("This person's access changed. Refresh and try again");
    }
    throw error;
  }

  await clearPermissionCache(userId, kv);
  return { name: target.name };
}
