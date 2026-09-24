// One identity rule for the buyer's account and the merchant's customer list.
//
// A phone or email typed at checkout or sign-up is a claim. It is stored on the
// order (and on a new record) but never claims, renames, re-emails or merges an
// existing customer, never moves orders, and never blocks the real owner.
// Only a code-verified identifier links orders to an account or merges records.
//
// Invariant: an order an account owns is also filed under that account
// (orders.customer_id = orders.account_owner_customer_id), so the merchant and
// the buyer always see the same orders.
import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import { customers, orders } from "@scalius/database/schema";

export interface OrderContact {
    phone: string;
    email?: string | null;
}

export interface ContactCustomerCandidate {
    id: string;
    phone: string;
    email: string | null;
    accountClaimedAt: Date | null;
    phoneVerifiedAt: Date | null;
    emailVerifiedAt: Date | null;
}

export interface OrderCustomerChoice {
    /** Customer the merchant files the order under. */
    customerId: string;
    /** Set when a verified contact on the order belongs to an account. */
    accountOwnerCustomerId: string | null;
}

export function normalizeContactEmail(email: string | null | undefined): string | null {
    const normalized = email?.trim().toLowerCase();
    return normalized || null;
}

/** The one active guest record keyed by a phone (unique; never an account). */
export function guestRecordForPhone(phone: string): SQL {
    return and(eq(customers.phone, phone), isNull(customers.accountClaimedAt), isNull(customers.deletedAt))!;
}

/**
 * The only rows a guest order's contact can resolve to: the account that
 * proved this phone, the account that proved this email, and the one guest
 * record keyed by this phone. Batchable (one read in the checkout batch).
 */
export function selectContactCustomerCandidates(db: Database, contact: OrderContact) {
    const email = normalizeContactEmail(contact.email);
    const matches: SQL[] = [
        and(eq(customers.phone, contact.phone), isNotNull(customers.phoneVerifiedAt), isNotNull(customers.accountClaimedAt))!,
        and(eq(customers.phone, contact.phone), isNull(customers.accountClaimedAt))!,
    ];
    if (email) {
        matches.push(and(
            sql`lower(${customers.email}) = ${email}`,
            isNotNull(customers.emailVerifiedAt),
            isNotNull(customers.accountClaimedAt),
        )!);
    }
    return db
        .select({
            id: customers.id,
            phone: customers.phone,
            email: customers.email,
            accountClaimedAt: customers.accountClaimedAt,
            phoneVerifiedAt: customers.phoneVerifiedAt,
            emailVerifiedAt: customers.emailVerifiedAt,
        })
        .from(customers)
        .where(and(isNull(customers.deletedAt), or(...matches)));
}

/**
 * Verified phone owner, then verified email owner (Shopify files guest orders
 * under the customer who owns the contact), then the phone's guest record.
 * Null means a new guest record is created from the order's contact.
 */
export function chooseOrderCustomer(
    candidates: readonly ContactCustomerCandidate[],
    contact: OrderContact,
): OrderCustomerChoice | null {
    const email = normalizeContactEmail(contact.email);
    const account = candidates.find((row) => row.accountClaimedAt && row.phoneVerifiedAt && row.phone === contact.phone)
        ?? (email
            ? candidates.find((row) => row.accountClaimedAt && row.emailVerifiedAt && normalizeContactEmail(row.email) === email)
            : undefined);
    if (account) return { customerId: account.id, accountOwnerCustomerId: account.id };
    const guest = candidates.find((row) => !row.accountClaimedAt && row.phone === contact.phone);
    return guest ? { customerId: guest.id, accountOwnerCustomerId: null } : null;
}

/**
 * After an account proves an email/phone: unowned orders placed with that
 * verified contact join the account on both sides (merchant and buyer), and a
 * guest record left with no orders is retired (merged into the account).
 * Returns the ordered statements to run in the caller's batch; empty when the
 * account has nothing verified.
 */
export function buildVerifiedContactOrderLink(
    db: Database,
    input: { customerId: string; email?: string | null; phone?: string | null },
) {
    const phone = input.phone?.trim() || null;
    const email = normalizeContactEmail(input.email);
    const contactMatch: SQL[] = [];
    if (phone) contactMatch.push(sql`${orders.customerPhone} = ${phone}`);
    if (email) contactMatch.push(sql`lower(trim(${orders.customerEmail})) = ${email}`);
    if (contactMatch.length === 0) return [];
    const joins = sql`${orders.accountOwnerCustomerId} IS NULL AND ${orders.deletedAt} IS NULL AND (${sql.join(contactMatch, sql` OR `)})`;

    return [
        // Evaluated before the move: guest records whose every order is about to join the account.
        db.update(customers)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(and(
                isNull(customers.accountClaimedAt),
                isNull(customers.deletedAt),
                sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.customerId} = ${customers.id} AND ${joins})`,
                sql`NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.customerId} = ${customers.id} AND (${joins}) IS NOT TRUE)`,
            )),
        db.update(orders)
            .set({ customerId: input.customerId, accountOwnerCustomerId: input.customerId })
            .where(joins),
    ];
}

/** Links verified-contact guest orders for a signed-in account (any device). */
export async function linkVerifiedContactOrders(db: Database, customerId: string): Promise<void> {
    const account = await db
        .select({
            email: customers.email,
            phone: customers.phone,
            emailVerifiedAt: customers.emailVerifiedAt,
            phoneVerifiedAt: customers.phoneVerifiedAt,
        })
        .from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .get();
    if (!account) return;
    const statements = buildVerifiedContactOrderLink(db, {
        customerId,
        email: account.emailVerifiedAt ? account.email : null,
        phone: account.phoneVerifiedAt ? account.phone : null,
    });
    if (statements.length > 0) {
        await safeBatch(db, statements as unknown as Parameters<typeof safeBatch>[1]);
    }
}
