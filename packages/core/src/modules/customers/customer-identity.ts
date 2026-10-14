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
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import { NO_PHONE, phoneOrNull } from "@scalius/shared/customer-auth-policy";
import {
    customerHistory,
    customerMarketingConsentEvents,
    customerMarketingConsents,
    customerTagLinks,
    customers,
    customFieldValues,
    orders,
} from "@scalius/database/schema";

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
    /** Null for a contact without a phone (a digital or service order); email then identifies it. */
    phone: string | null;
    email?: string | null;
}

export interface ContactCustomerCandidate {
    id: string;
    /** Null for a record without a phone. */
    phone: string | null;
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

/**
 * The one active guest record of a contact (unique; never an account): keyed
 * by its phone, or by its email when it has no phone (migration 0117). A
 * contact with neither matches nothing.
 */
export function guestRecordForContact(contact: OrderContact): SQL {
    const phone = phoneOrNull(contact.phone);
    if (phone) return and(eq(customers.phone, phone), isNull(customers.accountClaimedAt), isNull(customers.deletedAt))!;
    const email = normalizeContactEmail(contact.email);
    if (!email) return sql`0`;
    return and(
        eq(customers.phone, NO_PHONE),
        sql`lower(${customers.email}) = ${email}`,
        isNull(customers.accountClaimedAt),
        isNull(customers.deletedAt),
    )!;
}

/**
 * The only rows a guest order's contact can resolve to: the account that
 * proved this phone, the account that proved this email, and the one guest
 * record keyed by this phone (or, without a phone, by this email).
 * Batchable (one read in the checkout batch).
 */
export function selectContactCustomerCandidates(db: Database, contact: OrderContact) {
    const email = normalizeContactEmail(contact.email);
    const phone = phoneOrNull(contact.phone);
    // Each match leads with its own indexed equality and carries `deleted_at`
    // itself: a shared `deleted_at IS NULL` beside the OR let SQLite (no D1
    // statistics) walk a `deleted_at` index over every customer instead.
    const live = isNull(customers.deletedAt);
    const matches: SQL[] = phone
        ? [
            and(
                eq(customers.phone, phone),
                live,
                or(and(isNotNull(customers.phoneVerifiedAt), isNotNull(customers.accountClaimedAt)), isNull(customers.accountClaimedAt)),
            )!,
        ]
        : [];
    if (email) {
        matches.push(and(
            sql`lower(${customers.email}) = ${email}`,
            isNotNull(customers.emailVerifiedAt),
            isNotNull(customers.accountClaimedAt),
            live,
        )!);
    }
    // Without a phone, the email's phoneless guest record (never one with a phone).
    if (!phone && email) {
        matches.push(and(eq(customers.phone, NO_PHONE), sql`lower(${customers.email}) = ${email}`, isNull(customers.accountClaimedAt), live)!);
    }
    if (matches.length === 0) matches.push(sql`0`);
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
        .where(or(...matches));
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
    const phone = phoneOrNull(contact.phone);
    const byPhone = phone
        ? candidates.find((row) => row.accountClaimedAt && row.phoneVerifiedAt && row.phone === phone)
        : undefined;
    if (byPhone) return { customerId: byPhone.id, accountOwnerCustomerId: byPhone.id, linkedBy: "phone" };
    const byEmail = email
        ? candidates.find((row) => row.accountClaimedAt && row.emailVerifiedAt && normalizeContactEmail(row.email) === email)
        : undefined;
    if (byEmail) return { customerId: byEmail.id, accountOwnerCustomerId: byEmail.id, linkedBy: "email" };
    // The guest record keyed by the phone; without one, the phoneless record keyed by the email.
    const guest = candidates.find((row) => !row.accountClaimedAt && (phone
        ? row.phone === phone
        : phoneOrNull(row.phone) === null && email !== null && normalizeContactEmail(row.email) === email));
    return guest ? { customerId: guest.id, accountOwnerCustomerId: null, linkedBy: null } : null;
}

/**
 * After an account proves an email/phone: unowned orders placed with that
 * verified contact join the account on both sides (merchant and buyer). Every
 * order that leaves another record is written to both change logs with the
 * contact that proved it. A guest record's other orders stay where they are
 * (a phone can be shared, so nothing about them is shown to the account); a
 * guest record left with no orders is retired and marked merged, and its tags,
 * custom fields and consent (with its history) join the account. Returns the
 * ordered statements for the caller's batch; empty when nothing is verified.
 */
export function buildVerifiedContactOrderLink(
    db: Database,
    input: { customerId: string; email?: string | null; phone?: string | null },
) {
    const phone = phoneOrNull(input.phone);
    const email = normalizeContactEmail(input.email);
    const phoneMatch = phone ? sql`${orders.customerPhone} = ${phone}` : null;
    const emailMatch = email ? sql`lower(trim(${orders.customerEmail})) = ${email}` : null;
    const contactMatch = [phoneMatch, emailMatch].filter((match): match is SQL => match !== null);
    if (contactMatch.length === 0) return [];
    const joiningOrder = (match: SQL) => sql`${orders.accountOwnerCustomerId} IS NULL AND ${orders.deletedAt} IS NULL AND ${match}`;
    // With both contacts, an OR can choose a scan of all live orders without statistics.
    // UNION keeps each proven contact on its own index and deduplicates shared matches.
    const joins = contactMatch.length === 1 ? joiningOrder(contactMatch[0]!)
        : sql`CASE WHEN ${orders.accountOwnerCustomerId} IS NULL AND ${orders.deletedAt} IS NULL THEN 1 ELSE 0 END = 1
            AND ${orders.id} IN (${sql.join(contactMatch.map((match) => sql`SELECT ${orders.id} FROM ${orders} WHERE ${joiningOrder(match)}`), sql` UNION `)})`;
    const leaves = and(joins, isNotNull(orders.customerId), ne(orders.customerId, input.customerId))!;
    const via = phoneMatch ? sql`CASE WHEN ${phoneMatch} THEN 'phone' ELSE 'email' END` : sql`'email'`;
    // Guest records whose every order is about to join the account: they are merged into it.
    // Start from the contact index even without planner statistics; CROSS JOIN keeps SQLite
    // from scanning every live customer. Aliases must be spelled out in raw SQL.
    const mergingGuestIds = sql`SELECT "merging_guest"."id" FROM ${orders} CROSS JOIN "customers" AS "merging_guest"
        WHERE ${joins} AND "merging_guest"."id" = ${orders.customerId}
          AND "merging_guest"."account_claimed_at" IS NULL AND "merging_guest"."deleted_at" IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.customerId} = "merging_guest"."id" AND CASE WHEN (${joins}) THEN 0 ELSE 1 END = 1)`;

    // All of these read the orders before the last statement moves them.
    return [
        ...carryMergedGuestFacts(db, input.customerId, mergingGuestIds),
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
            // Keep a target-row guard for PostgreSQL's concurrent-update recheck without
            // inviting SQLite to scan the deleted_at index instead of these IDs.
            .where(sql`${customers.id} IN (${mergingGuestIds}) AND COALESCE(${customers.accountClaimedAt}, ${customers.deletedAt}) IS NULL`),
        // Its order statistics (segments read them) follow the orders, by trigger.
        db.update(orders)
            .set({ customerId: input.customerId, accountOwnerCustomerId: input.customerId })
            .where(joins),
    ];
}

const account = alias(customers, "account");

/**
 * What the merchant knows about a guest record merged into an account comes
 * with it: its tags and customer custom fields (the account's own win), and
 * its marketing consent. Per channel the latest consent wins, and every
 * consent event moves to the account, so the audit trail stays whole. A moved
 * consent row keeps its state and address (no new event, no outbox fact), and
 * reads compare its address with the account's as for any customer.
 * Statements for the merge batch, before the guest record is retired.
 */
function carryMergedGuestFacts(db: Database, accountId: string, mergingGuestIds: SQL) {
    return [
        db.insert(customerTagLinks).select(db.select({
            customerId: sql<string>`${accountId}`.as("customer_id"),
            tag: customerTagLinks.tag,
            createdAt: customerTagLinks.createdAt,
        }).from(customerTagLinks).where(sql`${customerTagLinks.customerId} IN (${mergingGuestIds})`)).onConflictDoNothing(),
        db.insert(customFieldValues).select(db.select({
            definitionId: customFieldValues.definitionId,
            ownerType: customFieldValues.ownerType,
            ownerId: sql<string>`${accountId}`.as("owner_id"),
            value: customFieldValues.value,
            updatedAt: customFieldValues.updatedAt,
        }).from(customFieldValues).where(and(
            eq(customFieldValues.ownerType, "customer"),
            sql`${customFieldValues.ownerId} IN (${mergingGuestIds})`,
        ))).onConflictDoNothing(),
        db.update(customerMarketingConsentEvents)
            .set({ customerId: accountId })
            .where(sql`${customerMarketingConsentEvents.customerId} IN (${mergingGuestIds})`),
        // The account's consent gives way to a guest record's newer one...
        db.delete(customerMarketingConsents).where(and(
            eq(customerMarketingConsents.customerId, accountId),
            sql`EXISTS (SELECT 1 FROM "customer_marketing_consents" AS "guest_consent"
                WHERE "guest_consent"."customer_id" IN (${mergingGuestIds})
                  AND "guest_consent"."channel" = ${customerMarketingConsents.channel}
                  AND "guest_consent"."updated_at" > ${customerMarketingConsents.updatedAt})`,
        )),
        // ...and the newest guest consent of each channel the account has none for moves to it.
        db.update(customerMarketingConsents).set({ customerId: accountId }).where(and(
            sql`${customerMarketingConsents.customerId} IN (${mergingGuestIds})`,
            sql`${customerMarketingConsents.customerId} = (SELECT "guest_consent"."customer_id" FROM "customer_marketing_consents" AS "guest_consent"
                WHERE "guest_consent"."customer_id" IN (${mergingGuestIds})
                  AND "guest_consent"."channel" = ${customerMarketingConsents.channel}
                ORDER BY "guest_consent"."updated_at" DESC, "guest_consent"."customer_id" DESC LIMIT 1)`,
            sql`NOT EXISTS (SELECT 1 FROM "customer_marketing_consents" AS "account_consent"
                WHERE "account_consent"."customer_id" = ${accountId}
                  AND "account_consent"."channel" = ${customerMarketingConsents.channel})`,
        )),
    ];
}

/** A snapshot of the customer's current contact, for one change-log row (addresses live in the address book). */
function customerSnapshot(owner: typeof customers | typeof account) {
    return {
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
    };
}

// A statement prefix plus its source row keeps multi-order inserts unique on every provider.
const historyId = (rowId: SQL) => sql<string>`${`chist_${nanoid()}_`} || ${rowId}`.as("id");

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
        id: historyId(sql`${orders.id}`),
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
        id: historyId(sql`${customers.id}`),
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
        id: historyId(sql`${customers.id}`),
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
