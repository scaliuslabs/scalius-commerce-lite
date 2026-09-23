// src/modules/orders/orders.ingest.ts
// Synchronous storefront order commit path used by checkout-facing APIs.

import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    agentStorefrontContexts,
    agentStorefrontContinuations,
    agentStorefrontOrderGrants,
    checkoutAuthority,
    customers,
    customerHistory,
    discounts,
    discountCustomerRedemptions,
    discountUsage,
    orderItems,
    orderDiscountAllocations,
    orderItemTaxSnapshots,
    orderNotificationOutbox,
    orderTaxSnapshots,
    orders,
    codTracking,
    promotionRedemptions,
} from "@scalius/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import { ConflictError, ServiceUnavailableError, ValidationError } from "../../errors";
import {
    isInventoryReservationConflictError,
    prepareStockReservationBatch,
    selectReservationVariantStates,
    type PreparedStockReservationBatch,
    type ReservationVariantState,
} from "../inventory";
import {
    buildMetaPurchaseOutboxClaimInsert,
    isOrderEligibleForMetaPurchase,
    processExistingMetaPurchaseOutboxForOrder,
} from "../../integrations/meta/purchase-outbox";
import { createCODTrackingInsertValues } from "../payments/cod";
import {
    buildOrderCreatedNotificationDedupeKey,
    createOrderNotificationOutboxInsertValues,
    recordAndEnqueueOrderNotification,
    type OrderNotificationQueue,
} from "../notifications/order-notification-outbox";
import { getDiscountUsageConstraintError } from "./discount-usage-constraints";
import { shouldCreateOrderCreatedNotification } from "./order-created-notification-policy";
import type { StorefrontOrderCommitPayload } from "./orders.types";
import type { StorefrontCartItemIssue } from "./cart-validation";
import {
    getPromotionRedemptionConstraintError,
    verifyPromotionCheckoutSnapshot,
    type AppliedPromotion,
} from "../promotions";
import {
    prepareAtomicCheckoutAttemptCommit,
    isCheckoutAttemptCommitConflictError,
    resolveCheckoutAttemptRow,
    selectCheckoutAttemptByKey,
    type AtomicCheckoutAttempt,
    type CheckoutAttemptIdentity,
    type CheckoutAttemptRow,
    type ExistingCheckoutAttemptResult,
} from "./checkout-attempts";
import {
    createStorefrontCheckoutAuthorityReadPlan,
    type StorefrontCheckoutAuthorityInput,
    type StorefrontCheckoutAuthoritySnapshot,
} from "./checkout-authority";
import { chunkRowsForD1 } from "./d1-write-chunks";
import { MAX_ORDER_LINE_ITEMS } from "./orders.validation";

type ReservationPool = "regular" | "preorder" | "backorder";
type SQLiteBatchItem = BatchItem<"sqlite">;

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
const ORDER_ITEM_INSERT_PARAMETERS_PER_ROW = 18;
const ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW = 13;
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
            || message.includes("customers.phone")
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

interface OrderCustomerRow {
    id: string;
    accountClaimedAt: Date | null;
    deletedAt: Date | null;
}

interface ResolvedOrderCustomer extends OrderCustomerRow {
    accountOwnerCustomerId: string | null;
    createProfile: boolean;
    updateGuestProfile: boolean;
}

async function loadActiveCustomerById(db: Database, id: string): Promise<OrderCustomerRow | undefined> {
    return db
        .select({
            id: customers.id,
            accountClaimedAt: customers.accountClaimedAt,
            deletedAt: customers.deletedAt,
        })
        .from(customers)
        .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
        .get();
}

function selectCustomerByPhone(db: Database, phone: string) {
    return db
        .select({
            id: customers.id,
            accountClaimedAt: customers.accountClaimedAt,
            deletedAt: customers.deletedAt,
        })
        .from(customers)
        .where(eq(customers.phone, phone));
}

/**
 * Rows the commit would otherwise read one by one, fetched in the checkout's
 * single read batch. Everything stays re-guarded inside the commit batch.
 */
export interface StorefrontOrderCommitReads {
    customerPhone: string;
    customerByPhone: OrderCustomerRow | undefined;
    variantStates: ReservationVariantState[];
}

type SettledAuthority =
    | { ok: true; snapshot: StorefrontCheckoutAuthoritySnapshot }
    | { ok: false; error: unknown };

function tagCheckoutError(error: unknown, code: string): unknown {
    if (error instanceof Error && !("code" in error)) {
        Object.defineProperty(error, "code", { configurable: true, enumerable: false, value: code });
    }
    return error;
}

/**
 * One read round trip for a storefront checkout: the idempotency row, the
 * checkout authority snapshot, and the rows the commit needs. The attempt is
 * decided first so a committed request replays even if authority changed.
 */
export async function loadStorefrontCheckoutReads<TResponse>(
    db: Database,
    identity: CheckoutAttemptIdentity,
    authorityInput: StorefrontCheckoutAuthorityInput & { customerPhone: string },
    credentialEncryptionKey?: string,
): Promise<{
    existingAttempt: ExistingCheckoutAttemptResult<TResponse> | null;
    commitReads: StorefrontOrderCommitReads;
    authority(): StorefrontCheckoutAuthoritySnapshot;
}> {
    const plan = createStorefrontCheckoutAuthorityReadPlan(db, authorityInput);
    const variantIds = [...new Set(authorityInput.items
        .map((item) => item.variantId)
        .filter((variantId): variantId is string => typeof variantId === "string" && variantId.length > 0))];
    const statements = [
        ...plan.statements,
        selectCheckoutAttemptByKey(db, identity.requestKey),
        selectCustomerByPhone(db, authorityInput.customerPhone),
        selectReservationVariantStates(db, variantIds),
    ];
    let results: unknown[];
    try {
        results = await safeBatch(db, statements as SQLiteBatchItem[]) as unknown[];
    } catch (error) {
        throw tagCheckoutError(error, "CHECKOUT_AUTHORITY_BATCH");
    }
    const [attemptRows, customerRows, variantRows] = results.slice(plan.statements.length) as [
        CheckoutAttemptRow[],
        OrderCustomerRow[],
        ReservationVariantState[],
    ];
    const existingAttempt = resolveCheckoutAttemptRow<TResponse>(attemptRows[0], identity);
    const settled: SettledAuthority = existingAttempt?.status === "replay"
        ? { ok: false, error: new Error("Replayed checkout does not resolve authority.") }
        : await plan.resolve(results.slice(0, plan.statements.length), credentialEncryptionKey)
            .then((snapshot): SettledAuthority => ({ ok: true, snapshot }))
            .catch((error: unknown): SettledAuthority => ({
                ok: false,
                error: tagCheckoutError(error, "CHECKOUT_AUTHORITY_RESOLVE"),
            }));
    return {
        existingAttempt,
        commitReads: {
            customerPhone: authorityInput.customerPhone,
            customerByPhone: customerRows[0],
            variantStates: variantRows,
        },
        authority() {
            if (!settled.ok) throw settled.error;
            return settled.snapshot;
        },
    };
}

async function resolveCustomerForOrder(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    reads?: StorefrontOrderCommitReads,
): Promise<ResolvedOrderCustomer> {
    if (payload.existingCustomer?.id) {
        const authenticatedCustomer = await loadActiveCustomerById(db, payload.existingCustomer.id);
        if (!authenticatedCustomer?.accountClaimedAt) {
            throw new ValidationError("Customer account is no longer active. Please sign in again.");
        }
        return {
            ...authenticatedCustomer,
            accountOwnerCustomerId: authenticatedCustomer.id,
            createProfile: false,
            updateGuestProfile: false,
        };
    }

    const existingProfile = reads?.customerPhone === payload.orderData.customerPhone
        ? reads.customerByPhone
        : await selectCustomerByPhone(db, payload.orderData.customerPhone).get();
    if (existingProfile) {
        return {
            ...existingProfile,
            accountOwnerCustomerId: null,
            createProfile: false,
            updateGuestProfile: existingProfile.accountClaimedAt === null,
        };
    }

    return {
        id: "cust_" + nanoid(),
        accountClaimedAt: null,
        deletedAt: null,
        accountOwnerCustomerId: null,
        createProfile: true,
        updateGuestProfile: false,
    };
}

function getCustomerSpendContributionForCommittedOrder(
    order: StorefrontOrderCommitPayload["orderData"],
): number {
    if (
        ["cancelled", "refunded", "returned", "partially_refunded"].includes(order.status)
        || ["failed", "refunded"].includes(order.paymentStatus)
    ) {
        return 0;
    }
    return Math.max(0, order.paidAmount);
}

async function assertDiscountUsageStillAvailable(
    db: Database,
    payload: StorefrontOrderCommitPayload,
): Promise<void> {
    if (!payload.discountUsage) return;

    const { discountId } = payload.discountUsage;
    const customerPhone = payload.orderData.customerPhone;
    const discount = await db
        .select({
            maxUses: discounts.maxUses,
            limitOnePerCustomer: discounts.limitOnePerCustomer,
        })
        .from(discounts)
        .where(eq(discounts.id, discountId))
        .get();

    if (discount?.limitOnePerCustomer && customerPhone) {
        const customerKeys = [
            `phone:${customerPhone.trim()}`,
            ...(payload.existingCustomer?.id
                ? [`customer:${payload.existingCustomer.id}`]
                : []),
        ];
        const customerUsage = await db
            .select({ orderId: discountCustomerRedemptions.orderId })
            .from(discountCustomerRedemptions)
            .where(
                and(
                    eq(discountCustomerRedemptions.discountId, discountId),
                    inArray(discountCustomerRedemptions.customerKey, customerKeys),
                ),
            )
            .limit(1)
            .get();

        if (customerUsage) {
            throw new ValidationError("Discount already used by this customer");
        }
    }

    if (discount?.maxUses) {
        const totalUsage = await db
            .select({ count: sql<number>`COUNT(*)` })
            .from(discountUsage)
            .where(eq(discountUsage.discountId, discountId))
            .get();

        if ((totalUsage?.count ?? 0) >= discount.maxUses) {
            throw new ValidationError("Discount code has reached its usage limit");
        }
    }
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
    const customerSpendContribution = getCustomerSpendContributionForCommittedOrder(od);

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
                totalSpent: customerSpendContribution,
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
                createdAt: sql`unixepoch()`,
            }),
        );
    } else {
        const guestProfileUpdates = customer.updateGuestProfile
            ? {
                name: od.customerName,
                ...(od.customerEmail ? { email: od.customerEmail } : {}),
                address: od.shippingAddress,
                city: od.city,
                zone: od.zone,
                area: od.area,
                cityName: od.cityName,
                zoneName: od.zoneName,
                areaName: od.areaName,
            }
            : {};
        writes.push(
            db
            .update(customers)
            .set({
                ...guestProfileUpdates,
                totalOrders: sql`${customers.totalOrders} + 1`,
                totalSpent: sql`${customers.totalSpent} + ${customerSpendContribution}`,
                lastOrderAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
                deletedAt: null,
            })
            .where(eq(customers.id, customer.id)),
        );
        if (customer.updateGuestProfile) {
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
                    changeType: "updated",
                    createdAt: sql`unixepoch()`,
                }),
            );
        }
    }

    writes.push(
        db.insert(orders).values({
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
            totalAmount: od.totalAmount,
            shippingCharge: od.shippingCharge,
            discountAmount: od.discountAmount,
            currencyCode: od.currencyCode,
            currencyDecimalPlaces: od.currencyDecimalPlaces,
            subtotalAmountMinor: od.subtotalAmountMinor,
            shippingAmountMinor: od.shippingAmountMinor,
            shippingMethodId: od.shippingMethodId,
            shippingMethodName: od.shippingMethodName,
            shippingMethodDescription: od.shippingMethodDescription,
            shippingMethodBaseAmountMinor: od.shippingMethodBaseAmountMinor,
            shippingFeeWaived: od.shippingFeeWaived,
            discountAmountMinor: od.discountAmountMinor,
            taxAmountMinor: od.taxAmountMinor,
            totalAmountMinor: od.totalAmountMinor,
            taxLabel: od.taxLabel,
            pricesIncludeTax: od.pricesIncludeTax,
            status: od.status,
            paymentMethod: od.paymentMethod,
            paymentStatus: od.paymentStatus,
            paidAmount: od.paidAmount,
            balanceDue: od.balanceDue,
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
            price: item.price,
            productName: item.productName,
            variantLabel: item.variantLabel,
            inventoryTracked: item.variantId !== null && item.inventoryTracked !== false,
            unitPriceMinor: item.unitPriceMinor,
            lineSubtotalMinor: item.lineSubtotalMinor,
            discountAmountMinor: item.discountAmountMinor,
            taxableAmountMinor: item.taxableAmountMinor,
            taxAmountMinor: item.taxAmountMinor,
            fulfillmentStatus: "pending" as const,
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
                unitPriceMinor: line.unitPriceMinor,
                quantity: line.quantity,
                grossAmountMinor: line.grossAmountMinor,
                discountMinor: line.discountMinor,
                taxableAmountMinor: line.taxableAmountMinor,
                taxMinor: line.taxMinor,
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
        subtotalMinor: payload.taxQuote.subtotalMinor,
        shippingMinor: payload.taxQuote.shippingMinor,
        discountMinor: payload.taxQuote.discountMinor,
        taxableMinor: payload.taxQuote.taxableMinor,
        taxMinor: payload.taxQuote.taxMinor,
        totalMinor: payload.taxQuote.totalMinor,
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
            db.insert(orderNotificationOutbox).values(createOrderNotificationOutboxInsertValues({
                dedupeKey: buildOrderCreatedNotificationDedupeKey(od.id),
                orderId: od.id,
                customerEmail: od.customerEmail ?? undefined,
                customerName: od.customerName,
                notificationType: "order_created",
                source: "storefront-order",
            })),
        );
    }

    if (payload.discountUsage) {
        writes.push(
            db.insert(discountUsage).values({
                id: "du_" + nanoid(),
                discountId: payload.discountUsage.discountId,
                orderId: od.id,
                customerId: customer.id,
                amountDiscounted: payload.discountUsage.amountDiscounted,
                createdAt: sql`unixepoch()`,
            }),
        );
    }

    if (appliedPromotion) {
        const promotionCode = appliedPromotion.promotionCode;
        if (appliedPromotion.method !== "code" || !promotionCode) {
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
        writes.push(db.insert(promotionRedemptions).values({
            id: `pred_${nanoid()}`,
            promotionId: appliedPromotion.promotionId,
            orderId: od.id,
            customerId: customer.id,
            promotionRevision: appliedPromotion.promotionRevision,
            promotionCode,
            currencyCode: od.currencyCode,
            discountAmountMinor: appliedPromotion.totalDiscountMinor,
            createdAt: sql`unixepoch()`,
        }));
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
function wantsOrderCreatedNotification(payload: StorefrontOrderCommitPayload): boolean {
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
        totalAmount: od.totalAmount,
        status: od.status,
        paymentMethod: od.paymentMethod,
        paymentStatus: od.paymentStatus,
        paidAmount: od.paidAmount,
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
        if (payload.discountUsage && (
            !Number.isSafeInteger(payload.discountUsage.revision)
            || payload.discountUsage.revision < 1
        )) {
            throw new ValidationError("Discount revision is unavailable. Return to your cart and apply the code again.");
        }
        const discountAuthority = payload.discountUsage ? sql`EXISTS (
            SELECT 1 FROM ${discounts}
            WHERE ${discounts.id} = ${payload.discountUsage.discountId}
              AND ${discounts.revision} = ${payload.discountUsage.revision}
              AND ${discounts.isActive} = 1
              AND ${discounts.deletedAt} IS NULL
              AND ${discounts.startDate} <= unixepoch()
              AND (${discounts.endDate} IS NULL OR ${discounts.endDate} >= unixepoch())
        )` : sql`1 = 1`;
        const authorityGuard = buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${checkoutAuthority}
            WHERE ${checkoutAuthority.id} = 'default'
              AND ${checkoutAuthority.revision} = ${payload.checkoutAuthorityRevision}
        ) AND ${discountAuthority}`, CHECKOUT_AUTHORITY_CHANGED);

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
        if (payload.discountUsage && payload.promotion) {
            throw new ValidationError("An order cannot combine legacy and typed discount authorities.");
        }
        const appliedPromotion = payload.promotion
            ? await verifyPromotionCheckoutSnapshot(db, payload.promotion, customer.id)
            : null;
        await assertDiscountUsageStillAvailable(db, payload);

        const checkoutAttemptPlan = checkoutCommit
            ? await prepareAtomicCheckoutAttemptCommit(db, checkoutCommit.attempt, {
                paymentMethod: payload.orderData.paymentMethod,
                totalAmount: payload.orderData.totalAmount,
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

            const discountConstraintError = getDiscountUsageConstraintError(error)
                ?? getPromotionRedemptionConstraintError(error);
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
                    throw checkoutGuardError(replayError) ?? replayError;
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
        totalAmount: payload.orderData.totalAmount,
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

export async function runStorefrontOrderPostCommitSideEffects(
    db: Database,
    env: StorefrontOrderCommitRuntime | undefined,
    payload: StorefrontOrderCommitPayload,
): Promise<void> {
    if (payload.checkoutSideEffects?.metaPurchase !== false) {
        await processExistingMetaPurchaseOutboxForOrder({
            db,
            orderId: payload.orderData.id,
            source: "storefront-order",
            storefrontUrl: env?.STOREFRONT_URL,
            encryptionKey: env?.CREDENTIAL_ENCRYPTION_KEY,
        }).catch((error: unknown) => {
            console.error("[orders/commit] Meta Purchase CAPI side effect failed for order", payload.orderData.id, error);
        });
    }

    if (!wantsOrderCreatedNotification(payload)) {
        return;
    }

    try {
        const notificationResult = await recordAndEnqueueOrderNotification({
            db,
            queue: env?.JOBS_QUEUE,
            notification: {
                dedupeKey: buildOrderCreatedNotificationDedupeKey(payload.orderData.id),
                orderId: payload.orderData.id,
                customerEmail: payload.orderData.customerEmail ?? undefined,
                customerName: payload.orderData.customerName,
                notificationType: "order_created",
                source: "storefront-order",
            },
        });
        if (!notificationResult.enqueued) {
            console.warn(
                `[orders/commit] order_created notification for ${payload.orderData.id} recorded but not enqueued: ${notificationResult.skippedReason}`,
            );
        }
    } catch (error) {
        console.error(`[orders/commit] Failed order_created notification side effect for ${payload.orderData.id}:`, error);
    }
}
