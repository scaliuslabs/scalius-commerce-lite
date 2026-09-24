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
import { and, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { safeBatch, type Database } from "@scalius/database/client";
import { customerHistory, customers, orders } from "@scalius/database/schema";

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

/** How a contact is shown before it is proven: "r•••@example.com", "01•••••678". */
export function maskContact(method: "email" | "phone", target: string): string {
    if (method === "email") {
        const [local = "", domain = ""] = target.split("@");
        return `${local.slice(0, 1)}•••@${domain}`;
    }
    const digits = target.replace(/\D/g, "");
    const local = digits.startsWith("880") ? `0${digits.slice(3)}` : digits;
    return `${local.slice(0, 2)}•••••${local.slice(-3)}`;
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
 * verified contact join the account on both sides (merchant and buyer).
 * Every order that leaves another record is written to both change logs, the
 * guest record it left is linked to the account (its other orders wait until
 * the account proves their contact too), and a guest record left with no
 * orders is retired. Returns the ordered statements for the caller's batch;
 * empty when the account has nothing verified.
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
    const leaves = and(joins, isNotNull(orders.customerId), ne(orders.customerId, input.customerId))!;

    // All of these read the orders before the last statement moves them.
    return [
        movedOrderHistory(db, {
            changeType: "order_moved_out",
            owner: customers,
            ownerId: sql`${orders.customerId}`,
            relatedId: sql`${input.customerId}`,
            join: eq(customers.id, orders.customerId),
            where: leaves,
        }),
        movedOrderHistory(db, {
            changeType: "order_moved_in",
            owner: account,
            ownerId: sql`${input.customerId}`,
            relatedId: sql`${orders.customerId}`,
            join: eq(account.id, input.customerId),
            where: leaves,
        }),
        db.update(customers)
            .set({ linkedAccountId: input.customerId, updatedAt: sql`unixepoch()` })
            .where(and(
                isNull(customers.accountClaimedAt),
                isNull(customers.deletedAt),
                isNull(customers.linkedAccountId),
                sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.customerId} = ${customers.id} AND ${joins})`,
            )),
        // Guest records whose every order is about to join the account.
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

const account = alias(customers, "account");

/** One change-log row per moving order on one side, with that record's current details. */
function movedOrderHistory(
    db: Database,
    input: {
        changeType: "order_moved_in" | "order_moved_out";
        owner: typeof customers | typeof account;
        ownerId: SQL;
        relatedId: SQL;
        join: SQL;
        where: SQL;
    },
) {
    const { owner } = input;
    return db.insert(customerHistory).select(db.select({
        id: sql<string>`'chist_' || lower(hex(randomblob(12)))`.as("id"),
        customerId: sql<string>`${input.ownerId}`.as("customer_id"),
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
        address: owner.address,
        city: owner.city,
        zone: owner.zone,
        area: owner.area,
        cityName: owner.cityName,
        zoneName: owner.zoneName,
        areaName: owner.areaName,
        changeType: sql<string>`${input.changeType}`.as("change_type"),
        orderId: orders.id,
        relatedCustomerId: sql<string>`${input.relatedId}`.as("related_customer_id"),
        createdAt: sql<number>`unixepoch()`.as("created_at"),
    }).from(orders).innerJoin(owner, input.join).where(input.where));
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
