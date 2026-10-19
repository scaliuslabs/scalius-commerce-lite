// Staff-created (manual) orders: one guarded batch writes the order, its lines, stock reservations and receipt.
import { resolveStaffOrderSalesChannel } from "../../sales-channels";
import { nextOrderNumberSql } from "../number";
import { chunkRowsForD1, safeBatch, type Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    orderTaxSnapshots,
    orderItemTaxSnapshots,
    customers,
    customerHistory,
    codTracking,
    OrderStatus,
    PaymentMethod,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { prepareStockReservationBatch } from "../../inventory";
import type { ReservationEntry } from "../../inventory";
import { and, isNull, sql, eq } from "drizzle-orm";
import { buildOrderEventInsert, orderEventIdForRequest } from "../timeline";
import { guestRecordForContact } from "../../customers";
import { generateOrderId } from "@scalius/shared/order-utils";
import { orderMoneyChainColumns } from "@scalius/shared/money-chain";
import { normalizeOrderChannelSource } from "@scalius/shared/order-channel-source";
import { nanoid } from "nanoid";
import type { CreateOrderInput } from "../validation";
import { ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { computeOrderPaymentState, createCODTrackingInsertValues } from "../../payments";
import { validateCustomerPhoneCountry } from "../../settings";
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
import { ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW, orderItemTaxSnapshotColumns, orderTaxSnapshotColumns } from "../../tax";
import { orderMarketIdSql } from "../../markets";
import { orderShippingAddressColumns, orderShippingAddressInsertColumns, resolveOrderAddress } from "../shipping-address";
import { orderBillingAddressColumns, orderBillingAddressInsertColumns, resolveStaffBillingAddress } from "../billing-address";
import type { SQLiteBatchItem } from "./shared";
import type { AppliedAppDiscount, ManualOrderAppFunctions } from "@scalius/shared/checkout-app-facts";
import { buildAppDiscountFactInserts } from "../../order-kernel";

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

// Bound values per multi-row insert row (drizzle binds every column,
// defaults included); D1 allows 100 per statement.
const ORDER_ITEM_INSERT_PARAMETERS_PER_ROW = 21;
const ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW = ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW;

// ─────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────

/**
 * Creates an order in the admin context (manual order entry).
 * Handles customer lookup/creation, location name resolution,
 * order row insertion, and order items insertion.
 *
 * Inventory flow:
 *   1. Reserve stock for all variant items (validates availability)
 *   2. Insert order + items atomically via db.batch()
 *   3. Commit one confirmed, unpaid COD order with immutable money/tax facts
 *   4. Keep tracked stock reserved until the fulfillment lifecycle deducts it
 *   5. If the batch fails, release all reservations (no orphaned holds)
 */
export async function createOrder(
    db: Database,
    data: CreateOrderInput,
    actorId: string | null,
): Promise<{ id: string }> {
    return (await createManualOrder(db, data, actorId)).response;
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
    options: { apps?: ManualOrderAppFunctions; appProviders?: AppProviders } = {},
): Promise<CreateManualOrderResult> {
    const replayed = (response: { id: string }): CreateManualOrderResult => ({ response, committed: null });
    const attemptIdentity = await buildAdminOrderCreateAttemptIdentity(data, actorId);
    const existingReplay = await resolveAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (existingReplay) return replayed(existingReplay.response);
    await validateCustomerPhoneCountry(db, data.customerPhone);
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

    // A committed response is resolved before mutable policy checks so a lost
    // response still replays. Fresh requests validate before claiming, which
    // lets a merchant correct a rejected phone without burning the request key.
    const prepared = await (async () => {
        // An active channel staff picked, else the online store (MARKETS-DESIGN D6).
        const salesChannelId = await resolveStaffOrderSalesChannel(db, data.salesChannelId);
        const manualQuote = await prepareManualOrderQuote(db, data, undefined, undefined, { apps: options.apps, appProviders: options.appProviders });
        const {
            locationNames: { cityName, zoneName, areaName },
            trackedItems,
            allocationLineIds,
            taxQuote,
            quote,
            address,
            requiresShipping,
            deliveryMethodKind,
            deliveryMethod: shippingMethod,
            manualDiscountMinor,
            appDiscounts,
            currency,
        } = manualQuote;
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
        const initialPaymentState = computeOrderPaymentState({
            totalAmountMinor: taxQuote.totalMinor,
            paidAmountMinor: 0,
        });
        // A named customer files the order under that record (an app's
        // renewal, a B2B buyer); otherwise the guest record of its phone.
        const existingCustomer = data.customerId
            ? await db.select().from(customers)
                .where(and(eq(customers.id, data.customerId), isNull(customers.deletedAt)))
                .get()
            : await db
                .select()
                .from(customers)
                .where(guestRecordForContact({ phone: data.customerPhone }))
                .get();
        if (data.customerId && !existingCustomer) {
            throw new ValidationError("That customer doesn't exist or is in the trash.");
        }
        const reservationEntries: ReservationEntry[] = trackedItems
            .filter((item) => item.inventoryTracked)
            .map((item) => ({
                variantId: item.variantId,
                quantity: item.quantity,
                pool: "regular" as const,
            }));
        const inventoryPlan = await prepareStockReservationBatch(
            db,
            reservationEntries.map((entry) => ({
                variantId: entry.variantId,
                quantity: entry.quantity,
                orderId,
            })),
            "regular",
            { reservationKey: `admin-order-create:v2:${orderId}` },
        );
        if (!inventoryPlan.success) {
            throw new ValidationError(
                inventoryPlan.error ?? "Insufficient stock for one or more items",
            );
        }

        return {
            initialPaymentState,
            address,
            shippingAddress,
            billing,
            requiresShipping,
            deliveryMethodKind,
            cityName,
            zoneName,
            areaName,
            existingCustomer,
            trackedItems,
            allocationLineIds,
            taxQuote,
            quote,
            reservationEntries,
            inventoryPlan,
            shippingMethod,
            manualDiscountMinor,
            appDiscounts,
            currency,
            salesChannelId,
        };
    })().catch(async (error) => {
        await markAdminOrderCreateAttemptFailed(db, attempt, error).catch(() => undefined);
        throw error;
    });
    const {
        initialPaymentState,
        address,
        shippingAddress,
        billing,
        requiresShipping,
        deliveryMethodKind,
        cityName,
        zoneName,
        areaName,
        existingCustomer,
        trackedItems,
        allocationLineIds,
        taxQuote,
        quote,
        reservationEntries,
        inventoryPlan,
        shippingMethod,
        manualDiscountMinor,
        appDiscounts,
        currency,
        salesChannelId,
    } = prepared;
    let customerId = existingCustomer?.id;

    // ── Atomic batch: customer + order + items ──────────────────────────
    // D1 batch() executes all statements in a single atomic operation.
    // If any statement fails, none are committed.
    const writeBatch: SQLiteBatchItem[] = [
        buildAdminOrderCreateAttemptGuard(db, attempt),
        ...inventoryPlan.statements,
    ];

    if (!existingCustomer) {
        customerId = "cust_" + nanoid();
        // Its address book gets the order's address from the order insert
        // (trigger orders_seed_customer_address).
        writeBatch.push(
            db.insert(customers).values({
                id: customerId,
                name: data.customerName,
                phone: data.customerPhone,
                email: data.customerEmail,
                totalOrders: 1,
                lastOrderAt: sql`unixepoch()`,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }),
        );
        writeBatch.push(
            db.insert(customerHistory).values({
                id: "hist_" + nanoid(),
                customerId: customerId!,
                name: data.customerName,
                email: data.customerEmail,
                phone: data.customerPhone,
                changeType: "created",
                actor: "staff",
                createdAt: sql`unixepoch()`,
            }),
        );
    } else {
        writeBatch.push(
            db.update(customers).set({
                totalOrders: sql`${customers.totalOrders} + 1`,
                lastOrderAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }).where(eq(customers.id, existingCustomer.id)),
        );
    }

    const preparedOrderItems = trackedItems.map((item, index) => {
        const allocationLineId = allocationLineIds[index]!;
        const lineTax = taxQuote.lines.find((line) => line.lineId === allocationLineId);
        if (!lineTax) {
            throw new ValidationError("Authoritative tax quote is missing a manual-order line. Please retry.");
        }
        return {
            id: generateOrderId(),
            item,
            lineTax,
        };
    });

    // Order row
    writeBatch.push(
        db.insert(orders).values({
            orderNumber: nextOrderNumberSql(db),
            id: orderId,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail,
            ...orderShippingAddressInsertColumns(orderShippingAddressColumns(shippingAddress, {
                name: data.customerName,
                phone: data.customerPhone,
            })),
            ...orderBillingAddressInsertColumns(orderBillingAddressColumns(billing, {
                name: data.customerName,
                phone: data.customerPhone,
            })),
            requiresShipping,
            shippingMethodKind: deliveryMethodKind,
            pickupAddress: deliveryMethodKind === "pickup" ? shippingMethod?.pickupAddress ?? null : null,
            pickupHours: deliveryMethodKind === "pickup" ? shippingMethod?.pickupHours ?? null : null,
            notes: data.notes,
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
            subtotalAmountMinor: taxQuote.subtotalMinor,
            shippingAmountMinor: taxQuote.shippingMinor,
            // A method picked for an order with nothing physical is not used.
            ...(shippingMethod && deliveryMethodKind ? {
                shippingMethodId: shippingMethod.id,
                shippingMethodName: shippingMethod.name,
                shippingMethodDescription: shippingMethod.description,
                shippingMethodBaseAmountMinor: shippingMethod.feeMinor,
            } : {}),
            discountAmountMinor: taxQuote.discountMinor,
            taxAmountMinor: taxQuote.taxMinor,
            totalAmountMinor: taxQuote.totalMinor,
            // The money chain in the same insert: a staff order is priced in the
            // shop currency, so it is same-currency (rate 1, shop = presentment).
            ...orderMoneyChainColumns({
                currencyCode: taxQuote.currencyCode,
                subtotalAmountMinor: taxQuote.subtotalMinor,
                shippingAmountMinor: taxQuote.shippingMinor,
                discountAmountMinor: taxQuote.discountMinor,
                taxAmountMinor: taxQuote.taxMinor,
                totalAmountMinor: taxQuote.totalMinor,
            }),
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            paidAmountMinor: initialPaymentState.paidAmountMinor,
            balanceDueMinor: initialPaymentState.balanceDueMinor,
            paymentStatus: initialPaymentState.paymentStatus,
            paymentMethod: PaymentMethod.COD,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            status: OrderStatus.CONFIRMED,
            // The shipping country's market, else (an order taxed at its billing
            // address) the billing country's, else the backup market (MARKETS-DESIGN D4).
            marketId: orderMarketIdSql(shippingAddress?.countryCode
                ?? (taxQuote.jurisdiction?.addressSource === "billing" ? billing?.address?.countryCode ?? null : null)),
            customerId,
            inventoryAction: reservationEntries.length > 0 ? "reserved" : "none",
            // Staff-created; the source says where it came in (facebook, walk_in, …).
            channel: data.channel ?? "admin",
            channelSource: normalizeOrderChannelSource(data.channelSource),
            attributes: JSON.stringify(data.attributes ?? {}),
            salesChannelId,
            version: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
    );

    // A COD order and its collection lifecycle are one durable fact. Keeping
    // this inside the create batch prevents a shippable order whose cash can
    // never be recorded because a later initialization call failed.
    writeBatch.push(
        db.insert(codTracking).values(createCODTrackingInsertValues(orderId)),
    );

    // Order items
    if (preparedOrderItems.length > 0) {
        const itemRows = preparedOrderItems.map(({ id, item, lineTax }) => ({
            id,
            orderId,
            productId: item.productId,
            variantId: item.variantId,
            productImageMediaId: item.productImageMediaId,
            quantity: item.quantity,
            productName: item.productName,
            variantLabel: item.variantLabel,
            inventoryTracked: item.inventoryTracked,
            unitPriceMinor: lineTax.unitPriceMinor,
            lineSubtotalMinor: lineTax.grossAmountMinor,
            discountAmountMinor: lineTax.discountMinor,
            taxableAmountMinor: lineTax.taxableAmountMinor,
            taxAmountMinor: lineTax.taxMinor,
            fulfillmentType: item.fulfillmentType,
            properties: item.properties,
            propertiesPriceMinor: item.propertiesPriceMinor,
            baseUnitPriceMinor: item.baseUnitPriceMinor,
            createdAt: sql`unixepoch()`,
        }));
        for (const chunk of chunkRowsForD1(
            itemRows,
            ORDER_ITEM_INSERT_PARAMETERS_PER_ROW,
        )) {
            writeBatch.push(db.insert(orderItems).values(chunk));
        }

        const itemTaxRows = preparedOrderItems.map(({ id, lineTax }) => ({
            orderItemId: id,
            orderId,
            ...orderItemTaxSnapshotColumns(taxQuote, lineTax),
            createdAt: sql`unixepoch()`,
        }));
        for (const chunk of chunkRowsForD1(
            itemTaxRows,
            ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW,
        )) {
            writeBatch.push(db.insert(orderItemTaxSnapshots).values(chunk));
        }
    }

    writeBatch.push(
        db.insert(orderTaxSnapshots).values({
            orderId,
            ...orderTaxSnapshotColumns(taxQuote),
            createdAt: sql`unixepoch()`,
        }),
    );

    // App discounts (checkout functions) sit on top of the staff discount:
    // line discount = staff part + app part, recorded as `app_discount` facts
    // exactly as a storefront order records them (order-kernel/app-facts.ts).
    if (appDiscounts.length > 0) {
        const orderItemIdByLineId = new Map(preparedOrderItems.map(({ id }, index) => [allocationLineIds[index]!, id]));
        writeBatch.push(...buildAppDiscountFactInserts(db, {
            orderId,
            currencyCode: taxQuote.currencyCode,
            discounts: appDiscounts,
            orderItemIdByLineId,
        }) as SQLiteBatchItem[]);
    }

    // Prices set by hand are part of the order's record, in the same batch.
    const pricedByHand = data.items.filter((item) => item.unitPriceMinor !== undefined).length;
    if (pricedByHand > 0) {
        writeBatch.push(buildOrderEventInsert(db, {
            id: await orderEventIdForRequest(orderId, "prices_set", data.requestKey),
            orderId,
            kind: "prices_set",
            actorId,
            data: { lines: pricedByHand },
        }, sql`1`) as unknown as SQLiteBatchItem);
    }

    writeBatch.push(buildAdminOrderCreateAttemptCommit(db, attempt, response));

    try {
        await safeBatch(db, writeBatch);
    } catch (batchError) {
        const replay = await resolveAdminOrderCreateAttempt<{ id: string }>(
            db,
            attemptIdentity,
        ).catch(() => null);
        if (replay) return replayed(replay.response);
        if (isAdminOrderCreateAttemptGuardError(batchError)) {
            // A reclaimed request owns the same stable reservation identity.
            // Do not release stock underneath the new owner.
            throw new ConflictError(
                "Another request owns this manual-order creation. Retry the same form to recover its result.",
            );
        }

        // Inventory guards, ledger edges, counters, customer/order facts, COD,
        // tax snapshots, and idempotency evidence share this one transaction.
        // A failed batch has no reservation to compensate.
        await markAdminOrderCreateAttemptFailed(db, attempt, batchError).catch(() => undefined);
        throw batchError;
    }

    return {
        response,
        committed: {
            orderId,
            customerId: customerId!,
            paymentMethod: PaymentMethod.COD,
            totalAmountMinor: taxQuote.totalMinor,
            appDiscounts,
        },
    };
}
