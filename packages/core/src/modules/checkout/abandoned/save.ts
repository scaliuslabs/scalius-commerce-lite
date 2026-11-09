import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import { abandonedCheckouts, checkoutAttempts } from "@scalius/database/schema";
import { checkoutAttemptRequestKey } from "../attempts";
import { abandonedCheckoutConsentBox, type NormalizedAbandonedCheckoutSnapshot } from "./snapshot";

/**
 * Saves a checkout's snapshot (the storefront's debounced autosave): inserts
 * its row, or updates the contact and data of the session's existing one. A
 * session that already placed its order (its checkout attempt exists) writes
 * nothing, in the same statement, so a save that lands after the order never
 * brings back the row the order's batch deleted. One statement, run as a
 * batch so PostgreSQL serializes it against the order's batch.
 */
export async function saveAbandonedCheckoutSnapshot(
    db: Database,
    snapshot: Pick<NormalizedAbandonedCheckoutSnapshot, "checkoutId" | "customerPhone" | "checkoutDataString">,
): Promise<void> {
    const requestKey = await checkoutAttemptRequestKey(snapshot.checkoutId);
    // Every column in table order: id, checkout_id, customer_phone,
    // checkout_data, abandoned_at, created_at, updated_at.
    await safeBatch(db, [
        db.insert(abandonedCheckouts)
            .select(sql`
                SELECT
                    ${`ab_ch_${nanoid()}`},
                    ${snapshot.checkoutId},
                    ${snapshot.customerPhone},
                    ${snapshot.checkoutDataString},
                    NULL,
                    unixepoch(),
                    unixepoch()
                WHERE NOT EXISTS (
                    SELECT 1 FROM ${checkoutAttempts}
                    WHERE ${checkoutAttempts.requestKey} = ${requestKey}
                )
            `)
            .onConflictDoUpdate({
                target: abandonedCheckouts.checkoutId,
                set: {
                    customerPhone: sql.raw("excluded.customer_phone"),
                    checkoutData: sql.raw("excluded.checkout_data"),
                    updatedAt: sql.raw("excluded.updated_at"),
                },
            }),
    ]);
}

/**
 * The consent box the session's last saved snapshot carried (null without
 * one, or for a session whose order removed it): what a new save is compared
 * with, so the box is applied only when the buyer changes it.
 */
export async function readAbandonedCheckoutConsentBox(db: Database, checkoutId: string): Promise<ReturnType<typeof abandonedCheckoutConsentBox> | null> {
    const row = await db.select({ data: abandonedCheckouts.checkoutData }).from(abandonedCheckouts)
        .where(eq(abandonedCheckouts.checkoutId, checkoutId)).get();
    if (!row) return null;
    try {
        const parsed = JSON.parse(row.data) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? abandonedCheckoutConsentBox(parsed as Record<string, unknown>) ?? null : null;
    } catch {
        return null;
    }
}
