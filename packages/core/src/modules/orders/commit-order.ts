// The one order commit: a fully priced order, its customer, its stock and its
// channel's own facts in one guarded batch. The storefront checkout, buyer
// agents and staff/app orders all commit through `commitOrder()`; each keeps
// only its policy (who may order, how the order was priced, its idempotency
// record) and hands the kernel the statements that policy adds.
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    abandonedCheckouts,
    codTracking,
    customerHistory,
    customers,
    orderItems,
    orderItemTaxSnapshots,
    orders,
    orderTaxSnapshots,
} from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import type { AppliedAppDiscount } from "@scalius/shared/checkout-app-facts";
import { storedPhone } from "@scalius/shared/customer-auth-policy";
import { orderMoneyChainColumns } from "@scalius/shared/money-chain";
import type { OrderChannel } from "@scalius/shared/order-channel";
import { BUILT_IN_SALES_CHANNEL_IDS } from "@scalius/shared/sales-channels";
import { ConflictError, ServiceUnavailableError, ValidationError } from "../../errors";
import { linkedOrderHistory, type VerifiedContact } from "../customers";
import {
    isInventoryReservationConflictError,
    prepareStockReservationBatch,
    type PreparedStockReservationBatch,
    type ReservationVariantState,
} from "../inventory";
import { orderMarketIdSql } from "../markets";
import { buildAppDiscountFactInserts } from "../order-kernel";
import { createCODTrackingInsertValues } from "../payments";
import {
    ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW,
    orderItemTaxSnapshotColumns,
    orderTaxSnapshotColumns,
    type TaxQuote,
} from "../tax";
import { orderBillingAddressInsertColumns } from "./billing-address";
import { nextOrderNumberSql } from "./number";
import { deferredOrderColumns } from "./payment-terms-columns";
import { orderShippingAddressInsertColumns, orderShippingCountry } from "./shipping-address";
import type { OrderFacts, OrderLine } from "./types";
import { ABANDONED_CHECKOUT_SESSION_ID_PATTERN } from "./validation";

type SQLiteBatchItem = BatchItem<"sqlite">;
type ReservationPool = "regular" | "preorder" | "backorder";

// Bound values per order line (the constant columns are SQL literals, the
// warranty lookup binds the SKU id once more); the D1 limit is 100 per
// statement, so 5 rows a statement (95 values).
export const ORDER_ITEM_INSERT_PARAMETERS_PER_ROW = 19;
const INVENTORY_COMMIT_MAX_CONFLICTS = 3;
const INVENTORY_COMMIT_BASE_BACKOFF_MS = 5;
const ORDER_CUSTOMER_ACCOUNT_INACTIVE = "ORDER_CUSTOMER_ACCOUNT_INACTIVE";
const ORDER_CUSTOMER_RETIRED = "ORDER_CUSTOMER_RETIRED";

/** A fully priced order, as every channel commits it. */
export interface OrderPlan {
    /** The surface that created the order (`orders.channel`; the orders trigger keeps it immutable). */
    channel: OrderChannel;
    /** Where a staff or app order came in (facebook, walk_in, ...), normalized; null otherwise. */
    channelSource?: string | null;
    /** The channel whose publications the order sold from and whose locations hold its stock (MARKETS-DESIGN D6). */
    salesChannelId: string;
    order: OrderFacts;
    /** Checkout's selected market, protected by the channel's authority fence. */
    marketCountry?: string | null;
    lines: readonly OrderLine[];
    taxQuote: TaxQuote;
    /** App discounts on the lines (checkout functions), recorded as immutable `app_discount` facts. */
    appDiscounts?: readonly AppliedAppDiscount[];
    /** The stable identity of the order's ledger-v2 reservation movements. */
    reservationKey: string;
    /**
     * The abandoned-checkout session the order completes (a storefront
     * checkout's session id, or the snapshot staff created the order from):
     * its row is deleted in the order batch. Any other id deletes nothing.
     */
    abandonedCheckoutId?: string | null;
}

/** The customer record an order is filed under, resolved by its channel's policy. */
export interface OrderCustomer {
    id: string;
    accountOwnerCustomerId: string | null;
    /** No record owns the order's contact yet: the commit creates this guest record, its history logged as created by this actor. */
    createdBy?: "buyer" | "staff" | null;
    /** A signed-out order filed to an account by its verified email or phone (logged on the account). */
    linkedBy?: VerifiedContact | null;
    /** The record must still be a live, claimed account when the batch runs (a signed-in buyer). */
    requireLiveAccount?: boolean;
}

/** A channel's part of the batch. */
export interface OrderCommitPrelude {
    customer: OrderCustomer;
    /** Before the stock moves: idempotency claims and the channel's fences. */
    before?: readonly SQLiteBatchItem[];
    /** After the order's own rows: facts that reference the order (receipts, promotions, outbox claims). */
    after?: readonly SQLiteBatchItem[];
}

export interface OrderCommitChannel {
    /**
     * Resolves the customer and builds the channel's statements. Called again
     * after a retryable conflict (a guest record created concurrently, stock
     * that changed), so whatever it read it reads again.
     */
    prepare(): Promise<OrderCommitPrelude>;
    /** Reservation counters the channel's read batch already holds (the first round only). */
    variantStates?: readonly ReservationVariantState[];
    /** The order cannot hold its stock: the channel's error. */
    stockUnavailable(reservation: PreparedStockReservationBatch): Error;
    /** The channel's reading of a failed batch (its own guards), before the kernel's own retries. */
    mapError?(error: unknown): Error | null | Promise<Error | null>;
}

export interface OrderCommitResult {
    orderId: string;
    customerId: string | null;
    accountOwnerCustomerId: string | null;
    /** The order already existed (an earlier, uncertain batch committed it): this call wrote nothing. */
    alreadyCommitted: boolean;
    /** Reserved variants whose buyer availability band changed in this commit. */
    availabilityTransitionVariantIds: string[];
}

/**
 * Commits a fully priced order in one batch: the channel's claims, the stock
 * reservation (ledger v2, fresh: a new order id holds none), the customer,
 * the order, its lines, tax snapshots, cash-on-delivery state and app
 * discount facts, then the channel's own facts. Any failure rolls back all
 * of it. A batch that fails after committing (a lost response) resolves to
 * the committed order; a concurrent guest record and moving stock are retried.
 */
export async function commitOrder(
    db: Database,
    plan: OrderPlan,
    channel: OrderCommitChannel,
): Promise<OrderCommitResult> {
    let variantStates = channel.variantStates;
    let customerRaceRetried = false;
    let customerRetiredRetried = false;
    let inventoryConflicts = 0;

    while (true) {
        const [preludeResult, reservationResult] = await Promise.allSettled([
            channel.prepare(),
            prepareOrderReservation(db, plan, variantStates),
        ]);
        variantStates = undefined;
        // Stock is reported first: a buyer fixes the cart before anything else.
        if (reservationResult.status === "rejected") throw reservationResult.reason;
        const reservation = reservationResult.value;
        if (!reservation.success) throw channel.stockUnavailable(reservation);
        if (preludeResult.status === "rejected") throw preludeResult.reason;
        const prelude = preludeResult.value;

        const before = prelude.before ?? [];
        const statements: SQLiteBatchItem[] = [
            ...before,
            ...reservation.statements,
            ...orderRowStatements(db, plan, prelude.customer),
            ...abandonedCheckoutStatements(db, plan),
            ...(prelude.after ?? []),
        ];
        let results: readonly unknown[];
        try {
            results = await safeBatch(db, statements) as readonly unknown[];
        } catch (error) {
            const committed = await loadCommittedOrder(db, plan.order.id).catch(() => undefined);
            if (committed) {
                return {
                    orderId: committed.id,
                    customerId: committed.customerId,
                    accountOwnerCustomerId: committed.accountOwnerCustomerId,
                    alreadyCommitted: true,
                    availabilityTransitionVariantIds: [],
                };
            }
            // The channel's guards first: their markers are specific, the
            // inventory classifier treats any "conflict" text as retryable.
            const mapped = await channel.mapError?.(error);
            if (mapped) throw mapped;
            if (isBatchGuardError(error, ORDER_CUSTOMER_ACCOUNT_INACTIVE)) {
                throw new ValidationError("Customer account is no longer active. Please sign in again.");
            }
            // The record the order was filed under was trashed or erased since the read: resolve
            // the customer again (a guest order gets a fresh guest record), once.
            if (isBatchGuardError(error, ORDER_CUSTOMER_RETIRED)) {
                if (customerRetiredRetried) {
                    throw new ConflictError("The customer record changed while the order was being placed. Please try again.");
                }
                customerRetiredRetried = true;
                continue;
            }
            if (!customerRaceRetried && prelude.customer.createdBy && isCustomerContactConstraintError(error)) {
                customerRaceRetried = true;
                continue;
            }
            if (isInventoryReservationConflictError(error)) {
                inventoryConflicts += 1;
                if (inventoryConflicts < INVENTORY_COMMIT_MAX_CONFLICTS) {
                    await new Promise((resolve) => setTimeout(
                        resolve,
                        INVENTORY_COMMIT_BASE_BACKOFF_MS * Math.pow(2, inventoryConflicts - 1),
                    ));
                    continue;
                }
                throw new ServiceUnavailableError("Inventory is changing quickly. Please retry checkout.");
            }
            throw error;
        }

        return {
            orderId: plan.order.id,
            customerId: prelude.customer.id,
            accountOwnerCustomerId: prelude.customer.accountOwnerCustomerId,
            alreadyCommitted: false,
            availabilityTransitionVariantIds: reservation.availabilityTransitions(
                results.slice(before.length, before.length + reservation.statements.length),
            ),
        };
    }
}

/**
 * The abandoned checkout the order completes ends with it: deleted in the same
 * batch, so no recovery list shows a checkout that became an order. Only a
 * checkout session id names one (an archived hosted-payment order's row is
 * keyed by its order id and is never deleted here).
 */
function abandonedCheckoutStatements(db: Database, plan: OrderPlan): SQLiteBatchItem[] {
    const checkoutId = plan.abandonedCheckoutId?.trim();
    if (!checkoutId || !ABANDONED_CHECKOUT_SESSION_ID_PATTERN.test(checkoutId)) return [];
    return [db.delete(abandonedCheckouts).where(eq(abandonedCheckouts.checkoutId, checkoutId))];
}

/** The tracked lines an order reserves: none unless it holds stock from commit. */
function reservedLines(plan: OrderPlan): OrderLine[] {
    if (plan.order.inventoryAction !== "reserved") return [];
    return plan.lines.filter((line) => line.variantId !== null && line.inventoryTracked !== false);
}

function prepareOrderReservation(
    db: Database,
    plan: OrderPlan,
    variantStates: readonly ReservationVariantState[] | undefined,
): Promise<PreparedStockReservationBatch> {
    return prepareStockReservationBatch(
        db,
        reservedLines(plan).map((line) => ({ variantId: line.variantId, quantity: line.quantity, orderId: plan.order.id })),
        plan.order.inventoryPool as ReservationPool,
        {
            reservationKey: plan.reservationKey,
            // The order is new: its id holds no reservation yet (an earlier
            // batch for it committed or rolled back as a whole).
            freshOrderIds: new Set([plan.order.id]),
            variantStates,
            // Units at the locations the order's channel sells from (MARKETS-DESIGN D6).
            salesChannelId: plan.salesChannelId,
        },
    );
}

async function loadCommittedOrder(db: Database, orderId: string) {
    return db
        .select({
            id: orders.id,
            customerId: orders.customerId,
            accountOwnerCustomerId: orders.accountOwnerCustomerId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
}

/** Two orders raced to create the same phone's (or phoneless email's) guest record. */
function isCustomerContactConstraintError(error: unknown): boolean {
    let current = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
        const message = current instanceof Error
            ? current.message
            : typeof current === "string"
                ? current
                : "";
        if (
            message.includes("UNIQUE constraint failed: customers.phone")
            || message.includes("customers_guest_phone_unique")
            || message.includes("customers_guest_email_unique")
        ) {
            return true;
        }
        current = current instanceof Error
            ? (current as Error & { cause?: unknown }).cause
            : null;
    }
    return false;
}

/**
 * The line's warranty as bought: the current revision of its SKU's effective
 * policy, read in the commit batch itself (no round trip) so the line freezes
 * whatever is current at commit (design §5.1). A SKU in `policy` mode uses its
 * own policy, `none` has no warranty and `inherit` uses its product's. An
 * archived effective policy is NULL: an archived own policy never falls back
 * to the product's. The SKU row binds one value (its id); its policy column
 * is set exactly in `policy` mode (CHECK), so COALESCE picks the effective
 * one. An expanded bundle's lines are its components, so each freezes its
 * component SKU's warranty; a line an order amendment adds freezes the same
 * way. The tables carry their own aliases, so the subquery reads the same in
 * a multi-row insert and as a field of any select (whose own table renders
 * its columns unqualified). The warranty is not price-relevant, so it is
 * outside any authority fence.
 */
export function currentWarrantyRevisionSql(variantId: string) {
    return sql<string | null>`(
        SELECT warranty_policy.current_revision_id
        FROM product_variants AS warranty_sku
        JOIN products AS warranty_product ON warranty_product.id = warranty_sku.product_id
        JOIN warranty_policies AS warranty_policy
          ON warranty_policy.id = COALESCE(warranty_sku.warranty_policy_id, warranty_product.warranty_policy_id)
        WHERE warranty_sku.id = ${variantId}
          AND warranty_sku.warranty_mode <> 'none'
          AND warranty_policy.archived_at IS NULL
    )`;
}

/** A built-in channel id is a constant: an SQL literal binds nothing (the order insert binds close to D1's 100). */
function salesChannelIdValue(salesChannelId: string) {
    return (BUILT_IN_SALES_CHANNEL_IDS as readonly string[]).includes(salesChannelId)
        ? sql.raw(`'${salesChannelId}'`)
        : salesChannelId;
}

function customerStatements(db: Database, od: OrderFacts, customer: OrderCustomer): SQLiteBatchItem[] {
    const writes: SQLiteBatchItem[] = [];
    if (customer.requireLiveAccount) {
        writes.push(buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${customers}
            WHERE ${customers.id} = ${customer.id}
              AND ${customers.deletedAt} IS NULL
              AND ${customers.accountClaimedAt} IS NOT NULL
        )`, ORDER_CUSTOMER_ACCOUNT_INACTIVE) as SQLiteBatchItem);
    }
    if (customer.createdBy) {
        writes.push(db.insert(customers).values({
            id: customer.id,
            name: od.customerName,
            email: od.customerEmail,
            phone: storedPhone(od.customerPhone),
            totalOrders: 1,
            lastOrderAt: sql`unixepoch()`,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }));
        writes.push(db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: customer.id,
            name: od.customerName,
            email: od.customerEmail,
            phone: storedPhone(od.customerPhone),
            changeType: "created",
            actor: customer.createdBy,
            createdAt: sql`unixepoch()`,
        }));
        return writes;
    }
    // An existing record must still be live and not erased when the batch runs: an order never
    // lands on a trashed or erased record (an erased one keeps no personal data).
    writes.push(buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${customers}
        WHERE ${customers.id} = ${customer.id}
          AND ${customers.deletedAt} IS NULL
          AND ${customers.erasedAt} IS NULL
    )`, ORDER_CUSTOMER_RETIRED) as SQLiteBatchItem);
    // Counters only: the order's contact never rewrites the customer.
    writes.push(db.update(customers).set({
        totalOrders: sql`${customers.totalOrders} + 1`,
        lastOrderAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }).where(eq(customers.id, customer.id)));
    if (customer.linkedBy && customer.accountOwnerCustomerId) {
        writes.push(linkedOrderHistory(db, {
            accountId: customer.accountOwnerCustomerId,
            orderId: od.id,
            via: customer.linkedBy,
        }) as SQLiteBatchItem);
    }
    return writes;
}

/** The order's own rows: its customer, the order, COD state, lines, tax snapshots and app discount facts. */
function orderRowStatements(db: Database, plan: OrderPlan, customer: OrderCustomer): SQLiteBatchItem[] {
    const od = plan.order;
    const writes = customerStatements(db, od, customer);

    writes.push(db.insert(orders).values({
        orderNumber: nextOrderNumberSql(db),
        id: od.id,
        customerName: od.customerName,
        customerPhone: storedPhone(od.customerPhone),
        customerEmail: od.customerEmail,
        customerWhatsapp: od.customerWhatsapp ?? null,
        // The address snapshot (a guest record's first one also seeds its
        // address book: trigger orders_seed_customer_address).
        ...orderShippingAddressInsertColumns(od),
        // The billing snapshot; "same as shipping" is an SQL literal, so a
        // shipped order binds nothing more than it did before 0119.
        ...orderBillingAddressInsertColumns(od),
        notes: od.notes,
        attributes: od.attributes ?? "{}",
        currencyCode: od.currencyCode,
        currencyDecimalPlaces: od.currencyDecimalPlaces,
        subtotalAmountMinor: od.subtotalAmountMinor,
        shippingAmountMinor: od.shippingAmountMinor,
        shippingMethodId: od.shippingMethodId,
        shippingMethodName: od.shippingMethodName,
        shippingMethodDescription: od.shippingMethodDescription,
        shippingMethodBaseAmountMinor: od.shippingMethodBaseAmountMinor,
        shippingFeeWaived: od.shippingFeeWaived,
        // A payload without the fulfilment facts ships; the orders trigger re-checks the address.
        requiresShipping: od.requiresShipping ?? true,
        shippingMethodKind: od.shippingMethodKind ?? null,
        pickupAddress: od.pickupAddress ?? null,
        pickupHours: od.pickupHours ?? null,
        discountAmountMinor: od.discountAmountMinor,
        taxAmountMinor: od.taxAmountMinor,
        totalAmountMinor: od.totalAmountMinor,
        // The money chain, in this same insert: a same-currency order has rate
        // 1 and shop amounts equal to its own; an order in a market's currency
        // keeps its locked rate and its exact shop amounts (MARKETS-DESIGN D3).
        ...orderMoneyChainColumns(od, od.fx ? {
            shopCurrency: od.fx.shopCurrency,
            fxRate: od.fx.fxRate,
            fxSource: od.fx.fxSource,
            fxAsOf: od.fx.fxAsOf === null ? null : new Date(od.fx.fxAsOf * 1_000),
            fxLockedUntil: od.fx.fxLockedUntil === null ? null : new Date(od.fx.fxLockedUntil * 1_000),
        } : undefined),
        taxLabel: od.taxLabel,
        pricesIncludeTax: od.pricesIncludeTax,
        status: od.status,
        paymentMethod: od.paymentMethod,
        paymentStatus: od.paymentStatus,
        paidAmountMinor: od.paidAmountMinor,
        balanceDueMinor: od.balanceDueMinor,
        // A deferred order's terms and due date, as SQL literals (a checked
        // whole number of days): every other order binds nothing more.
        ...deferredOrderColumns(od.paymentTermsDays),
        fulfillmentStatus: od.fulfillmentStatus,
        inventoryPool: od.inventoryPool,
        inventoryAction: od.inventoryAction,
        customerId: customer.id,
        accountOwnerCustomerId: customer.accountOwnerCustomerId,
        // Set once here; the orders trigger keeps it immutable.
        channel: plan.channel,
        channelSource: plan.channelSource ?? null,
        salesChannelId: salesChannelIdValue(plan.salesChannelId),
        // Checkout retains its selected market through transforms; other channels
        // derive it from their final shipping/billing facts. The channel's fence
        // protects the active market lookup inside this insert.
        marketId: orderMarketIdSql(plan.marketCountry !== undefined ? plan.marketCountry : orderShippingCountry(od) ?? (
            plan.taxQuote.jurisdiction?.addressSource === "billing" ? od.billingCountryCode ?? null : null
        )),
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }));

    // A COD order and its collection lifecycle are one durable fact.
    if (od.paymentMethod === "cod") {
        writes.push(db.insert(codTracking).values(createCODTrackingInsertValues(od.id)));
    }

    if (plan.lines.length > 0) {
        const itemRows = plan.lines.map((line) => ({
            id: line.id,
            orderId: od.id,
            productId: line.productId,
            variantId: line.variantId,
            productImageMediaId: line.productImageMediaId,
            quantity: line.quantity,
            productName: line.productName,
            variantLabel: line.variantLabel,
            inventoryTracked: line.variantId !== null && line.inventoryTracked !== false,
            unitPriceMinor: line.unitPriceMinor,
            lineSubtotalMinor: line.lineSubtotalMinor,
            discountAmountMinor: line.discountAmountMinor,
            taxableAmountMinor: line.taxableAmountMinor,
            taxAmountMinor: line.taxAmountMinor,
            // Constant columns are SQL literals, not bound values: a
            // multi-row insert binds every defaulted column otherwise.
            // The ledger alone moves fulfilled_quantity afterwards.
            fulfilledQuantity: sql`0`,
            fulfillmentType: line.fulfillmentType ?? "ship",
            properties: line.properties ?? null,
            propertiesPriceMinor: line.propertiesPriceMinor ?? 0,
            baseUnitPriceMinor: line.baseUnitPriceMinor
                ?? line.unitPriceMinor - (line.propertiesPriceMinor ?? 0),
            warrantyRevisionId: currentWarrantyRevisionSql(line.variantId),
            createdAt: sql`unixepoch()`,
        }));
        for (const chunk of chunkRowsForD1(itemRows, ORDER_ITEM_INSERT_PARAMETERS_PER_ROW)) {
            writes.push(db.insert(orderItems).values(chunk));
        }

        const taxRows = plan.lines.map((line) => {
            const taxLine = plan.taxQuote.lines.find((candidate) => candidate.lineId === line.taxAllocationLineId);
            if (!taxLine) {
                throw new ValidationError("Committed tax allocation is missing an order line.");
            }
            return {
                orderItemId: line.id,
                orderId: od.id,
                ...orderItemTaxSnapshotColumns(plan.taxQuote, taxLine),
                createdAt: sql`unixepoch()`,
            };
        });
        for (const chunk of chunkRowsForD1(taxRows, ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW)) {
            writes.push(db.insert(orderItemTaxSnapshots).values(chunk));
        }
    }

    writes.push(db.insert(orderTaxSnapshots).values({
        orderId: od.id,
        ...orderTaxSnapshotColumns(plan.taxQuote),
        createdAt: sql`unixepoch()`,
    }));

    // App discounts (checkout functions) on top of the platform's: the line
    // discount = platform part + app part, the app part as `app_discount` facts.
    if (plan.appDiscounts && plan.appDiscounts.length > 0) {
        writes.push(...buildAppDiscountFactInserts(db, {
            orderId: od.id,
            currencyCode: od.currencyCode,
            discounts: plan.appDiscounts,
            orderItemIdByLineId: new Map(plan.lines.map((line) => [line.taxAllocationLineId, line.id])),
        }) as SQLiteBatchItem[]);
    }

    return writes;
}
