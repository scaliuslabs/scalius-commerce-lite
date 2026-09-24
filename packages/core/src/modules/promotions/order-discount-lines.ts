import type { Database } from "@scalius/database/client";
import { orderDiscountAllocations, promotionEffects } from "@scalius/database/schema";
import { asc, eq, sql } from "drizzle-orm";

/** What an applied discount did, for how an order summary shows it. */
export type OrderDiscountKind = "buy_x_get_y" | "product" | "order" | "shipping";

const KIND_BY_RANK: readonly OrderDiscountKind[] = ["buy_x_get_y", "product", "order", "shipping"];

/**
 * One line per discount an order used, from its immutable allocation facts.
 * Receipts, order emails and order pages list `amountMinor` (off the items)
 * as a discount line and show `shippingAmountMinor` (off delivery) on the
 * delivery line: "Free" with the fee struck through, never a discount line.
 * `kind` is the discount's main effect (a product discount that also gives
 * free delivery is "product", with its delivery part in `shippingAmountMinor`).
 */
export interface OrderDiscountLine {
    promotionId: string;
    title: string;
    code: string | null;
    method: "automatic" | "code";
    kind: OrderDiscountKind;
    amountMinor: number;
    shippingAmountMinor: number;
}

export async function listOrderDiscountLines(db: Database, orderId: string): Promise<OrderDiscountLine[]> {
    const target = orderDiscountAllocations.target;
    const amount = orderDiscountAllocations.discountAmountMinor;
    // Lower wins within one discount: Buy X get Y, then product, order, delivery.
    const kindRank = sql<number>`MIN(CASE
        WHEN ${target} = 'shipping' THEN 3
        WHEN json_extract(${promotionEffects.config}, '$.buy') IS NOT NULL THEN 0
        WHEN ${target} = 'order' THEN 2
        ELSE 1 END)`;
    const rows = await db
        .select({
            promotionId: orderDiscountAllocations.promotionId,
            title: orderDiscountAllocations.promotionName,
            code: orderDiscountAllocations.promotionCode,
            method: orderDiscountAllocations.method,
            kindRank,
            amountMinor: sql<number>`COALESCE(SUM(CASE WHEN ${target} = 'shipping' THEN 0 ELSE ${amount} END), 0)`,
            shippingAmountMinor: sql<number>`COALESCE(SUM(CASE WHEN ${target} = 'shipping' THEN ${amount} ELSE 0 END), 0)`,
        })
        .from(orderDiscountAllocations)
        .leftJoin(promotionEffects, eq(promotionEffects.id, orderDiscountAllocations.effectId))
        .where(eq(orderDiscountAllocations.orderId, orderId))
        .groupBy(
            orderDiscountAllocations.promotionId,
            orderDiscountAllocations.promotionName,
            orderDiscountAllocations.promotionCode,
            orderDiscountAllocations.method,
        )
        .orderBy(asc(kindRank), asc(orderDiscountAllocations.promotionName));
    return rows.map(({ kindRank: rank, ...row }) => ({
        ...row,
        kind: KIND_BY_RANK[Number(rank)] ?? "product",
        amountMinor: Number(row.amountMinor),
        shippingAmountMinor: Number(row.shippingAmountMinor),
    }));
}
