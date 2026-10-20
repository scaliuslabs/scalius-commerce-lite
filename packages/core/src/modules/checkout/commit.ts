// The storefront order commit: the checkout's policy (authority fence,
// idempotency attempt and receipt, promotions, gift cards, app records,
// outbox claims) around the one order commit (orders/commit-order.ts).
import {
    commitOrder,
    MAX_ORDER_LINE_ITEMS,
    type OrderCommitResult,
    type OrderCustomer,
    type StorefrontOrderCommitPayload,
} from "../orders";
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError, type Database } from "@scalius/database/client";
import {
    agentStorefrontContexts,
    agentStorefrontContinuations,
    agentStorefrontOrderGrants,
    checkoutAuthority,
    orderDiscountAllocations,
    notificationOutbox,
    OrderStatus,
    promotionRedemptions,
} from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { defaultOrderSalesChannelId } from "@scalius/shared/sales-channels";
import { ConflictError, ValidationError } from "../../errors";
import type { PreparedStockReservationBatch } from "../inventory";
import {
    buildMetaPurchaseOutboxClaimInsert,
    isOrderEligibleForMetaPurchase,
} from "../../integrations/meta/purchase-outbox";
import { buildOrderTrackingCommitStatements } from "../../integrations/tracking/signals";
import {
  buildOrderCreatedNotificationDedupeKey,
  orderCreatedNotificationOutboxId,
  createOrderNotificationOutboxInsertValues,
  type NotificationSender,
} from "../notifications";
import { shouldCreateOrderCreatedNotification } from "./created-notification-policy";
import {
  chooseOrderCustomer,
  normalizeContactEmail,
  type OrderContact,
  selectContactCustomerCandidates,
} from "../customers";
import type { StorefrontCartItemIssue } from "./cart-validation";
import { getPromotionRedemptionConstraintError, verifyPromotionCheckoutSnapshot } from "../promotions";
import { type AppliedPromotion } from "../promotions/browser";
import {
    prepareAtomicCheckoutAttemptCommit,
    isCheckoutAttemptCommitConflictError,
    type AtomicCheckoutAttempt,
} from "./attempts";
import { appObjectCommitStatements, isAppObjectCommitConflict } from "../objects";
import { readCheckoutCopy } from "./store-copy";
import type { StorefrontOrderCommitReads, SQLiteBatchItem } from "./reads";
import {
    GiftCardChangedError,
    buildGiftCardRedemptionStatements,
    isGiftCardLedgerError,
} from "../gift-cards";

export interface StorefrontOrderCommitRuntime {
    /** Sends the order_created notification right after the commit. */
    sendNotifications?: NotificationSender;
    STOREFRONT_URL?: string;
    CREDENTIAL_ENCRYPTION_KEY?: string;
}

export type StorefrontOrderCommitResult = OrderCommitResult;

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

// The checkout's ledger-v2 reservation identity (movement ids hash it with
// the order id); stable, so movement ids stay what they always were.
const CHECKOUT_RESERVATION_KEY = "checkout-ingest:v1";
const ORDER_DISCOUNT_ALLOCATION_INSERT_PARAMETERS_PER_ROW = 18;
const CHECKOUT_AUTHORITY_CHANGED = "checkout_authority_changed";
/** An app's offer (a record its function read) changed between the quote and the commit. */
export const APP_OFFER_CHANGED_REASON = "app_offer_changed";
const CHECKOUT_AUTHORITY_CHANGED_MESSAGE =
    "Checkout details changed while the order was being placed. Return to your cart to review them and try again.";
// Checked before the inventory classifier, whose Turso matcher treats any
// "conflict" text as a retryable write conflict.
const AGENT_CONTEXT_CHECKOUT_CONFLICT = "agent_storefront_context_checkout_conflict";

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

/**
 * Signed in: the account (the commit fences it is still live and claimed).
 * Guest: the customer who PROVED the order's phone or email, else the phone's
 * guest record, else a new guest record. A guest checkout never writes to an
 * existing customer's profile (see customers/customer-identity.ts).
 */
async function resolveCustomerForOrder(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    reads?: StorefrontOrderCommitReads,
): Promise<OrderCustomer> {
    if (payload.existingCustomer?.id) {
        const id = payload.existingCustomer.id;
        return { id, accountOwnerCustomerId: id, requireLiveAccount: true };
    }

    const contact: OrderContact = { phone: payload.orderData.customerPhone, email: payload.orderData.customerEmail };
    const candidates = reads
        && reads.contact.phone === contact.phone
        && normalizeContactEmail(reads.contact.email) === normalizeContactEmail(contact.email)
        ? reads.contactCustomers
        : await selectContactCustomerCandidates(db, contact);
    const chosen = chooseOrderCustomer(candidates, contact);
    return chosen
        ? { id: chosen.customerId, accountOwnerCustomerId: chosen.accountOwnerCustomerId, linkedBy: chosen.linkedBy }
        : { id: "cust_" + nanoid(), accountOwnerCustomerId: null, createdBy: "buyer" };
}

/** Stock the cart can no longer hold, as the cart's item issues. */
function cartStockError(payload: StorefrontOrderCommitPayload, reservation: PreparedStockReservationBatch): ValidationError {
    const itemIssues = buildReservationItemIssues(payload, reservation.results);
    return new ValidationError("Some items in your cart need attention.", {
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
        inventoryError: reservation.error,
    });
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
                code: "quantity_unavailable",
                action: "remove",
                message: `${productName}${variantLabel ? ` (${variantLabel})` : ""} is no longer available in the requested quantity.`,
                productName,
                variantLabel,
                requestedQuantity: item?.quantity ?? 0,
            };
        });
}

/**
 * The checkout's facts after the order's own rows: the order-created
 * notification claim, promotion allocations and redemptions, app record
 * writes, the gift-card hold, the Meta claim and the tracking snapshot. The
 * payload's discounts must agree with its lines and tax quote.
 */
function checkoutOrderFacts(
    db: Database,
    payload: StorefrontOrderCommitPayload,
    customer: OrderCustomer,
    appliedPromotion: AppliedPromotion | null,
): SQLiteBatchItem[] {
    const od = payload.orderData;
    const writes: SQLiteBatchItem[] = [];

    if (wantsOrderCreatedNotification(payload)) {
        writes.push(
            db.insert(notificationOutbox).values({
                ...createOrderNotificationOutboxInsertValues({
                    dedupeKey: buildOrderCreatedNotificationDedupeKey(od.id),
                    orderId: od.id,
                    notificationType: "order_created",
                    source: "storefront-order",
                }),
                id: orderCreatedNotificationOutboxId(od.id),
            }),
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

    // App record writes (a balance the discount spends) commit with the
    // order, each at the revision its app saw: a lost race fails the order.
    const storageCommits = payload.appObjectCommits ?? [];
    if (storageCommits.length > 0) {
        const discounted = new Set(appDiscounts.map((discount) => discount.pluginId));
        if (storageCommits.some((commit) => !discounted.has(commit.pluginId))) {
            throw new ValidationError("Committed app storage write has no applied discount.");
        }
        const { guards, writes: commitWrites } = appObjectCommitStatements(db, storageCommits);
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

    // The order's consent snapshot and match signals (audit spec S4): with the
    // order or not at all, so a server Purchase never runs without its consent.
    if (payload.trackingSnapshot) {
        writes.push(...buildOrderTrackingCommitStatements(db, od.id, payload.trackingSnapshot, {
            awaitingPayment: od.status === OrderStatus.INCOMPLETE,
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

/**
 * The storefront's (and a buyer agent's) order commit: the checkout's policy
 * around `commitOrder()`. Before the stock moves: the authority fence, the
 * idempotency attempt and the agent context; after the order: the checkout's
 * facts, the receipt and the agent's grant.
 */
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
    if (
        !Number.isSafeInteger(payload.checkoutAuthorityRevision)
        || (payload.checkoutAuthorityRevision ?? 0) < 1
    ) {
        throw new ValidationError("Checkout authority revision is unavailable. Please retry checkout.");
    }

    // A buyer agent's checkout carries its storefront context; every other
    // commit is the storefront's own checkout (COMMERCE-HOOKS H2).
    const channel = checkoutCommit?.agentContext ? "agent" : "online_store";
    // Prefetched rows serve the first attempt only; a retry re-reads.
    let reads = prefetchedReads;

    return commitOrder(db, {
        channel,
        salesChannelId: defaultOrderSalesChannelId(channel),
        order: payload.orderData,
        lines: payload.items,
        taxQuote: payload.taxQuote,
        appDiscounts: payload.appDiscounts,
        reservationKey: CHECKOUT_RESERVATION_KEY,
    }, {
        variantStates: prefetchedReads?.variantStates,
        async prepare() {
            const customer = await resolveCustomerForOrder(db, payload, reads);
            reads = undefined;
            const [appliedPromotion, attemptPlan] = await Promise.all([
                payload.promotion
                    ? verifyPromotionCheckoutSnapshot(db, payload.promotion, {
                        customerId: customer.id,
                        // The account the checkout was prepared for, never a record matched by contact.
                        segmentCustomerId: payload.existingCustomer?.id ?? null,
                    })
                    : null,
                checkoutCommit
                    ? prepareAtomicCheckoutAttemptCommit(db, checkoutCommit.attempt, {
                        paymentMethod: payload.orderData.paymentMethod,
                        totalAmountMinor: payload.orderData.totalAmountMinor,
                        response: checkoutCommit.response,
                    })
                    : null,
            ]);
            const agentPlan = checkoutCommit?.agentContext
                ? prepareAgentStorefrontCheckoutCommit(db, payload, checkoutCommit.agentContext)
                : null;
            const authorityGuard = buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${checkoutAuthority}
                WHERE ${checkoutAuthority.id} = 'default'
                  AND ${checkoutAuthority.revision} = ${payload.checkoutAuthorityRevision}
            )`, CHECKOUT_AUTHORITY_CHANGED) as SQLiteBatchItem;
            return {
                customer,
                before: [
                    authorityGuard,
                    ...(attemptPlan?.writesBeforeOrder ?? []),
                    ...(agentPlan?.writesBeforeOrder ?? []),
                ],
                after: [
                    ...checkoutOrderFacts(db, payload, customer, appliedPromotion),
                    ...(attemptPlan?.writesAfterOrder ?? []),
                    ...(agentPlan?.writesAfterOrder ?? []),
                ],
            };
        },
        stockUnavailable: (reservation) => cartStockError(payload, reservation),
        async mapError(error) {
            // Checked first: its marker is specific; the others' fallbacks are not.
            if (isAppObjectCommitConflict(error)) {
                return new ValidationError(await readCheckoutCopy(db, "checkoutAppOfferChangedText"), { reason: APP_OFFER_CHANGED_REASON });
            }
            return checkoutGuardError(error)
                ?? getPromotionRedemptionConstraintError(error)
                ?? (checkoutCommit && isCheckoutAttemptCommitConflictError(error)
                    ? new ConflictError("Checkout attempt changed before the order could be committed. Please retry.")
                    : null);
        },
    });
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
