// A kit's stored buyer state (its card's band and availability) follows its
// items, after the write that moved them. A write refreshes only its own
// products: an order for a SKU held by 200 kits pays for that SKU alone.
// 0224's queue triggers note the item SKU (`system_kv` key
// `catalog:kit-items:<sku>`, value `<version>|<last kit product refreshed>`:
// every note bumps the version and resets the cursor) when its stock, tracking, deletion or its product's public state
// moves; `refreshQueuedKitItems` refreshes the kits in bounded chunks, run by
// the projection drain (apps/api background/catalog.ts). Display may lag by
// that drain; checkout always validates a kit's items, so nothing oversells.
import { productVariants, systemKv, variantComponents } from "@scalius/database/schema";
import { type Database, safeBatch } from "@scalius/database/client";
import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { catalogProjectionRefreshStatements } from "./catalog-projections";

export const KIT_ITEMS_QUEUE_PREFIX = "catalog:kit-items:";
/** The first key after the queue's range (`;` follows `:`), so the queue is one primary-key range. */
const QUEUE_END = "catalog:kit-items;";
const prefixLength = [...KIT_ITEMS_QUEUE_PREFIX].length;

/** The queue's rows, as a primary-key range. */
export function kitItemsQueued() {
    return and(gt(systemKv.key, KIT_ITEMS_QUEUE_PREFIX), lt(systemKv.key, QUEUE_END))!;
}

/**
 * One chunk: the next `kits` kit products of the queued items, in key then
 * product order, refreshed (buyer state only) in one batch that also removes
 * the items whose kits are all done and moves the last one's cursor. Each
 * removal and cursor move is a compare-and-set on the value read (its version
 * included), so an item noted again meanwhile stays queued, on every engine.
 */
export async function refreshQueuedKitItems(
    db: Database,
    kits: number,
    /** Kits this drain run already refreshed: an item's kit refreshed for another item is not refreshed again. */
    seen: Set<string> = new Set(),
): Promise<{ processed: number; done: boolean }> {
    const heldKit = db
        .select({ itemId: sql<string>`${variantComponents.componentVariantId}`.as("held_item_id"), productId: sql<string>`${productVariants.productId}`.as("held_product_id") })
        .from(variantComponents)
        .innerJoin(productVariants, eq(productVariants.id, variantComponents.kitVariantId))
        .as("held_kit");
    // Rows are (item, kit): read several per kit, so items sharing kits cost one refresh of each.
    const readLimit = Math.min(kits * 10, 2_000);
    const rows = await db
        .select({ key: systemKv.key, cursor: systemKv.value, productId: heldKit.productId })
        .from(systemKv)
        // The cursor is in the join, so an item with no kit left reads one row (no product) on either engine.
        .leftJoin(heldKit, and(eq(heldKit.itemId, sql`substr(${systemKv.key}, ${prefixLength + 1})`), gt(heldKit.productId, sql`substr(${systemKv.value}, instr(${systemKv.value}, '|') + 1)`)))
        .where(kitItemsQueued())
        .orderBy(asc(systemKv.key), asc(heldKit.productId))
        .limit(readLimit + 1);
    if (rows.length === 0) return { processed: 0, done: true };
    // Take rows until the chunk holds `kits` kits not refreshed yet this run.
    const fresh = new Set<string>();
    let cut = Math.min(rows.length, readLimit);
    for (let index = 0; index < cut; index += 1) {
        const id = rows[index]!.productId;
        if (!id || seen.has(id) || fresh.has(id)) continue;
        if (fresh.size === kits) { cut = index; break; }
        fresh.add(id);
    }
    const taken = rows.slice(0, cut);
    const more = cut < rows.length;
    // The item the chunk stopped inside keeps a cursor; every other item read is done.
    const partial = more && taken.length > 0 && rows[cut]!.key === taken.at(-1)!.key ? taken.at(-1)! : null;
    const done = new Map<string, string>();
    for (const row of taken) if (row.key !== partial?.key) done.set(row.key, row.cursor);
    const productIds = [...fresh];
    for (const id of fresh) seen.add(id);
    const statements = [
        ...catalogProjectionRefreshStatements(db, productIds, { facets: false }),
        ...(done.size > 0
            ? [db.delete(systemKv).where(or(...[...done].map(([key, cursor]) => and(eq(systemKv.key, key), eq(systemKv.value, cursor))))!)]
            : []),
        ...(partial
            // The same version, the cursor moved: a note meanwhile changed the version, so this matches nothing.
            ? [db.update(systemKv).set({ value: `${partial.cursor.slice(0, partial.cursor.indexOf("|") + 1)}${partial.productId!}` }).where(and(eq(systemKv.key, partial.key), eq(systemKv.value, partial.cursor)))]
            : []),
    ];
    if (statements.length > 0) await safeBatch(db, statements as never);
    return { processed: productIds.length, done: !more };
}
