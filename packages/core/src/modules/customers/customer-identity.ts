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

export type CustomerKind = "account" | "guest" | "merchant";

/**
 * How the dashboard titles a customer: an account or a merchant-made customer
 * by its name; a checkout-made guest record by its phone, because different
 * people can order with one phone and none of them owns the record.
 */
export function customerKind(row: { accountClaimedAt: unknown; origin: string | null | undefined }): CustomerKind {
    if (row.accountClaimedAt) return "account";
    return row.origin === "merchant" ? "merchant" : "guest";
}

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
    /** Which verified contact filed the order under that account. */
    linkedBy: VerifiedContact | null;
}

export type VerifiedContact = "email" | "phone";

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
    const byPhone = candidates.find((row) => row.accountClaimedAt && row.phoneVerifiedAt && row.phone === contact.phone);
    if (byPhone) return { customerId: byPhone.id, accountOwnerCustomerId: byPhone.id, linkedBy: "phone" };
    const byEmail = email
        ? candidates.find((row) => row.accountClaimedAt && row.emailVerifiedAt && normalizeContactEmail(row.email) === email)
        : undefined;
    if (byEmail) return { customerId: byEmail.id, accountOwnerCustomerId: byEmail.id, linkedBy: "email" };
    const guest = candidates.find((row) => !row.accountClaimedAt && row.phone === contact.phone);
    return guest ? { customerId: guest.id, accountOwnerCustomerId: null, linkedBy: null } : null;
}

/**
 * After an account proves an email/phone: unowned orders placed with that
 * verified contact join the account on both sides (merchant and buyer). Every
 * order that leaves another record is written to both change logs with the
 * contact that proved it. A guest record's other orders stay where they are
 * (a phone can be shared, so nothing about them is shown to the account); a
 * guest record left with no orders is retired and marked merged. Returns the
 * ordered statements for the caller's batch; empty when nothing is verified.
 */
export function buildVerifiedContactOrderLink(
    db: Database,
    input: { customerId: string; email?: string | null; phone?: string | null },
) {
    const phone = input.phone?.trim() || null;
    const email = normalizeContactEmail(input.email);
    const phoneMatch = phone ? sql`${orders.customerPhone} = ${phone}` : null;
    const emailMatch = email ? sql`lower(trim(${orders.customerEmail})) = ${email}` : null;
    const contactMatch = [phoneMatch, emailMatch].filter((match): match is SQL => match !== null);
    if (contactMatch.length === 0) return [];
    const joins = sql`${orders.accountOwnerCustomerId} IS NULL AND ${orders.deletedAt} IS NULL AND (${sql.join(contactMatch, sql` OR `)})`;
    const leaves = and(joins, isNotNull(orders.customerId), ne(orders.customerId, input.customerId))!;
    const via = phoneMatch ? sql`CASE WHEN ${phoneMatch} THEN 'phone' ELSE 'email' END` : sql`'email'`;

    // All of these read the orders before the last statement moves them.
    return [
        movedOrderHistory(db, {
            changeType: "order_moved_out",
            owner: customers,
            ownerId: sql`${orders.customerId}`,
            relatedId: sql`${input.customerId}`,
            join: eq(customers.id, orders.customerId),
            where: leaves,
            via,
        }),
        movedOrderHistory(db, {
            changeType: "order_moved_in",
            owner: account,
            ownerId: sql`${input.customerId}`,
            relatedId: sql`${orders.customerId}`,
            join: eq(account.id, input.customerId),
            where: leaves,
            via,
        }),
        // Guest records whose every order is about to join the account.
        db.update(customers)
            .set({ deletedAt: sql`unixepoch()`, mergedIntoCustomerId: input.customerId, updatedAt: sql`unixepoch()` })
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

/** A snapshot of the customer's current details, for one change-log row. */
function customerSnapshot(owner: typeof customers | typeof account) {
    return {
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
    };
}

const historyId = () => sql<string>`'chist_' || lower(hex(randomblob(12)))`.as("id");

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
        via: SQL;
    },
) {
    return db.insert(customerHistory).select(db.select({
        id: historyId(),
        customerId: sql<string>`${input.ownerId}`.as("customer_id"),
        ...customerSnapshot(input.owner),
        changeType: sql<string>`${input.changeType}`.as("change_type"),
        orderId: orders.id,
        relatedCustomerId: sql<string>`${input.relatedId}`.as("related_customer_id"),
        verifiedContact: sql<string>`${input.via}`.as("verified_contact"),
        actor: sql<string>`'buyer'`.as("actor"),
        actorId: sql<string | null>`NULL`.as("actor_id"),
        createdAt: sql<number>`unixepoch()`.as("created_at"),
    }).from(orders).innerJoin(input.owner, input.join).where(input.where));
}

/**
 * The account's change-log row for a signed-out order filed straight to it at
 * checkout because its email/phone was verified ("Order #1091 linked by
 * verified email").
 */
export function linkedOrderHistory(db: Database, input: { accountId: string; orderId: string; via: VerifiedContact }) {
    return db.insert(customerHistory).select(db.select({
        id: historyId(),
        customerId: customers.id,
        ...customerSnapshot(customers),
        changeType: sql<string>`'order_linked'`.as("change_type"),
        orderId: sql<string>`${input.orderId}`.as("order_id"),
        relatedCustomerId: sql<string | null>`NULL`.as("related_customer_id"),
        verifiedContact: sql<string>`${input.via}`.as("verified_contact"),
        actor: sql<string>`'buyer'`.as("actor"),
        actorId: sql<string | null>`NULL`.as("actor_id"),
        createdAt: sql<number>`unixepoch()`.as("created_at"),
    }).from(customers).where(eq(customers.id, input.accountId)));
}

/** The account's "signed up with a verified email/phone" row, from its details as saved in the same batch. */
export function signedUpHistory(db: Database, input: { accountId: string; via: VerifiedContact }) {
    return db.insert(customerHistory).select(db.select({
        id: historyId(),
        customerId: customers.id,
        ...customerSnapshot(customers),
        changeType: sql<string>`'signed_up'`.as("change_type"),
        orderId: sql<string | null>`NULL`.as("order_id"),
        relatedCustomerId: sql<string | null>`NULL`.as("related_customer_id"),
        verifiedContact: sql<string>`${input.via}`.as("verified_contact"),
        actor: sql<string>`'buyer'`.as("actor"),
        actorId: sql<string | null>`NULL`.as("actor_id"),
        createdAt: sql<number>`unixepoch()`.as("created_at"),
    }).from(customers).where(eq(customers.id, input.accountId)));
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
