// A sign-in reset: the one action that changes how a buyer signs in on their
// behalf, for a buyer who lost every way in. Ordinary customer edits never
// touch a proven sign-in (`updateCustomer` refuses it with
// `contact_is_sign_in`). Staff with the sensitive `customers.reset_sign_in`
// permission name ONE recovery contact; an agent's call always waits for the
// merchant's approval, and an app cannot make it (the route refuses).
import { and, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import { customerHistory, customerIdentities, customers, customerSessions } from "@scalius/database/schema";
import { storedPhone } from "@scalius/shared/customer-auth-policy";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../errors";
import { normalizeContactEmail } from "./customer-identity";

/** How long a recovery contact reaches its account, from the reset. */
export const SIGN_IN_RECOVERY_DAYS = 7;
const RECOVERY_SECONDS = SIGN_IN_RECOVERY_DAYS * 24 * 60 * 60;

export type SignInRecoveryContact = { phone: string; email?: never } | { email: string; phone?: never };

/**
 * The account a sign-in code to `identifier` recovers: the one live, claimed
 * account a reset named it on, that proves nothing at all (no proven phone
 * or email) and was reset under `SIGN_IN_RECOVERY_DAYS` ago. Ids only; one
 * search of `customers_recovery_phone_idx` / `customers_recovery_email_idx`.
 */
export function recoveryOwnerQuery(db: Database, method: "email" | "phone", identifier: string) {
    return db.select({ id: customers.id })
        .from(customers)
        .where(and(
            method === "email"
                ? and(eq(customers.signInRecovery, "email"), sql`lower(${customers.email}) = ${identifier}`)
                : and(eq(customers.signInRecovery, "phone"), eq(customers.phone, identifier)),
            isNull(customers.deletedAt),
            isNotNull(customers.accountClaimedAt),
            isNull(customers.phoneVerifiedAt),
            isNull(customers.emailVerifiedAt),
            gt(customers.signInRecoveryAt, sql`unixepoch() - ${RECOVERY_SECONDS}`),
        ))
        .limit(2);
}

/**
 * Resets how a customer signs in, in one batch: every proof on the account
 * (phone and email) is cleared, its linked app identities are deleted, every
 * session is revoked, the one recovery contact is set and marked with the
 * time, and the change is written to the customer's history naming the actor
 * (`actorId`: a staff id, or `agent:<grant>:<owner>` for an approved agent).
 * Refused when the contact is proven on any other account, live or closed,
 * or is another account's recovery contact.
 */
export async function resetCustomerSignIn(
    db: Database,
    customerId: string,
    input: { contact: SignInRecoveryContact; actorId: string },
): Promise<{ recovery: "phone" | "email"; expiresAt: number }> {
    const existing = await db.select().from(customers).where(eq(customers.id, customerId)).get();
    if (!existing || existing.deletedAt) throw new NotFoundError("Customer not found");
    if (existing.erasedAt) throw new ConflictError("This customer's data was erased.", { reason: "customer_erased" });
    if (!existing.accountClaimedAt) {
        throw new ValidationError("Only a customer account signs in. This customer has no account to reset.", { reason: "no_account" });
    }
    const method: "phone" | "email" = input.contact.phone !== undefined ? "phone" : "email";
    const value = method === "phone" ? storedPhone(input.contact.phone!.trim()) : normalizeContactEmail(input.contact.email);
    if (!value) throw new ValidationError(`Enter the ${method} the customer will sign in with.`, { field: method, reason: "recovery_contact_required" });

    // The same answer for a phone and an email, a live and a closed account.
    const taken = await db.select({ id: customers.id }).from(customers).where(and(
        ne(customers.id, customerId),
        method === "phone" ? eq(customers.phone, value) : sql`lower(${customers.email}) = ${value}`,
        or(
            method === "phone" ? isNotNull(customers.phoneVerifiedAt) : isNotNull(customers.emailVerifiedAt),
            eq(customers.signInRecovery, method),
        ),
    )).limit(1).get();
    if (taken) {
        throw new ConflictError(`This ${method} signs in to another account. Use a contact the customer alone holds.`, {
            field: method,
            reason: "recovery_contact_taken",
            allowed: [method === "phone" ? "email" : "phone"],
        });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + RECOVERY_SECONDS;
    try {
        await safeBatch(db, [
            db.update(customers).set({
                ...(method === "phone" ? { phone: value } : { email: value }),
                phoneVerifiedAt: null,
                emailVerifiedAt: null,
                signInRecovery: method,
                signInRecoveryAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }).where(and(eq(customers.id, customerId), isNull(customers.erasedAt))),
            db.delete(customerIdentities).where(eq(customerIdentities.customerId, customerId)),
            db.update(customerSessions).set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt))),
            db.insert(customerHistory).select(db.select({
                id: sql<string>`${`hist_${nanoid()}`}`.as("id"),
                customerId: customers.id,
                name: customers.name,
                email: customers.email,
                phone: customers.phone,
                changeType: sql<string>`'updated'`.as("change_type"),
                orderId: sql<string | null>`NULL`.as("order_id"),
                relatedCustomerId: sql<string | null>`NULL`.as("related_customer_id"),
                verifiedContact: sql<string | null>`NULL`.as("verified_contact"),
                actor: sql<string>`'staff'`.as("actor"),
                actorId: sql<string>`${input.actorId}`.as("actor_id"),
                createdAt: sql<number>`unixepoch()`.as("created_at"),
            }).from(customers).where(eq(customers.id, customerId))),
        ] as unknown as Parameters<typeof safeBatch>[1]);
    } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
            throw new AppError(409, "recovery_contact_taken", `This ${method} belongs to another customer record.`, {
                field: method,
                reason: "recovery_contact_taken",
                allowed: [method === "phone" ? "email" : "phone"],
            });
        }
        throw error;
    }
    return { recovery: method, expiresAt };
}
