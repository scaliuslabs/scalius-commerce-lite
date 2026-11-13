// How long a staff (dashboard) session lives. Better Auth creates the row;
// the API reads it on every request (admin-auth), and that read is where the
// session slides: once a day of use at most, it is extended to a full
// lifetime from now, never past its absolute end. Ending a session (sign-out,
// revocation, suspension) deletes or refuses the row, so it holds at once.

import { and, eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { session as sessionTable } from "@scalius/database/schema";

/** A session unused for this long ends. */
export const STAFF_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A session is extended at most once per this long, so reads seldom write. */
export const STAFF_SESSION_RENEW_AFTER_SECONDS = 24 * 60 * 60;
/** No session outlives this, however often it is used. */
export const STAFF_SESSION_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export interface StaffSessionTimes {
  id: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The new end of a session that is due for renewal, or null while its last
 * extension is less than a renewal period old (or it is already at its
 * absolute end).
 */
export function staffSessionRenewal(session: StaffSessionTimes, nowMs = Date.now()): Date | null {
  const lastExtendedMs = session.expiresAt.getTime() - STAFF_SESSION_TTL_SECONDS * 1000;
  if (lastExtendedMs + STAFF_SESSION_RENEW_AFTER_SECONDS * 1000 > nowMs) return null;
  const endMs = Math.min(
    nowMs + STAFF_SESSION_TTL_SECONDS * 1000,
    session.createdAt.getTime() + STAFF_SESSION_MAX_LIFETIME_SECONDS * 1000,
  );
  // The column holds whole seconds.
  const expiresAt = new Date(Math.floor(endMs / 1000) * 1000);
  return expiresAt.getTime() > session.expiresAt.getTime() ? expiresAt : null;
}

/**
 * Extends a session that is due, in one statement guarded on the end it was
 * read with: concurrent requests extend it once, and a session deleted in the
 * meantime stays deleted. Returns the new end when this call extended it.
 */
export async function renewStaffSession(
  db: Database,
  session: StaffSessionTimes,
  nowMs = Date.now(),
): Promise<Date | null> {
  const expiresAt = staffSessionRenewal(session, nowMs);
  if (!expiresAt) return null;
  const renewed = await db
    .update(sessionTable)
    .set({ expiresAt, updatedAt: new Date(nowMs) })
    .where(and(eq(sessionTable.id, session.id), eq(sessionTable.expiresAt, session.expiresAt)))
    .returning({ id: sessionTable.id });
  return renewed.length > 0 ? expiresAt : null;
}
