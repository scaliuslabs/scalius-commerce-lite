// Staff-created (manual) orders: staff, app and agent policy (the actor's
// idempotency claim, hand-set prices, the named customer) around the one
// order commit (../commit-order.ts).
import { assertChannelSellsProducts, resolveStaffOrderSalesChannel } from "../../sales-channels";
import type { Database } from "@scalius/database/client";
import {
    customers,
    orders,
    OrderStatus,
    PaymentMethod,
    FulfillmentStatus,
    InventoryPool,
} from "@scalius/database/schema";
import { and, isNull, eq, sql } from "drizzle-orm";
import { buildOrderEventInsert, orderEventIdForRequest } from "../timeline";
import { guestRecordForContact } from "../../customers";
import { generateOrderId } from "@scalius/shared/order-utils";
import { normalizeOrderChannelSource } from "@scalius/shared/order-channel-source";
import { nanoid } from "nanoid";
import type { CreateOrderInput, ManualOrderPlacementQuoteInput } from "../validation";
import { AppError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { fromMinor } from "@scalius/shared/money";
import { deriveOrderPaymentState } from "../../payments";
import { paymentMethodsDocument, validateCustomerPhoneCountry } from "../../settings";
import {
    ADMIN_ORDER_CREATE_REQUEST_MISMATCH,
    buildAdminOrderCreateAttemptCommit,
    buildAdminOrderCreateAttemptGuard,
    buildAdminOrderCreateAttemptIdentity,
    claimAdminOrderCreateAttempt,
    isAdminOrderCreateAttemptGuardError,
    markAdminOrderCreateAttemptFailed,
    resolveAdminOrderCreateAttempt,
} from "./create-attempts";
import { prepareManualOrderQuote } from "./quote";
import type { AppProviders } from "../../../integrations/provider-port";
import { orderShippingAddressColumns, resolveOrderAddress } from "../shipping-address";
import { orderBillingAddressColumns, resolveStaffBillingAddress } from "../billing-address";
import { commitOrder, type OrderCustomer } from "../commit-order";
import type { OrderFacts, OrderLine } from "../types";
import type { SQLiteBatchItem } from "./shared";
import type { AppliedAppDiscount, ManualOrderAppFunctions } from "@scalius/shared/checkout-app-facts";
import {
    assertPointOfSaleStock,
    buildPointOfSaleStockGuard,
    planPointOfSaleTenders,
    pointOfSaleStockShortfall,
    resolvePointOfSaleLocation,
    type PointOfSaleTenderPlan,
} from "./point-of-sale";

/** The order would total something other than what staff reviewed; `details.totalMinor` is the new total, in minor units. */
export class ManualOrderTotalChangedError extends AppError {
    constructor(totalMinor: number) {
        super(409, "manual_order_total_changed", "The order total changed. Review the new total, then create the order again.", { totalMinor });
        this.name = "ManualOrderTotalChangedError";
    }
}

/**
 * A replay of a committed order whose reviewed `expectedTotalMinor` is not the
 * order's total: the request already placed that order, at another total, so
 * it is never answered as a plain success. It is the committed request
 * mismatch (409 `admin_order_create_request_mismatch`, `state: "committed"`,
 * the order's id and total), not `manual_order_total_changed`, which tells
 * the caller to create the order again: that would place a second order.
 */
async function assertReplayAtReviewedTotal(db: Database, data: CreateOrderInput, response: { id: string }): Promise<void> {
    if (data.expectedTotalMinor === undefined) return;
    const placed = await db.select({ totalMinor: orders.totalAmountMinor })
        .from(orders).where(eq(orders.id, response.id)).get();
    if (!placed || data.expectedTotalMinor === placed.totalMinor) return;
    throw new AppError(409, ADMIN_ORDER_CREATE_REQUEST_MISMATCH, "This request already placed the order, at another total than the one reviewed. Open it instead of placing it again.", {
        state: "committed",
        canRetryWithNewKey: false,
        orderId: response.id,
        reason: "total_differs",
        totalMinor: placed.totalMinor,
    });
}

/** What this request committed (absent on a replay). */
export interface ManualOrderCommitted {
    orderId: string;
    /** The guest record the order is filed under (by phone). */
    customerId: string;
    paymentMethod: string;
    totalAmountMinor: number;
    appDiscounts: AppliedAppDiscount[];
}

export interface CreateManualOrderResult {
    response: { id: string };
    committed: ManualOrderCommitted | null;
}

/**
 * Creates an order in the admin context (manual order entry): one confirmed,
 * unpaid cash-on-delivery or invoice order whose tracked stock stays reserved
 * until the fulfilment lifecycle deducts it. The order, its customer, lines,
 * tax facts, reservation and replay response commit in one batch.
 */
export async function createOrder(
    db: Database,
    data: CreateOrderInput,
    actor: string,
): Promise<{ id: string }> {
    return (await createManualOrder(db, data, actor)).response;
}

/**
 * The customer a staff order is filed under: a named customer (an app's
 * renewal, a B2B buyer), else the guest record of its phone, else a new one.
 * A named customer that owns a storefront account owns the order too, as a
 * signed-in checkout does (customer-identity.ts: customer_id equals
 * account_owner_customer_id), so the order shows in the buyer's account. The
 * phone's guest record is never an account.
 */
async function resolveManualOrderCustomer(db: Database, data: CreateOrderInput): Promise<OrderCustomer> {
    const existing = await db
        .select({ id: customers.id, accountClaimedAt: customers.accountClaimedAt })
        .from(customers)
        .where(data.customerId
            ? and(eq(customers.id, data.customerId), isNull(customers.deletedAt))
            : guestRecordForContact({ phone: data.customerPhone }))
        .get();
    if (data.customerId && !existing) {
        throw new ValidationError("That customer doesn't exist or is in the trash.");
    }
    if (!existing) return { id: "cust_" + nanoid(), accountOwnerCustomerId: null, createdBy: "staff" };
    return {
        id: existing.id,
        accountOwnerCustomerId: data.customerId && existing.accountClaimedAt ? existing.id : null,
    };
}

/**
 * How a staff or app order is paid. One paid as it is placed (marked paid,
 * an in-person sale) records a real payment of its `via` right after it
 * commits (`manual`, `RECORDED_PAYMENT_METHOD`), never a pay-later term; so
 * it takes no invoice method or terms. Otherwise cash on delivery, or an
 * invoice (`net_terms`).
 */
export function manualOrderPaymentMethod(data: Pick<CreateOrderInput, "paid" | "pointOfSale" | "paymentMethod" | "paymentTermsDays">) {
    if (data.paid || data.pointOfSale) {
        if (data.paymentMethod === PaymentMethod.NET_TERMS || data.paymentTermsDays !== undefined) {
            throw new ValidationError("An order paid as it is placed has no invoice or payment terms: send paid (or pointOfSale) without them.");
        }
        return PaymentMethod.MANUAL;
    }
    return data.paymentMethod === PaymentMethod.NET_TERMS ? PaymentMethod.NET_TERMS : PaymentMethod.COD;
}

type ManualOrderPricingOptions = { apps?: ManualOrderAppFunctions; appProviders?: AppProviders };

/**
 * Everything an order is priced and checked by before anything is written:
 * its sales channel, an in-person sale's counter, the one manual-order quote
 * (prices, app functions, discounts, tax), and a sale's tenders and counter
 * stock. The create commits from it and `quoteManualOrderPlacement` answers
 * it, so a quote and the order it previews are priced by one path. A quote
 * may leave a sale's tenders out (`tendersOptional`): the cashier asks the
 * total before taking money.
 */
async function priceManualOrder(
    db: Database,
    data: CreateOrderInput | ManualOrderPlacementQuoteInput,
    paymentMethod: ReturnType<typeof manualOrderPaymentMethod>,
    options: ManualOrderPricingOptions,
    { tendersOptional = false }: { tendersOptional?: boolean } = {},
) {
    // An active channel staff picked, else the online store (MARKETS-DESIGN D6).
    const salesChannelId = await resolveStaffOrderSalesChannel(db, data.salesChannelId);
    // An in-person sale hands its goods over at a counter of its channel.
    const sale = data.pointOfSale ?? null;
    if (sale && (data.shippingMethodId || data.shippingAddress?.trim())) {
        throw new ValidationError("An in-person sale is handed over at the counter: send no delivery method or address.");
    }
    const saleLocation = sale ? await resolvePointOfSaleLocation(db, sale, salesChannelId) : null;
    // An app's channel sells only what is published to it, on a sale and on its quote alike.
    await assertChannelSellsProducts(db, salesChannelId, data.items.map((item) => item.productId));
    const prepared = await prepareManualOrderQuote(db, { ...data, paymentMethod }, undefined, undefined, {
        apps: options.apps,
        appProviders: options.appProviders,
        // Apps see who places it and the channel it sells from, as the order records them.
        channel: data.channel ?? "admin",
        salesChannelId,
        // A sale is handed over at the counter: its physical lines are picked up, nothing ships.
        ...(sale ? { fixedDeliveryMethodKind: "pickup" as const } : {}),
    });
    // A sale is refused before anything is written when its tenders do
    // not pay the total or its counter lacks the units.
    let salePlan: PointOfSaleTenderPlan | null = null;
    if (sale && saleLocation) {
        if (sale.tenders.length > 0 || !tendersOptional) salePlan = planPointOfSaleTenders(sale, prepared.taxQuote.totalMinor, { allowShort: tendersOptional });
        await assertPointOfSaleStock(db, saleLocation, prepared.trackedItems);
    }
    return { salesChannelId, sale, saleLocation, salePlan, prepared };
}

/** An order priced as its create would price it, in minor units; nothing is written. */
export interface ManualOrderPlacementQuote {
    currency: string;
    lines: Array<{ productId: string; variantId: string; title: string; quantity: number; unitPriceMinor: number; totalMinor: number }>;
    subtotalMinor: number;
    discountMinor: number;
    shippingMinor: number;
    taxMinor: number;
    totalMinor: number;
    taxLabel: string;
    pricesIncludeTax: boolean;
    appDiscounts: Array<{ appId: string; title: string; amountMinor: number; shippingMinor: number }>;
    /** An in-person sale: its counter and what the tenders given so far pay. */
    pointOfSale: { locationId: string; tenderedMinor: number; changeMinor: number; dueMinor: number } | null;
}

/**
 * Prices an order exactly as `createManualOrder` would place it now (the same
 * channel, counter, app functions, discounts and tax, and the same refusals
 * before a write: an archived or unlinked counter, an unknown cashier, a
 * counter short of the units, change without cash), and writes nothing. A
 * sale's tenders may be left out or fall short: `dueMinor` says what is
 * still owed. Prices may move before the order is placed; the create's
 * `expectedTotalMinor` refuses a total other than the one quoted.
 */
export async function quoteManualOrderPlacement(
    db: Database,
    data: ManualOrderPlacementQuoteInput,
    options: ManualOrderPricingOptions = {},
): Promise<ManualOrderPlacementQuote> {
    const paymentMethod = manualOrderPaymentMethod(data);
    const { sale, salePlan, prepared: { taxQuote, trackedItems, appDiscounts } } = await priceManualOrder(db, data, paymentMethod, options, { tendersOptional: true });
    const tenderedMinor = salePlan?.facts.tenderedMinor ?? 0;
    return {
        currency: taxQuote.currencyCode,
        lines: trackedItems.map((item, index) => ({
            productId: item.productId,
            variantId: item.variantId,
            title: item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor,
            totalMinor: taxQuote.lines[index]?.grossAmountMinor ?? item.unitPriceMinor * item.quantity,
        })),
        subtotalMinor: taxQuote.subtotalMinor,
        discountMinor: taxQuote.discountMinor,
        shippingMinor: taxQuote.shippingMinor,
        taxMinor: taxQuote.taxMinor,
        totalMinor: taxQuote.totalMinor,
        taxLabel: taxQuote.displayLabel,
        pricesIncludeTax: taxQuote.pricesIncludeTax,
        appDiscounts: appDiscounts.map((discount) => ({
            appId: discount.pluginId,
            title: discount.title,
            amountMinor: discount.amountMinor,
            shippingMinor: discount.shippingAmountMinor,
        })),
        pointOfSale: sale ? {
            locationId: sale.locationId,
            tenderedMinor,
            changeMinor: salePlan?.facts.changeMinor ?? 0,
            dueMinor: Math.max(0, taxQuote.totalMinor - tenderedMinor),
        } : null,
    };
}

/**
 * `createOrder` with the apps' checkout functions (channel "admin",
 * app-functions.ts): their rules, delivery options, payment method and
 * discounts apply as on the online store, and the order records the app
 * discounts. `committed` is set only when this call committed the order.
 */
export async function createManualOrder(
    db: Database,
    data: CreateOrderInput,
    /**
     * Who places it: `app:<id>` for an app, the staff member's id otherwise.
     * It scopes the request key (`buildAdminOrderCreateAttemptIdentity`) and
     * names the actor of the order's timeline lines.
     */
    actor: string,
    /**
     * The apps' checkout functions, injected by the API (checkout's
     * `createManualOrderAppFunctions`), and the request's app providers (an
     * app tax provider).
     */
    options: {
        apps?: ManualOrderAppFunctions;
        appProviders?: AppProviders;
        /**
         * An app or an agent places the order: an invoice (net terms) only
         * while the store offers invoices (Settings → Payments). Staff may
         * invoice any customer whether or not buyers are offered it.
         */
        automated?: boolean;
    } = {},
): Promise<CreateManualOrderResult> {
    const replayed = (response: { id: string }): CreateManualOrderResult => ({ response, committed: null });
    const attemptIdentity = await buildAdminOrderCreateAttemptIdentity(data, actor);
    const existingReplay = await resolveAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (existingReplay) {
        await assertReplayAtReviewedTotal(db, data, existingReplay.response);
        return replayed(existingReplay.response);
    }
    await validateCustomerPhoneCountry(db, data.customerPhone);
    const paymentMethod = manualOrderPaymentMethod(data);
    const paymentMethods = paymentMethod === PaymentMethod.NET_TERMS ? await paymentMethodsDocument.read(db) : null;
    if (paymentMethods && options.automated && !(paymentMethods.enabledMethods ?? []).includes(PaymentMethod.NET_TERMS)) {
        throw new ValidationError(
            "This store does not offer invoices. Turn on Invoice / net terms in Settings → Payments, or ask staff to place it.",
            { reason: "payment_method_unavailable" },
        );
    }
    // A committed response is resolved before mutable policy checks so a lost
    // response still replays. Fresh requests validate before claiming, which
    // lets a merchant correct a rejected phone without burning the request key.
    const claim = await claimAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (claim.status === "replay") {
        await assertReplayAtReviewedTotal(db, data, claim.response);
        return replayed(claim.response);
    }
    if (claim.status === "processing") {
        throw new ServiceUnavailableError(
            "This manual order is still being created. Retry the same form in a moment.",
        );
    }
    const attempt = claim.attempt;
    const orderId = attempt.orderId;
    const response = { id: orderId };
    // A reclaimed request owns the same stable reservation identity: its
    // attempt is not marked failed underneath the new owner.
    let lostClaim = false;

    try {
        const {
            salesChannelId,
            saleLocation,
            salePlan,
            prepared: {
                locationNames: { cityName, zoneName, areaName },
                trackedItems,
                allocationLineIds,
                taxQuote,
                address,
                requiresShipping,
                deliveryMethodKind,
                deliveryMethod: shippingMethod,
                appDiscounts,
                appObjectCommits,
            },
        } = await priceManualOrder(db, data, paymentMethod, options);
        // The apps' holds (a delivery slot's place) commit with the order, as at checkout.
        const appCommitStatements = appObjectCommits.length > 0 && options.apps?.commitStatements
            ? options.apps.commitStatements(appObjectCommits) as SQLiteBatchItem[]
            : [];
        if (data.expectedTotalMinor !== undefined && data.expectedTotalMinor !== taxQuote.totalMinor) {
            throw new ManualOrderTotalChangedError(taxQuote.totalMinor);
        }
        if (requiresShipping && !data.shippingAddress?.trim()) {
            throw new ValidationError("Enter the delivery address, or choose a pickup method.");
        }
        // The snapshot, checked by its country's rules (staff may skip them; it stays marked).
        const shippingAddress = requiresShipping
            ? resolveOrderAddress(
                data,
                address ? { ...address, cityName, zoneName, areaName } : null,
                { skipValidation: data.skipAddressValidation === true },
            )
            : null;
        // The billing address: the shipping address by default when the order
        // ships; otherwise optional (staff may skip its rules too).
        const billing = resolveStaffBillingAddress(data, {
            ships: requiresShipping,
            skipValidation: data.skipAddressValidation === true,
        });
        const paymentState = deriveOrderPaymentState({ totalAmountMinor: taxQuote.totalMinor, ledger: [] });
        // A method picked for an order with nothing physical is not used.
        const method = shippingMethod && deliveryMethodKind ? shippingMethod : null;
        const contact = { name: data.customerName, phone: data.customerPhone };

        const order: OrderFacts = {
            id: orderId,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail,
            ...orderShippingAddressColumns(shippingAddress, contact),
            ...orderBillingAddressColumns(billing, contact),
            notes: data.notes,
            attributes: JSON.stringify(data.attributes ?? {}),
            shippingMethodId: method?.id ?? null,
            shippingMethodName: method?.name ?? null,
            shippingMethodDescription: method?.description ?? null,
            shippingMethodBaseAmountMinor: method?.feeMinor ?? null,
            shippingFeeWaived: null,
            requiresShipping,
            shippingMethodKind: deliveryMethodKind,
            pickupAddress: deliveryMethodKind === "pickup" ? shippingMethod?.pickupAddress ?? null : null,
            pickupHours: deliveryMethodKind === "pickup" ? shippingMethod?.pickupHours ?? null : null,
            // A staff order is priced in the shop currency: same-currency.
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
            subtotalAmountMinor: taxQuote.subtotalMinor,
            shippingAmountMinor: taxQuote.shippingMinor,
            discountAmountMinor: taxQuote.discountMinor,
            taxAmountMinor: taxQuote.taxMinor,
            totalAmountMinor: taxQuote.totalMinor,
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            status: OrderStatus.CONFIRMED,
            paymentMethod,
            paymentStatus: paymentState.paymentStatus,
            paidAmountMinor: paymentState.paidAmountMinor,
            balanceDueMinor: paymentState.balanceDueMinor,
            // An invoice (net terms): unpaid now, due in the days staff or
            // the app chose, else the store's net days (Settings → Payments).
            // An order paid as it is placed has no terms.
            paymentTermsDays: paymentMethod === PaymentMethod.NET_TERMS
                ? data.paymentTermsDays ?? paymentMethods!.netTerms.dueInDays
                : null,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            inventoryPool: InventoryPool.REGULAR,
            inventoryAction: trackedItems.some((item) => item.inventoryTracked) ? "reserved" : "none",
            ...(saleLocation ? { fulfillmentLocationId: saleLocation.id } : {}),
        };
        const lines: OrderLine[] = trackedItems.map((item, index) => {
            const taxAllocationLineId = allocationLineIds[index]!;
            const lineTax = taxQuote.lines.find((line) => line.lineId === taxAllocationLineId);
            if (!lineTax) {
                throw new ValidationError("Authoritative tax quote is missing a manual-order line. Please retry.");
            }
            return {
                id: generateOrderId(),
                taxAllocationLineId,
                productId: item.productId,
                variantId: item.variantId,
                productImageMediaId: item.productImageMediaId,
                quantity: item.quantity,
                productName: item.productName,
                variantLabel: item.variantLabel,
                inventoryTracked: item.inventoryTracked,
                fulfillmentType: item.fulfillmentType,
                properties: item.properties,
                propertiesPriceMinor: item.propertiesPriceMinor,
                baseUnitPriceMinor: item.baseUnitPriceMinor,
                unitPriceMinor: lineTax.unitPriceMinor,
                lineSubtotalMinor: lineTax.grossAmountMinor,
                discountAmountMinor: lineTax.discountMinor,
                taxableAmountMinor: lineTax.taxableAmountMinor,
                taxAmountMinor: lineTax.taxMinor,
            };
        });

        // Prices set by hand are part of the order's record, in the same batch.
        const pricedByHand = data.items.filter((item) => item.unitPriceMinor !== undefined).length;
        const pricesSetEventId = pricedByHand > 0 ? await orderEventIdForRequest(orderId, "prices_set", data.requestKey) : null;
        // A sale's receipt facts commit with it.
        const saleEventId = salePlan ? await orderEventIdForRequest(orderId, "pos_sale", data.requestKey) : null;

        const committed = await commitOrder(db, {
            // Staff-created; the source says where it came in (facebook, walk_in, …).
            channel: data.channel ?? "admin",
            channelSource: normalizeOrderChannelSource(data.channelSource),
            salesChannelId,
            order,
            lines,
            taxQuote,
            appDiscounts,
            reservationKey: `admin-order-create:v2:${orderId}`,
            // Created from an abandoned checkout: its snapshot ends with the order.
            abandonedCheckoutId: data.abandonedCheckoutId ?? null,
        }, {
            async prepare() {
                const customer = await resolveManualOrderCustomer(db, data);
                return {
                    customer,
                    before: [buildAdminOrderCreateAttemptGuard(db, attempt)],
                    after: [
                        ...(pricesSetEventId ? [buildOrderEventInsert(db, {
                            id: pricesSetEventId,
                            orderId,
                            kind: "prices_set",
                            actorId: actor,
                            data: { lines: pricedByHand },
                        }, sql`1`) as unknown as SQLiteBatchItem] : []),
                        ...(saleEventId && salePlan && saleLocation ? [buildOrderEventInsert(db, {
                            id: saleEventId,
                            orderId,
                            kind: "pos_sale",
                            actorId: actor,
                            // The receipt facts (minor units), and for the timeline the counter's name and the change in major units.
                            data: { ...salePlan.facts, locationName: saleLocation.name, change: fromMinor(salePlan.facts.changeMinor, taxQuote.decimalPlaces) },
                        }, sql`1`) as unknown as SQLiteBatchItem] : []),
                        // A sale's counter covers its units, every other reservation there included.
                        ...(saleLocation && order.inventoryAction === "reserved" ? [buildPointOfSaleStockGuard(db, orderId, saleLocation.id)] : []),
                        ...appCommitStatements,
                        buildAdminOrderCreateAttemptCommit(db, attempt, response),
                    ],
                };
            },
            stockUnavailable: (reservation) => new ValidationError(
                reservation.error ?? "Insufficient stock for one or more items",
            ),
            async mapError(error) {
                // A hold another order took since the quote: the app's refusal, as at checkout.
                const held = appCommitStatements.length > 0 ? await options.apps?.commitConflict?.(error) : null;
                if (held) return held;
                const short = saleLocation ? pointOfSaleStockShortfall(error, saleLocation) : null;
                if (short) return short;
                if (!isAdminOrderCreateAttemptGuardError(error)) return null;
                lostClaim = true;
                return new ConflictError(
                    "Another request owns this manual-order creation. Retry the same form to recover its result.",
                );
            },
        });
        // The batch failed after committing (a lost response): the order is this request's.
        if (committed.alreadyCommitted) return replayed(response);

        return {
            response,
            committed: {
                orderId,
                customerId: committed.customerId!,
                paymentMethod,
                totalAmountMinor: taxQuote.totalMinor,
                appDiscounts,
            },
        };
    } catch (error) {
        if (!lostClaim) await markAdminOrderCreateAttemptFailed(db, attempt, error).catch(() => undefined);
        throw error;
    }
}
