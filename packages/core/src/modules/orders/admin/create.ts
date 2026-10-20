// Staff-created (manual) orders: staff, app and agent policy (the actor's
// idempotency claim, hand-set prices, the named customer) around the one
// order commit (../commit-order.ts).
import { resolveStaffOrderSalesChannel } from "../../sales-channels";
import type { Database } from "@scalius/database/client";
import {
    customers,
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
import type { CreateOrderInput } from "../validation";
import { ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { computeOrderPaymentState } from "../../payments";
import { paymentMethodsDocument, validateCustomerPhoneCountry } from "../../settings";
import {
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
    actorId: string | null,
): Promise<{ id: string }> {
    return (await createManualOrder(db, data, actorId)).response;
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
 * `createOrder` with the apps' checkout functions (channel "admin",
 * app-functions.ts): their rules, delivery options, payment method and
 * discounts apply as on the online store, and the order records the app
 * discounts. `committed` is set only when this call committed the order.
 */
export async function createManualOrder(
    db: Database,
    data: CreateOrderInput,
    actorId: string | null,
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
    const attemptIdentity = await buildAdminOrderCreateAttemptIdentity(data, actorId);
    const existingReplay = await resolveAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (existingReplay) return replayed(existingReplay.response);
    await validateCustomerPhoneCountry(db, data.customerPhone);
    const paymentMethods = data.paymentMethod === PaymentMethod.NET_TERMS ? await paymentMethodsDocument.read(db) : null;
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
    if (claim.status === "replay") return replayed(claim.response);
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
        // An active channel staff picked, else the online store (MARKETS-DESIGN D6).
        const salesChannelId = await resolveStaffOrderSalesChannel(db, data.salesChannelId);
        const {
            locationNames: { cityName, zoneName, areaName },
            trackedItems,
            allocationLineIds,
            taxQuote,
            address,
            requiresShipping,
            deliveryMethodKind,
            deliveryMethod: shippingMethod,
            appDiscounts,
        } = await prepareManualOrderQuote(db, data, undefined, undefined, { apps: options.apps, appProviders: options.appProviders });
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
        const paymentState = computeOrderPaymentState({ totalAmountMinor: taxQuote.totalMinor, paidAmountMinor: 0 });
        const paymentMethod = data.paymentMethod === PaymentMethod.NET_TERMS ? PaymentMethod.NET_TERMS : PaymentMethod.COD;
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
            paymentTermsDays: paymentMethod === PaymentMethod.NET_TERMS
                ? data.paymentTermsDays ?? paymentMethods!.netTerms.dueInDays
                : null,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            inventoryPool: InventoryPool.REGULAR,
            inventoryAction: trackedItems.some((item) => item.inventoryTracked) ? "reserved" : "none",
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
                            actorId,
                            data: { lines: pricedByHand },
                        }, sql`1`) as unknown as SQLiteBatchItem] : []),
                        buildAdminOrderCreateAttemptCommit(db, attempt, response),
                    ],
                };
            },
            stockUnavailable: (reservation) => new ValidationError(
                reservation.error ?? "Insufficient stock for one or more items",
            ),
            mapError(error) {
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
