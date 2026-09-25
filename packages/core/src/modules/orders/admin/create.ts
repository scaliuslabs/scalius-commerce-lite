// Staff-created (manual) orders: one guarded batch writes the order, its lines, stock reservations and receipt.
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
    ItemFulfillmentStatus,
} from "@scalius/database/schema";
import { prepareStockReservationBatch } from "../../inventory";
import type { ReservationEntry } from "../../inventory";
import { sql, eq } from "drizzle-orm";
import { guestRecordForPhone } from "../../customers/customer-identity";
import { generateOrderId } from "@scalius/shared/order-utils";
import { nanoid } from "nanoid";
import type { CreateOrderInput } from "../validation";
import { ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { computeOrderPaymentState } from "../../payments/payment-state";
import { createCODTrackingInsertValues } from "../../payments/cod";
import { validateCustomerPhoneCountry } from "../../settings/phone-country-policy";
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
import type { SQLiteBatchItem } from "./shared";

// Bound values per multi-row insert row (drizzle binds every column,
// defaults included); D1 allows 100 per statement.
const ORDER_ITEM_INSERT_PARAMETERS_PER_ROW = 21;
const ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW = 6;

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
    const attemptIdentity = await buildAdminOrderCreateAttemptIdentity(data, actorId);
    const existingReplay = await resolveAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (existingReplay) return existingReplay.response;
    await validateCustomerPhoneCountry(db, data.customerPhone);
    const claim = await claimAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (claim.status === "replay") return claim.response;
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
        const manualQuote = await prepareManualOrderQuote(db, data);
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
        } = manualQuote;
        const shippingAddress = requiresShipping ? data.shippingAddress?.trim() ?? "" : null;
        if (requiresShipping && !shippingAddress) {
            throw new ValidationError("Enter the delivery address, or choose a pickup method.");
        }
        const initialPaymentState = computeOrderPaymentState({
            totalAmountMinor: taxQuote.totalMinor,
            paidAmountMinor: 0,
        });
        const existingCustomer = await db
            .select()
            .from(customers)
            .where(guestRecordForPhone(data.customerPhone))
            .get();
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
        };
    })().catch(async (error) => {
        await markAdminOrderCreateAttemptFailed(db, attempt, error).catch(() => undefined);
        throw error;
    });
    const {
        initialPaymentState,
        address,
        shippingAddress,
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
        writeBatch.push(
            db.insert(customers).values({
                id: customerId,
                name: data.customerName,
                phone: data.customerPhone,
                email: data.customerEmail,
                address: shippingAddress,
                city: address?.city ?? null,
                zone: address?.zone ?? null,
                area: address?.area ?? null,
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
                address: shippingAddress,
                city: address?.city ?? null,
                zone: address?.zone ?? null,
                area: address?.area ?? null,
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
            orderNumber: nextOrderNumberSql(),
            id: orderId,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail,
            shippingAddress,
            city: address?.city ?? null,
            zone: address?.zone ?? null,
            area: address?.area ?? null,
            cityName,
            zoneName,
            areaName,
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
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            paidAmountMinor: initialPaymentState.paidAmountMinor,
            balanceDueMinor: initialPaymentState.balanceDueMinor,
            paymentStatus: initialPaymentState.paymentStatus,
            paymentMethod: PaymentMethod.COD,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            status: OrderStatus.CONFIRMED,
            customerId,
            inventoryAction: reservationEntries.length > 0 ? "reserved" : "none",
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
            fulfillmentStatus: ItemFulfillmentStatus.PENDING,
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
            taxClassId: lineTax.taxClassId,
            taxClassName: lineTax.taxClassName,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            rateSnapshot: JSON.stringify(lineTax.components),
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
            currencyCode: taxQuote.currencyCode,
            decimalPlaces: taxQuote.decimalPlaces,
            displayLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            shippingTaxed: taxQuote.shippingTaxed,
            settingsVersion: taxQuote.settingsVersion,
            calculationVersion: taxQuote.calculationVersion,
            destinationSnapshot: JSON.stringify(taxQuote.destination),
            rateSnapshot: JSON.stringify({
                lines: taxQuote.lines.map((line) => ({
                    lineId: line.lineId,
                    taxClassId: line.taxClassId,
                    taxClassName: line.taxClassName,
                    components: line.components,
                })),
                shipping: taxQuote.shipping,
            }),
            createdAt: sql`unixepoch()`,
        }),
    );

    writeBatch.push(buildAdminOrderCreateAttemptCommit(db, attempt, response));

    try {
        await safeBatch(db, writeBatch);
    } catch (batchError) {
        const replay = await resolveAdminOrderCreateAttempt<{ id: string }>(
            db,
            attemptIdentity,
        ).catch(() => null);
        if (replay) return replay.response;
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

    return response;
}
