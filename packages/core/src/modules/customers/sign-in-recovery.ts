// A sign-in reset: the one action that changes how a buyer signs in on their
// behalf, for a buyer who lost every way in. Ordinary customer edits never
// touch a sign-in contact, proven or a live recovery contact (`updateCustomer`
// refuses it with `contact_is_sign_in`). Staff with the sensitive
// `customers.reset_sign_in` permission name ONE recovery contact; an agent's
// call always waits for the merchant's approval, and an app cannot make it
// (the route refuses).
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import { customerHistory, customers, customerSessions } from "@scalius/database/schema";
import { isEmailAddress } from "@scalius/shared/text-scan";
import { parseContactPhone } from "@scalius/shared/customer-utils";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../errors";
import { readSignInPolicy } from "./sign-in-policy";
import { isSignInChangedError, liveRecovery, resetSignInWrites, SIGN_IN_RECOVERY_SECONDS, signInChangedConflict } from "./sign-in-writes";

export type SignInRecoveryContact = { phone: string; email?: never } | { email: string; phone?: never };

/**
 * The account a sign-in code to `identifier` recovers: the one live, claimed
 * account a reset named it on, that proves nothing at all (no proven phone
 * or email) and was reset under `SIGN_IN_RECOVERY_DAYS` ago. The contact
 * holds exactly the value the reset set: a write that moves it ends the mark
 * (`sign-in-writes.ts`). The whole row in the one statement that matched it,
 * so the version read is the one that matched (no join: a batch returns rows
 * by column name, and the address book's `id` would shadow the customer's); a
 * search of `customers_recovery_phone_idx` / `customers_recovery_email_idx`.
 */
export function recoveryOwnerQuery(db: Database, method: "email" | "phone", identifier: string) {
    return db.select()
        .from(customers)
        .where(and(
            method === "email" ? sql`lower(${customers.email}) = ${identifier}` : eq(customers.phone, identifier),
            liveRecovery(method),
            isNull(customers.deletedAt),
            isNotNull(customers.accountClaimedAt),
            isNull(customers.phoneVerifiedAt),
            isNull(customers.emailVerifiedAt),
        ))
        .limit(2);
}

/**
 * The recovery contact as a sign-in reads it: an email trimmed, checked and
 * lower-cased; a phone in E.164 by the store's accepted countries, as a
 * sign-in code to it is read. The route's checks are not relied on.
 */
async function recoveryValue(db: Database, contact: SignInRecoveryContact): Promise<{ method: "phone" | "email"; value: string }> {
    const method: "phone" | "email" = contact.phone !== undefined ? "phone" : "email";
    const typed = (method === "phone" ? contact.phone : contact.email)?.trim() ?? "";
    if (!typed) throw new ValidationError(`Enter the ${method} the customer will sign in with.`, { field: method, reason: "recovery_contact_required" });
    if (method === "email") {
        if (!isEmailAddress(typed)) throw new ValidationError("Enter a valid email address.", { field: "email", reason: "invalid" });
        return { method, value: typed.toLowerCase() };
    }
    const { phoneCountryPolicy } = await readSignInPolicy(db);
    const parsed = parseContactPhone(typed, { allowedCountries: phoneCountryPolicy });
    if (!parsed.ok) throw new ValidationError(parsed.message, { field: "phone", reason: parsed.reason });
    return { method, value: parsed.value };
}

/**
 * Resets how a customer signs in, in one batch decided from one read (409
 * `sign_in_changed` when another sign-in write landed since): every proof on
 * the account (phone and email) is cleared, its linked app identities are
 * deleted, every session is revoked, the one recovery contact is set and
 * marked with the time, and a `sign_in_reset` entry naming the contact kind
 * and the actor goes to the customer's history (`actorId`: a staff id, or
 * `agent:<grant>:<owner>` for an approved agent). Refused when the contact is
 * proven on any other account, live or closed, or is another account's live
 * recovery contact (an expired mark blocks nothing).
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
    const { method, value } = await recoveryValue(db, input.contact);

    // The same answer for a phone and an email, a live and a closed account.
    const taken = await db.select({ id: customers.id }).from(customers).where(and(
        ne(customers.id, customerId),
        method === "phone" ? eq(customers.phone, value) : sql`lower(${customers.email}) = ${value}`,
        or(
            method === "phone" ? isNotNull(customers.phoneVerifiedAt) : isNotNull(customers.emailVerifiedAt),
            liveRecovery(method),
        ),
    )).limit(1).get();
    if (taken) {
        throw new ConflictError(`This ${method} signs in to another account. Use a contact the customer alone holds.`, {
            field: method,
            reason: "recovery_contact_taken",
            allowed: [method === "phone" ? "email" : "phone"],
        });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + SIGN_IN_RECOVERY_SECONDS;
    const byAgent = input.actorId.startsWith("agent:");
    try {
        await safeBatch(db, [
            ...resetSignInWrites(db, existing, method, value),
            db.update(customerSessions).set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt))),
            db.insert(customerHistory).select(db.select({
                id: sql<string>`${`hist_${nanoid()}`}`.as("id"),
                customerId: customers.id,
                name: customers.name,
                email: customers.email,
                phone: customers.phone,
                changeType: sql<string>`'sign_in_reset'`.as("change_type"),
                orderId: sql<string | null>`NULL`.as("order_id"),
                relatedCustomerId: sql<string | null>`NULL`.as("related_customer_id"),
                verifiedContact: sql<string>`${method}`.as("verified_contact"),
                actor: sql<string>`${byAgent ? "agent" : "staff"}`.as("actor"),
                actorId: sql<string>`${input.actorId}`.as("actor_id"),
                createdAt: sql<number>`unixepoch()`.as("created_at"),
            }).from(customers).where(eq(customers.id, customerId))),
        ] as unknown as Parameters<typeof safeBatch>[1]);
    } catch (error) {
        if (isSignInChangedError(error)) throw signInChangedConflict();
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
