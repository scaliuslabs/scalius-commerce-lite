// Customer tags (Customers & marketing): normalised labels on a customer
// (`@scalius/shared/customer-marketing` `normalizeCustomerTag`), at most 50 per
// customer. Bulk writes bind every id and tag list as one JSON value
// (`json_each`), so a statement never comes near D1's 100 bound values and a
// bulk request is one statement whatever its size.

import type { Database } from "@scalius/database/client";
import { safeBatch, D1_ID_CHUNK_SIZE } from "@scalius/database/client";
import { customerTagLinks, customers } from "@scalius/database/schema";
import {
    CUSTOMER_TAGS_PER_CUSTOMER_MAX,
    CUSTOMER_TAGS_PER_REQUEST_MAX,
    normalizeCustomerTags,
} from "@scalius/shared/customer-marketing";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { containsText } from "../../utils/text-match";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

/** Customers in one bulk tag request (the dashboard's "select all" cap). */
export const CUSTOMER_TAG_BULK_MAX_CUSTOMERS = 500;
function requireTags(inputs: readonly string[], max: number): string[] {
    const { tags, invalid } = normalizeCustomerTags(inputs);
    if (invalid.length > 0) throw new ValidationError("A tag is 1 to 40 characters.", { invalid: invalid.slice(0, 5) });
    if (tags.length === 0) throw new ValidationError("Give at least one tag.");
    if (tags.length > max) throw new ValidationError(`Give at most ${max} tags.`);
    return tags;
}

function requireCustomerIds(ids: readonly string[]): string[] {
    const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128))];
    if (unique.length === 0) throw new ValidationError("Choose at least one customer.");
    if (unique.length > CUSTOMER_TAG_BULK_MAX_CUSTOMERS) {
        throw new ValidationError(`Tag at most ${CUSTOMER_TAG_BULK_MAX_CUSTOMERS} customers at a time.`);
    }
    return unique;
}

/** One customer's tags, alphabetical. */
export async function listCustomerTags(db: Database, customerId: string): Promise<string[]> {
    const rows = await db.select({ tag: customerTagLinks.tag }).from(customerTagLinks)
        .where(eq(customerTagLinks.customerId, customerId))
        .orderBy(asc(customerTagLinks.tag));
    return rows.map((row) => row.tag);
}

/** Tags of many customers (list rows, exports), read 90 ids at a time. */
export async function listTagsForCustomers(db: Database, customerIds: readonly string[]): Promise<Map<string, string[]>> {
    const tags = new Map<string, string[]>();
    const ids = [...new Set(customerIds)];
    for (let start = 0; start < ids.length; start += D1_ID_CHUNK_SIZE) {
        const rows = await db.select({ customerId: customerTagLinks.customerId, tag: customerTagLinks.tag })
            .from(customerTagLinks)
            .where(inArray(customerTagLinks.customerId, ids.slice(start, start + D1_ID_CHUNK_SIZE)))
            .orderBy(asc(customerTagLinks.customerId), asc(customerTagLinks.tag));
        for (const row of rows) {
            const list = tags.get(row.customerId) ?? [];
            list.push(row.tag);
            tags.set(row.customerId, list);
        }
    }
    return tags;
}

/** Replaces one customer's tags with exactly these (normalised, at most 50). */
export async function setCustomerTags(db: Database, customerId: string, inputs: readonly string[]): Promise<string[]> {
    const { tags, invalid } = normalizeCustomerTags(inputs);
    if (invalid.length > 0) throw new ValidationError("A tag is 1 to 40 characters.", { invalid: invalid.slice(0, 5) });
    if (tags.length > CUSTOMER_TAGS_PER_CUSTOMER_MAX) {
        throw new ValidationError(`A customer has at most ${CUSTOMER_TAGS_PER_CUSTOMER_MAX} tags.`);
    }
    const customer = await db.select({ id: customers.id }).from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt))).get();
    if (!customer) throw new NotFoundError("Customer not found");
    const tagsJson = JSON.stringify(tags);
    await safeBatch(db, [
        db.delete(customerTagLinks).where(and(
            eq(customerTagLinks.customerId, customerId),
            sql`${customerTagLinks.tag} NOT IN (SELECT value FROM json_each(${tagsJson}))`,
        )),
        db.insert(customerTagLinks).select(db.select({
            customerId: sql<string>`${customerId}`.as("customer_id"),
            tag: sql<string>`tag_list.value`.as("tag"),
            createdAt: sql<number>`unixepoch()`.as("created_at"),
        }).from(sql`json_each(${tagsJson}) AS tag_list`).where(sql`true`)).onConflictDoNothing(),
    ] as unknown as Parameters<typeof safeBatch>[1]);
    return [...tags].sort();
}

/**
 * Adds tags to live customers. A customer whose tags would pass 50 is left
 * as it is (counted conservatively: every requested tag counts).
 */
export async function addTagsToCustomers(
    db: Database,
    input: { customerIds: readonly string[]; tags: readonly string[] },
): Promise<{ customers: number; tags: string[] }> {
    const ids = requireCustomerIds(input.customerIds);
    const tags = requireTags(input.tags, CUSTOMER_TAGS_PER_REQUEST_MAX);
    // The SELECT reads the target table, so SQLite materialises it before
    // inserting; the per-customer count never sees this statement's rows.
    await db.run(sql`INSERT INTO ${customerTagLinks} (customer_id, tag, created_at)
        SELECT ${customers.id}, tag_list.value, unixepoch()
        FROM ${customers} CROSS JOIN json_each(${JSON.stringify(tags)}) AS tag_list
        WHERE ${customers.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
          AND ${customers.deletedAt} IS NULL
          AND (SELECT count(*) FROM ${customerTagLinks} AS existing WHERE existing.customer_id = ${customers.id}) + ${tags.length} <= ${CUSTOMER_TAGS_PER_CUSTOMER_MAX}
        ON CONFLICT DO NOTHING`);
    return { customers: ids.length, tags };
}

/** Removes tags from customers (live or in trash). */
export async function removeTagsFromCustomers(
    db: Database,
    input: { customerIds: readonly string[]; tags: readonly string[] },
): Promise<{ customers: number; tags: string[] }> {
    const ids = requireCustomerIds(input.customerIds);
    const tags = requireTags(input.tags, CUSTOMER_TAGS_PER_REQUEST_MAX);
    await db.delete(customerTagLinks).where(and(
        sql`${customerTagLinks.customerId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
        sql`${customerTagLinks.tag} IN (SELECT value FROM json_each(${JSON.stringify(tags)}))`,
    ));
    return { customers: ids.length, tags };
}

/** The store's tags with how many live customers carry each (for pickers), most used first. */
export async function listStoreCustomerTags(
    db: Database,
    options: { query?: string; limit?: number } = {},
): Promise<Array<{ tag: string; customers: number }>> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const query = options.query?.normalize("NFC").trim().toLowerCase();
    const rows = await db.select({
        tag: customerTagLinks.tag,
        customers: sql<number>`CAST(count(*) AS INTEGER)`,
    })
        .from(customerTagLinks)
        .innerJoin(customers, and(eq(customers.id, customerTagLinks.customerId), isNull(customers.deletedAt)))
        .where(query ? containsText(customerTagLinks.tag, query) : undefined)
        .groupBy(customerTagLinks.tag)
        .orderBy(sql`count(*) DESC`, asc(customerTagLinks.tag))
        .limit(limit);
    return rows.map((row) => ({ tag: row.tag, customers: Number(row.customers) }));
}
