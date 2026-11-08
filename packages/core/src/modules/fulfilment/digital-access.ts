// Giving a buyer access to a digital asset on one of their order lines (the
// stable app API's `digital_access.grant`, routes/admin/resources-digital.ts).
// A grant never invents a delivery path of its own:
//
//   - a line still owed is handed over by the order's automatic fulfilment
//     (`autoFulfilOrder`): the same settlement, confirmation-mode and hold
//     checks, the same ledger row, FIFO licence keys and delivery message,
//     rechecked at commit. It hands over every automatic line the order still
//     owes, as the sweep would have;
//   - a revoked access is reinstated (its count and expiry stay);
//   - a file added after the line was handed over gets the entitlement the
//     delivery would have written (`fileEntitlementRow`). Licence keys go out
//     only with a line's delivery: their stock moved with it, so a pool added
//     later is refused rather than taking keys outside the ledger.
//
// Every path is idempotent: one entitlement per line and asset (unique
// index), a reinstate sets a target state, and the handover's own request key
// names the units it hands over. Reinstating and late files commit only while
// the order is still settled, open and not on hold.
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { digitalAssets, orderItems, orders } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
    fileEntitlementRow,
    findLineDigitalEntitlement,
    insertDigitalEntitlementStatement,
    reinstateDigitalEntitlementStatement,
} from "../digital";
import { noOpenOrderHoldCondition } from "../orders";
import { AppError, ConflictError, NotFoundError } from "../../errors";
import { AUTO_HANDOVER_CLOSED_ORDER_STATUSES, AUTO_HANDOVER_SETTLED_PAYMENT_STATUSES, autoFulfilOrder } from "./auto-fulfil";
import { AutoFulfilLinesOwedError, FULFILLER_REGISTRY, type AutoFulfilRuntime, type FulfillerRegistry } from "./registry";

/** `issued`: a new entitlement. `reinstated`: a revoked one given back. `unchanged`: the buyer already had it. */
export type DigitalAccessGrantOutcome = "issued" | "reinstated" | "unchanged";

export interface DigitalAccessGrantResult {
    entitlementId: string;
    outcome: DigitalAccessGrantOutcome;
}

const ORDER_CHANGED = "DIGITAL_ACCESS_ORDER_CHANGED";
const ORDER_ON_HOLD = "DIGITAL_ACCESS_ORDER_ON_HOLD";

const orderUnpaid = () => new AppError(409, "digital_access_order_unpaid", "The order isn't paid yet: digital goods go out once it is.");
const orderClosed = () => new AppError(409, "digital_access_order_closed", "The order was cancelled, refunded or returned, so it gives no access.");
const orderOnHold = () => new AppError(409, "digital_access_order_on_hold", "The order is on hold for review. Release the hold first.");

function assertOrderGrants(order: { status: string; paymentStatus: string; deletedAt: unknown } | undefined): void {
    if (!order || order.deletedAt) throw new NotFoundError("Order not found");
    if ((AUTO_HANDOVER_CLOSED_ORDER_STATUSES as string[]).includes(order.status)) throw orderClosed();
    if (!(AUTO_HANDOVER_SETTLED_PAYMENT_STATUSES as string[]).includes(order.paymentStatus)) throw orderUnpaid();
}

/** A write that gives access commits only while the order still grants it. */
async function commitWhileOrderGrants(db: Database, orderId: string, statements: BatchItem<"sqlite">[]): Promise<void> {
    try {
        await safeBatch(db, [
            buildBatchGuard(db, noOpenOrderHoldCondition(orderId), ORDER_ON_HOLD) as BatchItem<"sqlite">,
            buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId}
                AND ${isNull(orders.deletedAt)}
                AND ${notInArray(orders.status, AUTO_HANDOVER_CLOSED_ORDER_STATUSES)}
                AND ${inArray(orders.paymentStatus, AUTO_HANDOVER_SETTLED_PAYMENT_STATUSES)})`, ORDER_CHANGED) as BatchItem<"sqlite">,
            ...statements,
        ]);
    } catch (error) {
        if (isBatchGuardError(error, ORDER_ON_HOLD)) throw orderOnHold();
        if (isBatchGuardError(error, ORDER_CHANGED)) {
            assertOrderGrants(await db.select({ status: orders.status, paymentStatus: orders.paymentStatus, deletedAt: orders.deletedAt })
                .from(orders).where(eq(orders.id, orderId)).get());
            throw new ConflictError("The order changed while access was being given. Try again.");
        }
        throw error;
    }
}

/**
 * Gives the buyer of `orderItemId` access to `assetId` (see the file
 * comment). Refused with a named code when the order is unpaid, closed, on
 * hold or waiting for staff confirmation, when the line's product does not
 * carry the asset, when the asset is not ready, and when a pool cannot cover
 * the line (`digital_keys_exhausted`).
 */
export async function grantDigitalAccess(
    db: Database,
    input: { orderId: string; orderItemId: string; assetId: string },
    runtime: AutoFulfilRuntime = {},
    registry: FulfillerRegistry = FULFILLER_REGISTRY,
): Promise<DigitalAccessGrantResult> {
    const order = await db.select({ status: orders.status, paymentStatus: orders.paymentStatus, deletedAt: orders.deletedAt })
        .from(orders).where(eq(orders.id, input.orderId)).get();
    assertOrderGrants(order);
    const line = await db.select({
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        fulfilledQuantity: orderItems.fulfilledQuantity,
        fulfillmentType: orderItems.fulfillmentType,
    }).from(orderItems).where(and(eq(orderItems.id, input.orderItemId), eq(orderItems.orderId, input.orderId))).get();
    if (!line) throw new NotFoundError("Order line not found");
    const asset = await db.select({
        id: digitalAssets.id,
        productId: digitalAssets.productId,
        variantId: digitalAssets.variantId,
        kind: digitalAssets.kind,
        status: digitalAssets.status,
        downloadLimit: digitalAssets.downloadLimit,
        accessDays: digitalAssets.accessDays,
    }).from(digitalAssets).where(eq(digitalAssets.id, input.assetId)).get();
    if (!asset) throw new NotFoundError("Digital item not found");
    const carried = line.fulfillmentType === "digital"
        && asset.productId === line.productId
        && (asset.kind === "file" ? asset.variantId === null || asset.variantId === line.variantId : asset.variantId === line.variantId);
    if (!carried) throw new AppError(422, "digital_asset_not_on_line", "This line's product and variant don't deliver this digital item.");

    const existing = await findLineDigitalEntitlement(db, input.orderItemId, input.assetId);
    if (existing && existing.revokedAt === null) return { entitlementId: existing.id, outcome: "unchanged" };
    if (existing) {
        await commitWhileOrderGrants(db, input.orderId, [reinstateDigitalEntitlementStatement(db, existing.id)]);
        return { entitlementId: existing.id, outcome: "reinstated" };
    }
    if (asset.status !== "ready") throw new AppError(409, "digital_asset_not_ready", "This digital item isn't ready to deliver (a file still uploading, or archived).");

    if (line.fulfilledQuantity < line.quantity) {
        // Owed units: the order's automatic handover delivers them, or says why not.
        let failure: unknown = null;
        try {
            const run = await autoFulfilOrder(db, input.orderId, registry, runtime);
            if (run.skipped === "unsettled") throw orderUnpaid();
            if (run.skipped === "closed") throw orderClosed();
            if (run.skipped === "on_hold" || run.skipped === "hold_window") throw orderOnHold();
            if (run.skipped === "awaiting_confirmation") {
                throw new AppError(409, "digital_access_awaiting_confirmation", "The store hands digital goods over once staff confirm the order. Confirm it first.");
            }
        } catch (error) {
            failure = error;
        }
        // Another automatic line of the order (a gift card) may fail while this one was delivered.
        const delivered = await findLineDigitalEntitlement(db, input.orderItemId, input.assetId);
        if (delivered) return { entitlementId: delivered.id, outcome: "issued" };
        if (failure instanceof AutoFulfilLinesOwedError && failure.orderItemIds.includes(input.orderItemId)) {
            throw new AppError(409, "digital_keys_exhausted", "The licence-key pool has too few keys for this line. Import more keys, then grant again.");
        }
        if (failure !== null && !(failure instanceof AutoFulfilLinesOwedError)) throw failure;
        // Nothing was owed after all (the units were refunded meanwhile): the line as it now stands decides.
    }

    const now = await db.select({ fulfilledQuantity: orderItems.fulfilledQuantity }).from(orderItems).where(eq(orderItems.id, input.orderItemId)).get();
    if (!now || now.fulfilledQuantity < 1) {
        throw new AppError(409, "digital_access_nothing_owed", "Every unit of this line was refunded, so it gives no access.");
    }
    if (asset.kind === "licence_keys") {
        throw new AppError(409, "digital_access_keys_not_owed", "Licence keys go out only with a line's delivery, and this line was handed over without this pool.");
    }
    const row = fileEntitlementRow(asset, { orderId: input.orderId, orderItemId: input.orderItemId, fulfillmentId: null }, Math.floor(Date.now() / 1000));
    await commitWhileOrderGrants(db, input.orderId, [insertDigitalEntitlementStatement(db, row)]);
    const issued = await findLineDigitalEntitlement(db, input.orderItemId, input.assetId);
    if (!issued) throw new NotFoundError("Digital access not found");
    // A racing grant wrote it first: still one entitlement, and this call issued nothing.
    return { entitlementId: issued.id, outcome: issued.id === row.id ? "issued" : "unchanged" };
}
