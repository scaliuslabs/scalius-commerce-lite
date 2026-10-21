// The price order of a listing in a market whose public lists are live
// (docs/SCALE.md): the stored buyer state orders by base prices, and a list
// price can put a product anywhere, so neither the buyer state's price index
// nor the market's list rows alone give the market's order. Both give bounds:
//
// - the base stream (the buyer state by `from_minor`, or `to_minor`, through
//   its own index): FX of the base price is a product's exact market price
//   when no live list prices its SKUs, and, for one that a list does price,
//   a bound on the side of its SKUs without a list price;
// - the list stream (the market's live public list prices by amount, each
//   list through its own amount index, cut by the listing's conditions): a
//   product's first row is the cheapest (or dearest) of its list prices,
//   within half an increment of what it rounds to.
//
// Every product the streams have reached is priced exactly
// (`marketCardPrices`: `resolvePrice` over the buyable pool, as its card
// shows it). A product neither stream has reached costs at least (at most)
// the bound where the streams stand, so the products priced strictly before
// that bound are final; the streams go on, twice as far each round, until
// the page's rows are final. A page reads about its rows from each stream
// and the SKUs of the products they name. Numbered pages only: a cursor
// cannot hold a position in two streams.
import { and, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { marketAmountMinor, marketCardPrices, type MarketPriceContext } from "../price-lists";
import { buyerState } from "./buyer-state";

export interface MarketPriceOrderInput {
    /** The listing's conditions, over the unaliased buyer state (and `products` with `needsProducts`). */
    conditions: SQL[];
    needsProducts: boolean;
    /** `from`: the card price (the listing's price order, the range's low end); `to`: the highest price (the range's high end). */
    key: "from" | "to";
    direction: "asc" | "desc";
    /** Rows from the start of the order the caller needs (offset + limit + 1). */
    needed: number;
}

/** The first `needed` products of the market price order, with their prices (market minor units). */
export async function marketPriceOrder(
    db: Database,
    context: MarketPriceContext,
    input: MarketPriceOrderInput,
): Promise<Array<{ id: string; price: number }>> {
    const needed = Math.max(1, Math.trunc(input.needed));
    const ascending = input.direction === "asc";
    const halfStep = Math.ceil(Math.max(1, context.incrementMinor) / 2);
    const exact = new Map<string, number>();
    let rows = Math.max(needed, 20);
    for (let round = 0; ; round += 1) {
        const [base, listed] = await Promise.all([
            readBaseStream(db, input, rows + 1),
            readListStream(db, context, input, rows + 1),
        ]);
        const unpriced = [...new Set([...base, ...listed].map((row) => row.productId))].filter((id) => !exact.has(id));
        const priced = await marketCardPrices(db, context, unpriced);
        for (const id of unpriced) {
            const price = priced.get(id);
            if (price) exact.set(id, input.key === "from" ? price.amountMinor : price.maxAmountMinor);
        }
        // Where each stream stands: the bound of every product it has not reached.
        const baseNext = base.length > rows ? marketAmountMinor(context, base[rows]!.amount) : null;
        const listNext = listed.length > rows ? listed[rows]!.amount + (ascending ? -halfStep : halfStep) : null;
        const bounds = [baseNext, listNext].filter((value): value is number => value !== null);
        const bound = bounds.length === 0 ? null : ascending ? Math.min(...bounds) : Math.max(...bounds);
        const ordered = [...exact].map(([id, price]) => ({ id, price }))
            .sort((left, right) => (ascending ? left.price - right.price : right.price - left.price) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        const final = bound === null
            ? ordered
            : ordered.filter((row) => (ascending ? row.price < bound : row.price > bound));
        if (final.length >= needed || bound === null || round >= 12) return final.slice(0, needed);
        rows *= 2;
    }
}

/** The base stream: the listing's rows by their stored base price. */
async function readBaseStream(db: Database, input: MarketPriceOrderInput, rows: number) {
    const column = input.key === "from" ? buyerState.fromMinor : buyerState.toMinor;
    const direction = sql.raw(input.direction === "asc" ? "ASC" : "DESC");
    return (await db.all<{ productId: string; amount: number } | [string, number]>(sql`
        SELECT ${buyerState.productId} AS "productId", ${column} AS "amount"
        FROM ${buyerState}
        ${input.needsProducts ? sql`INNER JOIN "products" ON "products"."id" = ${buyerState.productId}` : sql``}
        WHERE ${and(...input.conditions)}
        ORDER BY ${column} ${direction}, ${buyerState.productId}
        LIMIT ${sql.raw(String(rows))}`)).map(row);
}

/**
 * The list stream: the market's live public list prices (its currency, at
 * quantity 1) of the listing's products, by amount. Each list gives its own
 * first rows through `price_list_prices_amount_idx` (a correlated subquery
 * per list, its SKU ids as one JSON list expanded by `json_each`, the same
 * form as the subtree page in listing.ts), so no walk crosses lists.
 */
async function readListStream(db: Database, context: MarketPriceContext, input: MarketPriceOrderInput, rows: number) {
    return (await db.all<{ productId: string; amount: number } | [string, number]>(listStreamSql(context, input, rows))).map(row);
}

/** The list stream's statement (exported for the PostgreSQL plan guard). */
export function listStreamSql(context: MarketPriceContext, input: MarketPriceOrderInput, rows: number): SQL {
    const direction = sql.raw(input.direction === "asc" ? "ASC" : "DESC");
    const limit = sql.raw(String(rows));
    return sql`
        SELECT stream_sku.product_id AS "productId", stream_price.amount_minor AS "amount"
        FROM (
            SELECT stream_list.id AS list_id, (
                SELECT json_group_array(list_top.variant_id) FROM (
                    SELECT list_price.variant_id AS variant_id
                    FROM price_list_prices AS list_price
                    INNER JOIN product_variants AS list_sku ON list_sku.id = list_price.variant_id AND list_sku.deleted_at IS NULL
                    INNER JOIN ${buyerState} ON ${buyerState.productId} = list_sku.product_id
                    ${input.needsProducts ? sql`INNER JOIN "products" ON "products"."id" = ${buyerState.productId}` : sql``}
                    WHERE list_price.price_list_id = stream_list.id
                      AND list_price.currency_code = ${context.currencyCode} AND list_price.min_quantity = 1
                      AND ${and(...input.conditions)}
                    ORDER BY list_price.amount_minor ${direction}, list_sku.product_id
                    LIMIT ${limit}
                ) AS list_top
            ) AS top_ids
            FROM price_lists AS stream_list
            WHERE stream_list.market_id = ${context.marketId} AND stream_list.status = 'active' AND stream_list.kind <> 'segment'
              AND (stream_list.starts_at IS NULL OR stream_list.starts_at <= ${context.atSeconds})
              AND (stream_list.ends_at IS NULL OR stream_list.ends_at > ${context.atSeconds})
        ) AS stream_top
        CROSS JOIN json_each(stream_top.top_ids) AS top_id
        INNER JOIN price_list_prices AS stream_price ON stream_price.price_list_id = stream_top.list_id
            AND stream_price.variant_id = top_id.value
            AND stream_price.currency_code = ${context.currencyCode} AND stream_price.min_quantity = 1
        INNER JOIN product_variants AS stream_sku ON stream_sku.id = stream_price.variant_id
        ORDER BY stream_price.amount_minor ${direction}, stream_sku.product_id
        LIMIT ${limit}`;
}

const row = (value: { productId: string; amount: number } | [string, number]) => Array.isArray(value)
    ? { productId: value[0], amount: Number(value[1]) }
    : { productId: value.productId, amount: Number(value.amount) };
