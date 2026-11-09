// An in-person sale (a point of sale, orders.channel `pos`): the policy the
// one manual-order create applies when `pointOfSale` is set. The sale sells
// from a sales channel and hands its goods over at the counter of one of the
// channel's locations, so it ships nothing and its stock leaves that location
// (ledger v2) when the hand-over completes. It is paid as it is placed: the
// tenders cover the whole total, only cash gives change, and each tender is
// recorded as a payment of its `via`. The location, the staff member who
// rang it up and the tenders commit with the order as its `pos_sale` fact
// (the receipt an app prints), in the order's own batch.
//
// The counter's units are promised in that same batch: a guard after the
// order's rows refuses the commit when the location's on-hand no longer
// covers every reservation that names it, this sale's included. Two sales
// racing for the last unit serialize there (the reservation locks the SKU
// row first), so the loser commits nothing, and no payment is recorded for a
// sale its counter cannot hand over.
import { and, eq, sql } from "drizzle-orm";
import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { inventoryLevels, inventoryLocations, orderItems, orders, salesChannelLocations, user } from "@scalius/database/schema";
import type { PointOfSaleTenderVia } from "@scalius/shared/payment-terms";
import { AppError } from "../../../errors";
import { assertInventoryLocationCovers, InventoryLocationShortfallError, type InventoryLocationRef } from "../../inventory";
import type { PointOfSaleInput } from "../validation";

/** The receipt facts a sale commits with (order_events kind `pos_sale`, the order's `pointOfSale`). */
export interface PointOfSaleFacts {
    locationId: string;
    staffMemberId: string | null;
    tenders: Array<{ via: PointOfSaleTenderVia; amountMinor: number; reference: string | null }>;
    tenderedMinor: number;
    changeMinor: number;
}

/** One payment a sale records: a tender less the change it gave back. */
export interface PointOfSalePayment {
    /** The tender's position: the payment's retry key names it. */
    index: number;
    via: PointOfSaleTenderVia;
    amountMinor: number;
    reference: string | null;
}

export interface PointOfSaleTenderPlan {
    facts: PointOfSaleFacts;
    payments: PointOfSalePayment[];
}

/**
 * The location the sale hands its goods over at: an active location the
 * order's sales channel sells from. The staff member who rang it up, when
 * named, is someone on staff who can work now.
 */
export async function resolvePointOfSaleLocation(
    db: Database,
    sale: PointOfSaleInput,
    salesChannelId: string,
): Promise<InventoryLocationRef> {
    const [location, linked, staff] = await Promise.all([
        db.select({ id: inventoryLocations.id, name: inventoryLocations.name, status: inventoryLocations.status })
            .from(inventoryLocations).where(eq(inventoryLocations.id, sale.locationId)).get(),
        db.select({ locationId: salesChannelLocations.locationId })
            .from(salesChannelLocations)
            .where(and(eq(salesChannelLocations.channelId, salesChannelId), eq(salesChannelLocations.locationId, sale.locationId)))
            .get(),
        sale.staffMemberId
            ? db.select({ id: user.id, banned: user.banned, banExpires: user.banExpires }).from(user).where(eq(user.id, sale.staffMemberId)).get()
            : Promise.resolve(null),
    ]);
    if (!location || location.status !== "active") {
        throw new AppError(422, "pos_location_unavailable", "That location does not exist or is archived.", { locationId: sale.locationId });
    }
    if (!linked) {
        throw new AppError(422, "pos_location_not_on_channel", "The sales channel does not sell from that location. Link it in Settings → Sales channels.", {
            locationId: sale.locationId,
            salesChannelId,
        });
    }
    if (sale.staffMemberId) {
        const active = staff && (!staff.banned || (staff.banExpires !== null && staff.banExpires.getTime() <= Date.now()));
        if (!active) {
            throw new AppError(422, "pos_staff_unknown", "No active staff member has that id.", { staffMemberId: sale.staffMemberId });
        }
    }
    return { id: location.id, name: location.name };
}

/**
 * Refuses, before anything is written, a sale whose location lacks the
 * units of its tracked physical lines (409 `inventory_location_shortfall`):
 * the hand-over at the counter deducts them there.
 */
export async function assertPointOfSaleStock(
    db: Database,
    location: InventoryLocationRef,
    lines: ReadonlyArray<{ variantId: string; quantity: number; inventoryTracked?: boolean; fulfillmentType?: string }>,
): Promise<void> {
    await assertInventoryLocationCovers(db, location, lines
        .filter((line) => line.inventoryTracked && line.fulfillmentType === "pickup")
        .map((line) => ({ variantId: line.variantId, quantity: line.quantity })));
}

const POINT_OF_SALE_STOCK_GUARD = "POS_LOCATION_STOCK_SHORT";

/**
 * The commit guard of a sale (after its order and lines in the batch): every
 * tracked picked-up SKU of the order is covered at the counter, counting the
 * units every reserved order naming that location holds there, this one
 * included. Physical lines only: digital units leave where they are.
 */
export function buildPointOfSaleStockGuard(db: Database, orderId: string, locationId: string) {
    return buildBatchGuard(db, sql`NOT EXISTS (
        SELECT 1 FROM ${orderItems} AS sold
        WHERE sold.order_id = ${orderId}
          AND sold.variant_id IS NOT NULL
          AND sold.inventory_tracked
          AND sold.fulfillment_type = 'pickup'
          AND coalesce((
            SELECT level.on_hand FROM ${inventoryLevels} AS level
            WHERE level.variant_id = sold.variant_id AND level.location_id = ${locationId}
          ), 0) < (
            SELECT coalesce(sum(held.quantity), 0)
            FROM ${orders} AS holder
            JOIN ${orderItems} AS held ON held.order_id = holder.id
            WHERE holder.fulfillment_location_id = ${locationId}
              AND holder.inventory_action = 'reserved'
              AND held.variant_id = sold.variant_id
              AND held.inventory_tracked
              AND held.fulfillment_type IN ('ship', 'pickup')
          )
    )`, POINT_OF_SALE_STOCK_GUARD);
}

/** The sale's commit lost its counter's units to another order: 409 `inventory_location_shortfall`, nothing written. */
export function pointOfSaleStockShortfall(error: unknown, location: InventoryLocationRef): InventoryLocationShortfallError | null {
    if (!isBatchGuardError(error, POINT_OF_SALE_STOCK_GUARD)) return null;
    return new InventoryLocationShortfallError(
        `${location.name} no longer has the units: another sale took them first. Move stock there or choose another location.`,
        { locationId: location.id },
    );
}

/**
 * The payments a sale's tenders make on its total. The tenders cover the
 * total (422 `pos_tender_short`); the excess is change, given back from the
 * cash (the last cash tender first), so it never exceeds the cash tendered
 * (422 `pos_change_without_cash`: a card is charged exactly). A cash tender
 * the change wholly returns records no payment. A quote (`allowShort`) may
 * plan tenders that do not cover the total yet: no change, and the rest due.
 */
export function planPointOfSaleTenders(sale: PointOfSaleInput, totalMinor: number, { allowShort = false }: { allowShort?: boolean } = {}): PointOfSaleTenderPlan {
    const tenders = sale.tenders.map((tender) => ({ via: tender.via, amountMinor: tender.amountMinor, reference: tender.reference?.trim() || null }));
    const tenderedMinor = tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
    if (tenderedMinor < totalMinor && !allowShort) {
        throw new AppError(422, "pos_tender_short", "The tenders do not cover the total.", { totalMinor, tenderedMinor });
    }
    const changeMinor = Math.max(0, tenderedMinor - totalMinor);
    const cashMinor = tenders.filter((tender) => tender.via === "cash").reduce((sum, tender) => sum + tender.amountMinor, 0);
    if (changeMinor > cashMinor) {
        throw new AppError(422, "pos_change_without_cash", "Only cash gives change: charge a card or wallet the exact amount still due.", { totalMinor, tenderedMinor });
    }
    const net = tenders.map((tender) => tender.amountMinor);
    let owed = changeMinor;
    for (let index = tenders.length - 1; index >= 0 && owed > 0; index--) {
        if (tenders[index]!.via !== "cash") continue;
        const back = Math.min(owed, net[index]!);
        net[index] = net[index]! - back;
        owed -= back;
    }
    return {
        facts: { locationId: sale.locationId, staffMemberId: sale.staffMemberId ?? null, tenders, tenderedMinor, changeMinor },
        payments: tenders.flatMap((tender, index) => net[index]! > 0
            ? [{ index, via: tender.via, amountMinor: net[index]!, reference: tender.reference }]
            : []),
    };
}
