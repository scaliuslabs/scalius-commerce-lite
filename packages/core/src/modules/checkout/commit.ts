// The single storefront order commit: one guarded batch for the order, lines, stock, discounts and receipt.
import { MAX_ORDER_LINE_ITEMS, nextOrderNumberSql, type StorefrontOrderCommitPayload } from "../orders";
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
    products,
    promotionRedemptions,
    warrantyPolicies,
} from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { storedPhone } from "@scalius/shared/customer-auth-policy";
import type { OrderChannel } from "@scalius/shared/order-channel";
import { defaultOrderSalesChannelId, ONLINE_STORE_CHANNEL_ID } from "@scalius/shared/sales-channels";
import { orderMoneyChainColumns } from "@scalius/shared/money-chain";
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
import { createCODTrackingInsertValues } from "../payments";
import {
    ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW,
    orderItemTaxSnapshotColumns,
    orderTaxSnapshotColumns,
} from "../tax";
import {
  buildOrderCreatedNotificationDedupeKey,
  createOrderNotificationOutboxInsertValues,
  type NotificationSender,
} from "../notifications";
import { shouldCreateOrderCreatedNotification } from "./created-notification-policy";
import {
  chooseOrderCustomer,
  linkedOrderHistory,
  normalizeContactEmail,
  type OrderContact,
  selectContactCustomerCandidates,
  type VerifiedContact,
} from "../customers";
import type { StorefrontCartItemIssue } from "./cart-validation";
import { getPromotionRedemptionConstraintError, verifyPromotionCheckoutSnapshot } from "../promotions";
import { type AppliedPromotion } from "../promotions/browser";
import {
    prepareAtomicCheckoutAttemptCommit,
    isCheckoutAttemptCommitConflictError,
    type AtomicCheckoutAttempt,
} from "./attempts";
import { buildAppDiscountFactInserts } from "../order-kernel";
import { appStorageCommitStatements, isAppStorageCommitConflict } from "../plugins";
import { orderMarketIdSql } from "../markets";
import { orderBillingAddressInsertColumns, orderShippingAddressInsertColumns, orderShippingCountry } from "../orders";
import { readCheckoutCopy } from "./store-copy";
import type { StorefrontOrderCommitReads, SQLiteBatchItem } from "./reads";
import {
    GiftCardChangedError,
    buildGiftCardRedemptionStatements,
    isGiftCardLedgerError,
} from "../gift-cards";

type ReservationPool = "regular" | "preorder" | "backorder";

export interface StorefrontOrderCommitRuntime {
    /** Sends the order_created notification right after the commit. */
    sendNotifications?: NotificationSender;
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
// Bound values per order line (the constant columns are SQL literals, the
// warranty lookup binds the product id once more); the D1 limit is 100 per
// statement, so 5 rows a statement (95 values).
export const ORDER_ITEM_INSERT_PARAMETERS_PER_ROW = 19;
// order_item_id, order_id, tax_class_id, tax_class_name, rate_snapshot,
// tax_region_id (the order's flag, country and provider are SQL literals).
const ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW = ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW;
const ORDER_DISCOUNT_ALLOCATION_INSERT_PARAMETERS_PER_ROW = 18;
const CHECKOUT_AUTHORITY_CHANGED = "CHECKOUT_AUTHORITY_CHANGED";
/** An app's offer (its snapshot record) changed between the quote and the commit. */
export const APP_OFFER_CHANGED_REASON = "APP_OFFER_CHANGED";
const CHECKOUT_AUTHORITY_CHANGED_MESSAGE =
    "Checkout details changed while the order was being placed. Return to your cart to review them and try again.";
// Checked before the inventory classifier, whose Turso matcher treats any
// "conflict" text as a retryable write conflict.
const AGENT_CONTEXT_CHECKOUT_CONFLICT = "AGENT_STOREFRONT_CONTEXT_CHECKOUT_CONFLICT";

function checkoutGuardError(error: unknown): Error | null {
    if (isBatchGuardError(error, CHECKOUT_AUTHORITY_CHANGED)) {
        return new ValidationError(CHECKOUT_AUTHORITY_CHANGED_MESSAGE);
    }
    // A card spent, disabled or expired since the quote (the ledger guards, G2).
    if (isGiftCardLedgerError(error)) {
        return new GiftCardChangedError();
    }
    if (isBatchGuardError(error, AGENT_CONTEXT_CHECKOUT_CONFLICT)) {
        return new ConflictError(
            "This storefront context changed, closed, or expired before the order was committed. Reload it and retry.",
        );
    }
    return null;
}

/** Two guest checkouts raced to create the same phone's (or phoneless email's) guest record. */
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
    salesChannelId: string = ONLINE_STORE_CHANNEL_ID,
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
            // Units at the locations the order's channel sells from (MARKETS-DESIGN D6).
            salesChannelId,
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

/**
 * The product's warranty as bought: its policy's current revision, read in
 * the commit batch itself (no round trip) so the line freezes whatever is
 * current at commit (design §5.1). No policy or an archived one is NULL.
 * The warranty is not price-relevant, so it is outside the authority fence.
 */
function currentWarrantyRevisionSql(productId: string) {
    return sql<string | null>`(
        SELECT ${warrantyPolicies.currentRevisionId}
        FROM ${products}
        JOIN ${warrantyPolicies} ON ${warrantyPolicies.id} = ${products.warrantyPolicyId}
        WHERE ${products.id} = ${productId}
          AND ${warrantyPolicies.archivedAt} IS NULL
    )`;
}

function buildOrderWriteBatch(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    customer: ResolvedOrderCustomer,
    appliedPromotion: AppliedPromotion | null,
    channel: Extract<OrderChannel, "online_store" | "agent">,
): SQLiteBatchItem[] {
    const od = payload.orderData;
    const writes: SQLiteBatchItem[] = [];

    if (customer.createProfile) {
        writes.push(
            db.insert(customers).values({
                id: customer.id,
                name: od.customerName,
                email: od.customerEmail,
                phone: storedPhone(od.customerPhone),
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
                phone: storedPhone(od.customerPhone),
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
            fulfillmentStatus: od.fulfillmentStatus,
            inventoryPool: od.inventoryPool,
            inventoryAction: od.inventoryAction,
            customerId: customer.id,
            accountOwnerCustomerId: customer.accountOwnerCustomerId,
            // Set once here; the orders trigger keeps it immutable.
            channel,
            channelSource: null,
            // The channel whose publications the order sold from (MARKETS-DESIGN
            // D6), an SQL literal like the channel: no bound value.
            salesChannelId: sql.raw(`'${defaultOrderSalesChannelId(channel)}'`),
            // The market of the shipping country, else the backup market, read
            // inside this insert (MARKETS-DESIGN D4); the authority fence covers
            // a market change between the quote and this commit.
            // An order that ships nothing is placed in its billing country, where it is taxed.
            marketId: orderMarketIdSql(orderShippingCountry(od) ?? (
                payload.taxQuote.jurisdiction?.addressSource === "billing" ? od.billingCountryCode ?? null : null
            )),
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
            warrantyRevisionId: currentWarrantyRevisionSql(item.productId),
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
                ...orderItemTaxSnapshotColumns(payload.taxQuote, line),
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
        ...orderTaxSnapshotColumns(payload.taxQuote),
        createdAt: sql`unixepoch()`,
    }));

    if (wantsOrderCreatedNotification(payload)) {
        writes.push(
            db.insert(notificationOutbox).values(createOrderNotificationOutboxInsertValues({
                dedupeKey: buildOrderCreatedNotificationDedupeKey(od.id),
                orderId: od.id,
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
    const bundleByLine = new Map<string, number>();
    for (const item of payload.items) {
        const amount = item.bundleDiscountMinor ?? 0;
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > item.discountAmountMinor) {
            throw new ValidationError("Committed bundle discount is invalid.");
        }
        bundleDiscountTotal += amount;
        bundleByLine.set(item.taxAllocationLineId, amount);
    }
    if (appliedPromotion && bundleDiscountTotal > 0) {
        throw new ValidationError("Committed discounts combine a promotion with bundle pricing.");
    }

    // App discounts sit on top of either (checkout/app-functions.ts): line
    // discount = platform part + app part, recorded as `app_discount` facts.
    const appDiscounts = payload.appDiscounts ?? [];
    const itemIdByLineId = new Map(payload.items.map((item) => [item.taxAllocationLineId, item.id]));
    const appLineDiscounts = new Map<string, number>();
    let appShippingDiscountMinor = 0;
    for (const discount of appDiscounts) {
        const lineTotal = discount.lines.reduce((total, line) => {
            if (!itemIdByLineId.has(line.lineId) || !Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) {
                throw new ValidationError("Committed app discount is invalid.");
            }
            appLineDiscounts.set(line.lineId, (appLineDiscounts.get(line.lineId) ?? 0) + line.amountMinor);
            return total + line.amountMinor;
        }, 0);
        if (
            lineTotal !== discount.amountMinor
            || !Number.isSafeInteger(discount.shippingAmountMinor)
            || discount.shippingAmountMinor < 0
            || (discount.target === "shipping") !== (discount.lines.length === 0)
            || discount.amountMinor + discount.shippingAmountMinor <= 0
        ) {
            throw new ValidationError("Committed app discount is invalid.");
        }
        appShippingDiscountMinor += discount.shippingAmountMinor;
    }
    const appDiscountTotal = [...appLineDiscounts.values()].reduce((total, amount) => total + amount, appShippingDiscountMinor);
    if (!appliedPromotion && appDiscountTotal > 0) {
        if (
            bundleDiscountTotal + appDiscountTotal !== od.discountAmountMinor
            || od.discountAmountMinor !== payload.taxQuote.discountMinor
            || appShippingDiscountMinor !== payload.taxQuote.shipping.discountMinor
            || payload.taxQuote.lines.some((line) =>
                (bundleByLine.get(line.lineId) ?? 0) + (appLineDiscounts.get(line.lineId) ?? 0) !== line.discountMinor)
        ) {
            throw new ValidationError("Committed app discounts do not match the order total.");
        }
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
            || allocationTotal + appDiscountTotal !== od.discountAmountMinor
            || allocationTotal + appDiscountTotal !== payload.taxQuote.discountMinor
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
            if ((lineDiscounts.get(line.lineId) ?? 0) + (appLineDiscounts.get(line.lineId) ?? 0) !== line.discountMinor) {
                throw new ValidationError("Promotion and tax line allocations do not match.");
            }
        }
        if (shippingDiscountMinor + appShippingDiscountMinor !== payload.taxQuote.shipping.discountMinor) {
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

    if (appDiscounts.length > 0) {
        writes.push(...buildAppDiscountFactInserts(db, {
            orderId: od.id,
            currencyCode: od.currencyCode,
            discounts: appDiscounts,
            orderItemIdByLineId: itemIdByLineId,
        }) as SQLiteBatchItem[]);
    }

    // App snapshot writes (a balance the discount spends) commit with the
    // order, each at the revision its app saw: a lost race fails the order.
    const storageCommits = payload.appStorageCommits ?? [];
    if (storageCommits.length > 0) {
        const discounted = new Set(appDiscounts.map((discount) => discount.pluginId));
        if (storageCommits.some((commit) => !discounted.has(commit.pluginId))) {
            throw new ValidationError("Committed app storage write has no applied discount.");
        }
        const { guards, writes: commitWrites } = appStorageCommitStatements(db, storageCommits);
        writes.push(...guards as SQLiteBatchItem[], ...commitWrites as SQLiteBatchItem[]);
    }

    // The gift-card hold (§4.3): after the order row, which it references.
    const redemptions = payload.giftCardRedemptions ?? [];
    if (redemptions.length > 0) {
        const redeemedMinor = redemptions.reduce((total, redemption) => total + redemption.appliedMinor, 0);
        if (redeemedMinor !== od.paidAmountMinor || od.paidAmountMinor + od.balanceDueMinor !== od.totalAmountMinor) {
            throw new ValidationError("Committed gift-card tender does not match the order payment state.");
        }
        writes.push(...buildGiftCardRedemptionStatements(db, {
            orderId: od.id,
            currencyCode: od.currencyCode,
            orderFx: od.fx ?? null,
            redemptions,
        }) as SQLiteBatchItem[]);
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
        shippingCountryCode: od.shippingCountryCode,
        shippingLocality: od.shippingLocality,
        shippingPostalCode: od.shippingPostalCode,
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

        // A buyer agent's checkout carries its storefront context; every other
        // commit is the storefront's own checkout (COMMERCE-HOOKS H2).
        const orderChannel = checkoutCommit?.agentContext ? "agent" : "online_store";
        const [customer, inventoryPlan] = await Promise.all([
            resolveCustomerForOrder(db, payload, reads),
            prepareOrderInventory(
                db,
                payload,
                checkoutCommit?.attempt.origin === "new",
                reads?.variantStates,
                defaultOrderSalesChannelId(orderChannel),
            ),
        ]);
        reads = undefined;
        const appliedPromotion = payload.promotion
            ? await verifyPromotionCheckoutSnapshot(db, payload.promotion, {
                customerId: customer.id,
                // The account the checkout was prepared for, never a record matched by contact.
                segmentCustomerId: payload.existingCustomer?.id ?? null,
            })
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
        const orderWrites = buildOrderWriteBatch(
            db,
            payload,
            customer,
            appliedPromotion,
            orderChannel,
        );
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

            // Checked first: its marker is specific; the others' fallbacks are not.
            if (isAppStorageCommitConflict(error)) {
                throw new ValidationError(await readCheckoutCopy(db, "checkoutAppOfferChangedText"), { reason: APP_OFFER_CHANGED_REASON });
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
