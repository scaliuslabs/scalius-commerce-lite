// The single storefront order commit: one guarded batch for the order, lines, stock, discounts and receipt.
import { nextOrderNumberSql } from "../orders/number";
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    agentStorefrontContexts,
    agentStorefrontContinuations,
    agentStorefrontOrderGrants,
    checkoutAuthority,
    customers,
    customerHistory,
    orderItems,
    orderDiscountAllocations,
    orderItemTaxSnapshots,
    notificationOutbox,
    orderTaxSnapshots,
    orders,
    codTracking,
    promotionRedemptions,
} from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, ServiceUnavailableError, ValidationError } from "../../errors";
import {
    isInventoryReservationConflictError,
    prepareStockReservationBatch,
    type PreparedStockReservationBatch,
    type ReservationVariantState,
} from "../inventory";
import {
    buildMetaPurchaseOutboxClaimInsert,
    isOrderEligibleForMetaPurchase,
} from "../../integrations/meta/purchase-outbox";
import { createCODTrackingInsertValues } from "../payments/cod";
import {
    buildOrderCreatedNotificationDedupeKey,
    createOrderNotificationOutboxInsertValues,
    type OrderNotificationQueue,
} from "../notifications/order-notification-outbox";
import { shouldCreateOrderCreatedNotification } from "./created-notification-policy";
import type { StorefrontOrderCommitPayload } from "../orders/types";
import {
    chooseOrderCustomer,
    linkedOrderHistory,
    normalizeContactEmail,
    type VerifiedContact,
    selectContactCustomerCandidates,
    type OrderContact,
} from "../customers/customer-identity";
import type { StorefrontCartItemIssue } from "./cart-validation";
import { getPromotionRedemptionConstraintError, verifyPromotionCheckoutSnapshot } from "../promotions";
import { type AppliedPromotion } from "../promotions/browser";
import {
    prepareAtomicCheckoutAttemptCommit,
    isCheckoutAttemptCommitConflictError,
    type AtomicCheckoutAttempt,
} from "./attempts";
import { MAX_ORDER_LINE_ITEMS } from "../orders/validation";
import type { StorefrontOrderCommitReads, SQLiteBatchItem } from "./reads";

type ReservationPool = "regular" | "preorder" | "backorder";

export interface StorefrontOrderCommitRuntime {
    JOBS_QUEUE?: OrderNotificationQueue;
    STOREFRONT_URL?: string;
    CREDENTIAL_ENCRYPTION_KEY?: string;
}

export interface StorefrontOrderCommitResult {
    orderId: string;
    customerId: string | null;
    accountOwnerCustomerId: string | null;
    alreadyCommitted: boolean;
    /** Reserved variants whose buyer availability band changed in this commit. */
    availabilityTransitionVariantIds: string[];
}

export interface StorefrontOrderCheckoutCommit<TResponse = unknown> {
    attempt: AtomicCheckoutAttempt;
    response: TResponse;
    agentContext?: {
        contextId: string;
        grantId: string;
        expectedRevision: number;
        expiresAt: Date;
        continuation?: {
            id: string;
            kind: "payment";
            expiresAt: Date;
            bootstrapCodeHash: string;
        };
    };
}

type ReservationEntry = {
    variantId: string;
    quantity: number;
    pool: ReservationPool;
    orderId: string;
};

// Durable reservation identity from the old queued checkout path. Keep the
// value stable so crash retries can recognize reservations created before this
// source-level queue retirement.
const CHECKOUT_RESERVATION_KEY = "checkout-ingest:v1";
const INVENTORY_COMMIT_MAX_CONFLICTS = 3;
const INVENTORY_COMMIT_BASE_BACKOFF_MS = 5;
// Bound values per order line (the constant columns are SQL literals); the
// D1 limit is 100 per statement, so 5 rows a statement.
export const ORDER_ITEM_INSERT_PARAMETERS_PER_ROW = 18;
// order_item_id, order_id, tax_class_id, tax_class_name, prices_include_tax, rate_snapshot.
const ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW = 6;
const ORDER_DISCOUNT_ALLOCATION_INSERT_PARAMETERS_PER_ROW = 18;
const CHECKOUT_AUTHORITY_CHANGED = "CHECKOUT_AUTHORITY_CHANGED";
const CHECKOUT_AUTHORITY_CHANGED_MESSAGE =
    "Checkout details changed while the order was being placed. Return to your cart to review them and try again.";
// Checked before the inventory classifier, whose Turso matcher treats any
// "conflict" text as a retryable write conflict.
const AGENT_CONTEXT_CHECKOUT_CONFLICT = "AGENT_STOREFRONT_CONTEXT_CHECKOUT_CONFLICT";

function checkoutGuardError(error: unknown): Error | null {
    if (isBatchGuardError(error, CHECKOUT_AUTHORITY_CHANGED)) {
        return new ValidationError(CHECKOUT_AUTHORITY_CHANGED_MESSAGE);
    }
    if (isBatchGuardError(error, AGENT_CONTEXT_CHECKOUT_CONFLICT)) {
        return new ConflictError(
            "This storefront context changed, closed, or expired before the order was committed. Reload it and retry.",
        );
    }
    return null;
}

/** Two guest checkouts raced to create the same phone's guest record. */
function isCustomerPhoneConstraintError(error: unknown): boolean {
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
        ) {
            return true;
        }
        current = current instanceof Error
            ? (current as Error & { cause?: unknown }).cause
            : null;
    }
    return false;
}

async function loadExistingCommittedOrder(db: Database, orderId: string) {
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

interface ResolvedOrderCustomer {
    id: string;
    accountOwnerCustomerId: string | null;
    /** No customer owns this contact yet: a new guest record is created. */
    createProfile: boolean;
    /** A signed-out order filed to an account by its verified email/phone (logged on the account). */
    linkedBy?: VerifiedContact | null;
}

async function loadActiveAccountById(db: Database, id: string) {
    return db
        .select({ id: customers.id, accountClaimedAt: customers.accountClaimedAt })
        .from(customers)
        .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
        .get();
}

/**
 * Signed in: the account. Guest: the customer who PROVED the order's phone or
 * email, else the phone's guest record, else a new guest record. A guest
 * checkout never writes to an existing customer's profile (see
 * customers/customer-identity.ts).
 */
async function resolveCustomerForOrder(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    reads?: StorefrontOrderCommitReads,
): Promise<ResolvedOrderCustomer> {
    if (payload.existingCustomer?.id) {
        const account = await loadActiveAccountById(db, payload.existingCustomer.id);
        if (!account?.accountClaimedAt) {
            throw new ValidationError("Customer account is no longer active. Please sign in again.");
        }
        return { id: account.id, accountOwnerCustomerId: account.id, createProfile: false, linkedBy: null };
    }

    const contact: OrderContact = { phone: payload.orderData.customerPhone, email: payload.orderData.customerEmail };
    const candidates = reads
        && reads.contact.phone === contact.phone
        && normalizeContactEmail(reads.contact.email) === normalizeContactEmail(contact.email)
        ? reads.contactCustomers
        : await selectContactCustomerCandidates(db, contact);
    const chosen = chooseOrderCustomer(candidates, contact);
    return chosen
        ? { id: chosen.customerId, accountOwnerCustomerId: chosen.accountOwnerCustomerId, createProfile: false, linkedBy: chosen.linkedBy }
        : { id: "cust_" + nanoid(), accountOwnerCustomerId: null, createProfile: true, linkedBy: null };
}

function getReservationEntries(payload: StorefrontOrderCommitPayload): ReservationEntry[] {
    if (payload.orderData.inventoryAction !== "reserved") return [];
    return payload.items
        .filter((item): item is StorefrontOrderCommitPayload["items"][number] & { variantId: string } => item.variantId !== null && item.inventoryTracked !== false)
        .map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            pool: payload.orderData.inventoryPool as ReservationPool,
            orderId: payload.orderData.id,
        }));
}

function buildReservationItemIssues(
    payload: StorefrontOrderCommitPayload,
    results: Array<{ success: boolean; variantId: string; error?: string }>,
): StorefrontCartItemIssue[] {
    return results
        .filter((result) => !result.success)
        .map((result) => {
            const index = payload.items.findIndex((item) => item.variantId === result.variantId);
            const item = index >= 0 ? payload.items[index] : undefined;
            const productName = item?.productName ?? "This item";
            const variantLabel = item?.variantLabel ?? null;
            return {
                index: index >= 0 ? index : 0,
                cartKey: item?.cartKey ?? null,
                productId: item?.productId ?? "",
                variantId: result.variantId,
                code: "QUANTITY_UNAVAILABLE",
                action: "remove",
                message: `${productName}${variantLabel ? ` (${variantLabel})` : ""} is no longer available in the requested quantity.`,
                productName,
                variantLabel,
                requestedQuantity: item?.quantity ?? 0,
            };
        });
}

async function prepareOrderInventory(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    freshOrder = false,
    variantStates?: readonly ReservationVariantState[],
): Promise<PreparedStockReservationBatch> {
    const entries = getReservationEntries(payload);
    const result = await prepareStockReservationBatch(
        db,
        entries.map((entry) => ({
            variantId: entry.variantId,
            quantity: entry.quantity,
            orderId: entry.orderId,
        })),
        payload.orderData.inventoryPool as ReservationPool,
        {
            reservationKey: CHECKOUT_RESERVATION_KEY,
            freshOrderIds: freshOrder
                ? new Set([payload.orderData.id])
                : undefined,
            variantStates,
        },
    );

    if (!result.success) {
        const itemIssues = buildReservationItemIssues(payload, result.results);
        throw new ValidationError("Some items in your cart need attention.", {
            itemIssues: itemIssues.length > 0
                ? itemIssues
                : [{
                    index: 0,
                    productId: "",
                    variantId: null,
                    code: "QUANTITY_UNAVAILABLE",
                    action: "remove",
                    message: "One or more items are no longer available in the requested quantity.",
                    productName: null,
                    variantLabel: null,
                    requestedQuantity: 0,
                }],
            inventoryError: result.error,
        });
    }

    return result;
}

function buildOrderWriteBatch(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    customer: ResolvedOrderCustomer,
    appliedPromotion: AppliedPromotion | null,
): SQLiteBatchItem[] {
    const od = payload.orderData;
    const writes: SQLiteBatchItem[] = [];

    if (customer.createProfile) {
        writes.push(
            db.insert(customers).values({
                id: customer.id,
                name: od.customerName,
                email: od.customerEmail,
                phone: od.customerPhone,
                address: od.shippingAddress,
                city: od.city,
                zone: od.zone,
                area: od.area,
                cityName: od.cityName,
                zoneName: od.zoneName,
                areaName: od.areaName,
                totalOrders: 1,
                lastOrderAt: sql`unixepoch()`,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }),
        );
        writes.push(
            db.insert(customerHistory).values({
                id: "hist_" + nanoid(),
                customerId: customer.id,
                name: od.customerName,
                email: od.customerEmail,
                phone: od.customerPhone,
                address: od.shippingAddress,
                city: od.city,
                zone: od.zone,
                area: od.area,
                cityName: od.cityName,
                zoneName: od.zoneName,
                areaName: od.areaName,
                changeType: "created",
                actor: "buyer",
                createdAt: sql`unixepoch()`,
            }),
        );
    } else {
        // Counters only: the order's contact never rewrites the customer.
        writes.push(
            db
            .update(customers)
            .set({
                totalOrders: sql`${customers.totalOrders} + 1`,
                lastOrderAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(customers.id, customer.id)),
        );
        if (customer.linkedBy && customer.accountOwnerCustomerId) {
            writes.push(linkedOrderHistory(db, {
                accountId: customer.accountOwnerCustomerId,
                orderId: od.id,
                via: customer.linkedBy,
            }) as SQLiteBatchItem);
        }
    }

    writes.push(
        db.insert(orders).values({
            orderNumber: nextOrderNumberSql(),
            id: od.id,
            customerName: od.customerName,
            customerPhone: od.customerPhone,
            customerEmail: od.customerEmail,
            shippingAddress: od.shippingAddress,
            city: od.city,
            zone: od.zone,
            area: od.area,
            cityName: od.cityName,
            zoneName: od.zoneName,
            areaName: od.areaName,
            notes: od.notes,
            currencyCode: od.currencyCode,
            currencyDecimalPlaces: od.currencyDecimalPlaces,
            subtotalAmountMinor: od.subtotalAmountMinor,
            shippingAmountMinor: od.shippingAmountMinor,
            shippingMethodId: od.shippingMethodId,
            shippingMethodName: od.shippingMethodName,
            shippingMethodDescription: od.shippingMethodDescription,
            shippingMethodBaseAmountMinor: od.shippingMethodBaseAmountMinor,
            shippingFeeWaived: od.shippingFeeWaived,
            // Pre-Wave A payloads (a prepared payload in flight) carry an
            // address and ship; the orders trigger re-checks the address.
            requiresShipping: od.requiresShipping ?? true,
            shippingMethodKind: od.shippingMethodKind ?? null,
            pickupAddress: od.pickupAddress ?? null,
            pickupHours: od.pickupHours ?? null,
            discountAmountMinor: od.discountAmountMinor,
            taxAmountMinor: od.taxAmountMinor,
            totalAmountMinor: od.totalAmountMinor,
            taxLabel: od.taxLabel,
            pricesIncludeTax: od.pricesIncludeTax,
            status: od.status,
            paymentMethod: od.paymentMethod,
            paymentStatus: od.paymentStatus,
            paidAmountMinor: od.paidAmountMinor,
            balanceDueMinor: od.balanceDueMinor,
            fulfillmentStatus: od.fulfillmentStatus,
            inventoryPool: od.inventoryPool,
            inventoryAction: od.inventoryAction,
            customerId: customer.id,
            accountOwnerCustomerId: customer.accountOwnerCustomerId,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
    );

    if (od.paymentMethod === "cod") {
        writes.push(
            db.insert(codTracking).values(createCODTrackingInsertValues(od.id)),
        );
    }

    if (payload.items.length > 0) {
        const itemRows = payload.items.map((item) => ({
            id: item.id,
            orderId: od.id,
            productId: item.productId,
            variantId: item.variantId,
            productImageMediaId: item.productImageMediaId,
            quantity: item.quantity,
            productName: item.productName,
            variantLabel: item.variantLabel,
            inventoryTracked: item.variantId !== null && item.inventoryTracked !== false,
            unitPriceMinor: item.unitPriceMinor,
            lineSubtotalMinor: item.lineSubtotalMinor,
            discountAmountMinor: item.discountAmountMinor,
            taxableAmountMinor: item.taxableAmountMinor,
            taxAmountMinor: item.taxAmountMinor,
            // Constant columns are SQL literals, not bound values: a
            // multi-row insert binds every defaulted column otherwise, and
            // 18 bound values a row keep 5 rows a statement (D1 allows 100).
            // The ledger alone moves fulfilled_quantity afterwards.
            fulfilledQuantity: sql`0`,
            fulfillmentType: item.fulfillmentType ?? "ship",
            properties: item.properties ?? null,
            propertiesPriceMinor: item.propertiesPriceMinor ?? 0,
            baseUnitPriceMinor: item.baseUnitPriceMinor
                ?? item.unitPriceMinor - (item.propertiesPriceMinor ?? 0),
            createdAt: sql`unixepoch()`,
        }));
        for (const chunk of chunkRowsForD1(
            itemRows,
            ORDER_ITEM_INSERT_PARAMETERS_PER_ROW,
        )) {
            writes.push(db.insert(orderItems).values(chunk));
        }

        const taxRows = payload.items.map((item) => {
            const line = payload.taxQuote.lines.find(
                (candidate) => candidate.lineId === item.taxAllocationLineId,
            );
            if (!line) {
                throw new ValidationError("Committed tax allocation is missing an order line.");
            }
            return {
                orderItemId: item.id,
                orderId: od.id,
                taxClassId: line.taxClassId,
                taxClassName: line.taxClassName,
                pricesIncludeTax: payload.taxQuote.pricesIncludeTax,
                rateSnapshot: JSON.stringify(line.components),
                createdAt: sql`unixepoch()`,
            };
        });
        for (const chunk of chunkRowsForD1(
            taxRows,
            ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW,
        )) {
            writes.push(db.insert(orderItemTaxSnapshots).values(chunk));
        }
    }

    writes.push(db.insert(orderTaxSnapshots).values({
        orderId: od.id,
        currencyCode: payload.taxQuote.currencyCode,
        decimalPlaces: payload.taxQuote.decimalPlaces,
        displayLabel: payload.taxQuote.displayLabel,
        pricesIncludeTax: payload.taxQuote.pricesIncludeTax,
        shippingTaxed: payload.taxQuote.shippingTaxed,
        settingsVersion: payload.taxQuote.settingsVersion,
        calculationVersion: payload.taxQuote.calculationVersion,
        destinationSnapshot: JSON.stringify(payload.taxQuote.destination),
        rateSnapshot: JSON.stringify({
            lines: payload.taxQuote.lines.map((line) => ({
                lineId: line.lineId,
                taxClassId: line.taxClassId,
                taxClassName: line.taxClassName,
                components: line.components,
            })),
            shipping: payload.taxQuote.shipping,
        }),
        createdAt: sql`unixepoch()`,
    }));

    if (wantsOrderCreatedNotification(payload)) {
        writes.push(
            db.insert(notificationOutbox).values(createOrderNotificationOutboxInsertValues({
                dedupeKey: buildOrderCreatedNotificationDedupeKey(od.id),
                orderId: od.id,
                customerEmail: od.customerEmail ?? undefined,
                customerName: od.customerName,
                notificationType: "order_created",
                source: "storefront-order",
            })),
        );
    }

    // An order is priced by its promotion or by its quantity bundles, never
    // both (checkout/bundle-discounts.ts): its line discounts must stay equal
    // to its promotion allocations, which refunds and receipts reconcile. The
    // checkout authority revision fences the tiers bundles were priced from.
    let bundleDiscountTotal = 0;
    for (const item of payload.items) {
        const amount = item.bundleDiscountMinor ?? 0;
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > item.discountAmountMinor) {
            throw new ValidationError("Committed bundle discount is invalid.");
        }
        bundleDiscountTotal += amount;
    }
    if (appliedPromotion && bundleDiscountTotal > 0) {
        throw new ValidationError("Committed discounts combine a promotion with bundle pricing.");
    }

    if (appliedPromotion) {
        if (appliedPromotion.discounts.some(({ method, promotionCode }) => (method === "code") !== Boolean(promotionCode))) {
            throw new ValidationError("Committed promotion authority is invalid.");
        }
        const allocationTotal = appliedPromotion.allocations.reduce(
            (total, allocation) => total + allocation.discountAmountMinor,
            0,
        );
        if (
            allocationTotal !== appliedPromotion.totalDiscountMinor
            || allocationTotal !== od.discountAmountMinor
            || allocationTotal !== payload.taxQuote.discountMinor
        ) {
            throw new ValidationError("Committed promotion allocation does not match the order total.");
        }
        const itemByAllocationLineId = new Map(payload.items.map((item) => [
            item.taxAllocationLineId,
            item,
        ]));
        const lineDiscounts = new Map<string, number>();
        let shippingDiscountMinor = 0;
        for (const allocation of appliedPromotion.allocations) {
            if (allocation.target === "shipping") {
                shippingDiscountMinor += allocation.discountAmountMinor;
                continue;
            }
            if (!allocation.lineId || !itemByAllocationLineId.has(allocation.lineId)) {
                throw new ValidationError("Committed promotion allocation references an unknown order line.");
            }
            lineDiscounts.set(
                allocation.lineId,
                (lineDiscounts.get(allocation.lineId) ?? 0) + allocation.discountAmountMinor,
            );
        }
        for (const line of payload.taxQuote.lines) {
            if ((lineDiscounts.get(line.lineId) ?? 0) !== line.discountMinor) {
                throw new ValidationError("Promotion and tax line allocations do not match.");
            }
        }
        if (shippingDiscountMinor !== payload.taxQuote.shipping.discountMinor) {
            throw new ValidationError("Promotion and shipping tax allocations do not match.");
        }

        const allocationRows = appliedPromotion.allocations.map((allocation) => {
            const item = allocation.lineId
                ? itemByAllocationLineId.get(allocation.lineId) ?? null
                : null;
            return {
                id: `oda_${nanoid()}`,
                orderId: od.id,
                orderItemId: item?.id ?? null,
                promotionId: allocation.promotionId,
                effectId: allocation.effectId,
                promotionRevision: allocation.promotionRevision,
                evaluatorVersion: allocation.evaluatorVersion,
                method: allocation.method,
                promotionName: allocation.promotionName,
                promotionCode: allocation.promotionCode,
                effectKind: allocation.effectKind,
                target: allocation.target,
                currencyCode: allocation.currencyCode,
                baseAmountMinor: allocation.baseAmountMinor,
                discountAmountMinor: allocation.discountAmountMinor,
                quantity: item?.quantity ?? null,
                createdAt: sql`unixepoch()`,
            };
        });
        for (const chunk of chunkRowsForD1(
            allocationRows,
            ORDER_DISCOUNT_ALLOCATION_INSERT_PARAMETERS_PER_ROW,
        )) {
            writes.push(db.insert(orderDiscountAllocations).values(chunk));
        }
        // The immutable allocations precede the claim so the D1 claim trigger
        // can prove their exact sum and identity in this same atomic batch.
        // Only the (single) code discount carries usage limits and a claim;
        // automatic allocations still fail on a concurrent rule edit (revision).
        for (const discount of appliedPromotion.discounts) {
            if (!discount.promotionCode) continue;
            writes.push(db.insert(promotionRedemptions).values({
                id: `pred_${nanoid()}`,
                promotionId: discount.promotionId,
                orderId: od.id,
                customerId: customer.id,
                promotionRevision: discount.promotionRevision,
                promotionCode: discount.promotionCode,
                currencyCode: od.currencyCode,
                discountAmountMinor: discount.totalDiscountMinor,
                createdAt: sql`unixepoch()`,
            }));
        }
    }

    if (
        payload.checkoutSideEffects?.metaPurchase !== false
        && isStorefrontOrderPayloadEligibleForMetaPurchase(payload, customer.id)
    ) {
        writes.push(buildMetaPurchaseOutboxClaimInsert(db, {
            orderId: od.id,
            source: "storefront-order",
        }));
    }

    return writes;
}

/**
 * The checkout authority snapshot proves whether any order-created channel or
 * Meta integration is configured; its revision fence rejects the commit if
 * that changes before the batch runs, so skipped outbox rows are never lost.
 */
export function wantsOrderCreatedNotification(payload: StorefrontOrderCommitPayload): boolean {
    return payload.checkoutSideEffects?.orderCreatedNotification !== false
        && shouldCreateOrderCreatedNotification(payload.orderData);
}

function isStorefrontOrderPayloadEligibleForMetaPurchase(
    payload: StorefrontOrderCommitPayload,
    customerId: string | null,
): boolean {
    const od = payload.orderData;
    return isOrderEligibleForMetaPurchase({
        id: od.id,
        customerId,
        customerName: od.customerName,
        customerPhone: od.customerPhone,
        customerEmail: od.customerEmail,
        city: od.city,
        cityName: od.cityName,
        currencyCode: od.currencyCode,
        currencyDecimalPlaces: od.currencyDecimalPlaces,
        totalAmountMinor: od.totalAmountMinor,
        status: od.status,
        paymentMethod: od.paymentMethod,
        paymentStatus: od.paymentStatus,
        paidAmountMinor: od.paidAmountMinor,
        deletedAt: null,
    });
}

export async function commitStorefrontOrderPayload(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    checkoutCommit?: StorefrontOrderCheckoutCommit,
    prefetchedReads?: StorefrontOrderCommitReads,
): Promise<StorefrontOrderCommitResult> {
    if (payload.items.length > MAX_ORDER_LINE_ITEMS) {
        throw new ValidationError(
            `Checkout supports at most ${MAX_ORDER_LINE_ITEMS} line items.`,
        );
    }
    if (
        checkoutCommit
        && (
            checkoutCommit.attempt.orderId !== payload.orderData.id
            || checkoutCommit.attempt.checkoutToken !== payload.checkoutToken
        )
    ) {
        throw new ValidationError("Checkout attempt identity does not match the prepared order.");
    }

    let guestProfileRaceRetried = false;
    let inventoryConflictCount = 0;
    // Prefetched rows serve the first attempt only; a retry re-reads.
    let reads = prefetchedReads;

    while (true) {
        // A brand-new atomic candidate cannot already own an order. Retried
        // legacy identities retain the read so an uncertain historical commit
        // can still converge without creating a duplicate.
        const existing = checkoutCommit?.attempt.origin === "new"
            ? undefined
            : await loadExistingCommittedOrder(db, payload.orderData.id);
        if (existing) {
            await finalizeCheckoutAttemptForExistingOrder(db, payload, checkoutCommit);
            return {
                orderId: existing.id,
                customerId: existing.customerId,
                accountOwnerCustomerId: existing.accountOwnerCustomerId,
                alreadyCommitted: true,
                availabilityTransitionVariantIds: [],
            };
        }

        if (
            !Number.isSafeInteger(payload.checkoutAuthorityRevision)
            || (payload.checkoutAuthorityRevision ?? 0) < 1
        ) {
            throw new ValidationError("Checkout authority revision is unavailable. Please retry checkout.");
        }
        const authorityGuard = buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${checkoutAuthority}
            WHERE ${checkoutAuthority.id} = 'default'
              AND ${checkoutAuthority.revision} = ${payload.checkoutAuthorityRevision}
        )`, CHECKOUT_AUTHORITY_CHANGED);

        const [customer, inventoryPlan] = await Promise.all([
            resolveCustomerForOrder(db, payload, reads),
            prepareOrderInventory(
                db,
                payload,
                checkoutCommit?.attempt.origin === "new",
                reads?.variantStates,
            ),
        ]);
        reads = undefined;
        const appliedPromotion = payload.promotion
            ? await verifyPromotionCheckoutSnapshot(db, payload.promotion, customer.id)
            : null;

        const checkoutAttemptPlan = checkoutCommit
            ? await prepareAtomicCheckoutAttemptCommit(db, checkoutCommit.attempt, {
                paymentMethod: payload.orderData.paymentMethod,
                totalAmountMinor: payload.orderData.totalAmountMinor,
                response: checkoutCommit.response,
            })
            : null;
        const agentContextPlan = checkoutCommit?.agentContext
            ? prepareAgentStorefrontCheckoutCommit(db, payload, checkoutCommit.agentContext)
            : null;
        const orderWrites = buildOrderWriteBatch(db, payload, customer, appliedPromotion);
        const writesBeforeInventory: SQLiteBatchItem[] = [
            authorityGuard,
            ...(checkoutAttemptPlan?.writesBeforeOrder ?? []),
            ...(agentContextPlan?.writesBeforeOrder ?? []),
        ];
        const atomicWrites: SQLiteBatchItem[] = [
            ...writesBeforeInventory,
            ...inventoryPlan.statements,
            ...orderWrites,
            ...(checkoutAttemptPlan?.writesAfterOrder ?? []),
            ...(agentContextPlan?.writesAfterOrder ?? []),
        ];
        let batchResults: readonly unknown[];
        try {
            batchResults = await safeBatch(db, atomicWrites) as readonly unknown[];
        } catch (error) {
            const committedAfterError = await loadExistingCommittedOrder(db, payload.orderData.id)
                .catch(() => undefined);
            if (committedAfterError) {
                return {
                    orderId: committedAfterError.id,
                    customerId: committedAfterError.customerId,
                    accountOwnerCustomerId: committedAfterError.accountOwnerCustomerId,
                    alreadyCommitted: true,
                    availabilityTransitionVariantIds: [],
                };
            }

            const guardError = checkoutGuardError(error);
            if (guardError) throw guardError;

            const discountConstraintError = getPromotionRedemptionConstraintError(error);
            if (discountConstraintError) throw discountConstraintError;

            if (
                !guestProfileRaceRetried
                && customer.createProfile
                && isCustomerPhoneConstraintError(error)
            ) {
                guestProfileRaceRetried = true;
                continue;
            }

            if (checkoutAttemptPlan && isCheckoutAttemptCommitConflictError(error)) {
                throw new ConflictError("Checkout attempt changed before the order could be committed. Please retry.");
            }

            const idempotentReservation = await inventoryPlan.resolveIdempotentReplay(error);
            if (idempotentReservation?.success) {
                try {
                    await safeBatch(db, [
                        authorityGuard,
                        ...(checkoutAttemptPlan?.writesBeforeOrder ?? []),
                        ...(agentContextPlan?.writesBeforeOrder ?? []),
                        ...orderWrites,
                        ...(checkoutAttemptPlan?.writesAfterOrder ?? []),
                        ...(agentContextPlan?.writesAfterOrder ?? []),
                    ] as SQLiteBatchItem[]);
                } catch (replayError) {
                    throw checkoutGuardError(replayError)
                        ?? getPromotionRedemptionConstraintError(replayError)
                        ?? replayError;
                }
                return {
                    orderId: payload.orderData.id,
                    customerId: customer.id,
                    accountOwnerCustomerId: customer.accountOwnerCustomerId,
                    alreadyCommitted: false,
                    // The reservation committed in an earlier request whose
                    // band outcome is unknown here; invalidate conservatively.
                    availabilityTransitionVariantIds: getReservationEntries(payload)
                        .map((entry) => entry.variantId),
                };
            }
            if (idempotentReservation?.manualReconciliationRequired) {
                throw new ServiceUnavailableError(
                    "Checkout inventory state needs reconciliation before this order can be retried.",
                );
            }

            if (isInventoryReservationConflictError(error)) {
                inventoryConflictCount += 1;
                if (inventoryConflictCount < INVENTORY_COMMIT_MAX_CONFLICTS) {
                    await new Promise((resolve) => setTimeout(
                        resolve,
                        INVENTORY_COMMIT_BASE_BACKOFF_MS * Math.pow(2, inventoryConflictCount - 1),
                    ));
                    continue;
                }
                throw new ServiceUnavailableError(
                    "Inventory is changing quickly. Please retry checkout.",
                );
            }

            throw error;
        }

        return {
            orderId: payload.orderData.id,
            customerId: customer.id,
            accountOwnerCustomerId: customer.accountOwnerCustomerId,
            alreadyCommitted: false,
            availabilityTransitionVariantIds: inventoryPlan.availabilityTransitions(
                batchResults.slice(
                    writesBeforeInventory.length,
                    writesBeforeInventory.length + inventoryPlan.statements.length,
                ),
            ),
        };
    }
}

function prepareAgentStorefrontCheckoutCommit(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    context: NonNullable<StorefrontOrderCheckoutCommit["agentContext"]>,
): { writesBeforeOrder: SQLiteBatchItem[]; writesAfterOrder: SQLiteBatchItem[] } {
    if (!Number.isInteger(context.expectedRevision) || context.expectedRevision < 1) {
        throw new ValidationError("Storefront context revision is invalid.");
    }
    const activeContext = and(
        eq(agentStorefrontContexts.id, context.contextId),
        eq(agentStorefrontContexts.grantId, context.grantId),
        eq(agentStorefrontContexts.status, "active"),
        isNull(agentStorefrontContexts.closedAt),
        eq(agentStorefrontContexts.revision, context.expectedRevision),
        sql`${agentStorefrontContexts.expiresAt} > unixepoch()`,
    );
    const guard = buildBatchGuard(
        db,
        sql`EXISTS (SELECT 1 FROM ${agentStorefrontContexts} WHERE ${activeContext})`,
        AGENT_CONTEXT_CHECKOUT_CONFLICT,
    ) as SQLiteBatchItem;
    const contextWrite = db
        .update(agentStorefrontContexts)
        .set({
            revision: sql`${agentStorefrontContexts.revision} + 1`,
            cartJson: "[]",
            discountCode: null,
            lastUsedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(activeContext) as SQLiteBatchItem;
    const orderGrantWrite = db
        .insert(agentStorefrontOrderGrants)
        .values({
            contextId: context.contextId,
            orderId: payload.orderData.id,
            authorityKind: "created",
            expiresAt: context.expiresAt,
            createdAt: sql`unixepoch()`,
        })
        .onConflictDoNothing() as SQLiteBatchItem;
    const continuationWrite = context.continuation
        ? db.insert(agentStorefrontContinuations).values({
            id: context.continuation.id,
            contextId: context.contextId,
            kind: context.continuation.kind,
            orderId: payload.orderData.id,
            status: "pending",
            expiresAt: context.continuation.expiresAt,
            bootstrapCodeHash: context.continuation.bootstrapCodeHash,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).onConflictDoNothing() as SQLiteBatchItem
        : null;
    return {
        writesBeforeOrder: [guard],
        writesAfterOrder: [
            contextWrite,
            orderGrantWrite,
            ...(continuationWrite ? [continuationWrite] : []),
        ],
    };
}

async function finalizeCheckoutAttemptForExistingOrder(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    checkoutCommit: StorefrontOrderCheckoutCommit | undefined,
): Promise<void> {
    if (!checkoutCommit) return;

    const plan = await prepareAtomicCheckoutAttemptCommit(db, checkoutCommit.attempt, {
        paymentMethod: payload.orderData.paymentMethod,
        totalAmountMinor: payload.orderData.totalAmountMinor,
        response: checkoutCommit.response,
    });
    try {
        await safeBatch(db, [
            ...plan.writesBeforeOrder,
            ...plan.writesAfterOrder,
        ] as SQLiteBatchItem[]);
    } catch (error) {
        // A committed matching attempt is already durable after an uncertain
        // response; a different winner owns the replay payload.
        if (isCheckoutAttemptCommitConflictError(error)) {
            return;
        }
        throw error;
    }
}
