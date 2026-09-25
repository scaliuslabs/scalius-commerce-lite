// Manual COD order amendments: preview and confirm a line change under the order version.
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    orderAmendments,
    orderInvoices,
    orderReturns,
    orderTaxSnapshots,
    orderItemTaxSnapshots,
    customers,
    customerHistory,
    deliveryShipments,
    paymentSessionAttempts,
    orderPayments,
    codTracking,
    refundAttempts,
    paymentPlans,
    orderDiscountAllocations,
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
    FulfillmentStatus,
    ItemFulfillmentStatus,
} from "@scalius/database/schema";
import {
    prepareStockReservationBatch,
    prepareReservedStockReleaseBatch,
    isInventoryReservationConflictError,
    isPreparedReservedStockReleaseConflictError,
    type ReservationEntry,
} from "../../inventory";
import { sql, eq, inArray, isNull, and } from "drizzle-orm";
import { guestRecordForPhone } from "../../customers/customer-identity";
import { fromMinor } from "@scalius/shared/money";
import { nanoid } from "nanoid";
import type {
    ConfirmManualOrderAmendmentInput,
    PreviewManualOrderAmendmentInput,
} from "../validation";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { recordOrderEvent } from "../timeline";
import { resolveOrderCurrencySnapshot } from "../../payments/order-currency";
import { validateCustomerPhoneCountry } from "../../settings/phone-country-policy";
import type { TaxQuote } from "../../tax/browser";
import { sha256Hex, stableStringify } from "./create-attempts";
import { type ManualOrderQuote, prepareManualOrderQuote } from "./quote";
import { getOrderEditReadiness, orderEditLockMessage } from "./readiness";
import { type SQLiteBatchItem, updateCustomerStatsService } from "./shared";

const ORDER_AMENDMENT_GUARD_MARKER = "ORDER_AMENDMENT_CONFLICT";

export interface ManualOrderAmendmentPreview extends ManualOrderQuote {
    orderId: string;
    expectedVersion: number;
    resultingVersion: number;
    balanceDue: number;
    quoteFingerprint: string;
}

export interface ManualOrderAmendmentResult {
    id: string;
    version: number;
    totalAmount: number;
    balanceDue: number;
    inventoryMutationVariantIds: string[];
}

function normalizeAmendmentRequest(
    orderId: string,
    data: PreviewManualOrderAmendmentInput & { quoteFingerprint?: string },
): Record<string, unknown> {
    return {
        version: 1,
        orderId,
        expectedVersion: data.expectedVersion,
        customerName: data.customerName.trim(),
        customerPhone: data.customerPhone.trim(),
        customerEmail: data.customerEmail?.trim().toLowerCase() ?? null,
        shippingAddress: data.shippingAddress?.trim() || null,
        city: data.city ?? null,
        zone: data.zone ?? null,
        area: data.area ?? null,
        notes: data.notes,
        items: data.items.map((item) => ({
            orderItemId: item.orderItemId ?? null,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            ...(item.properties && item.properties.length > 0
                ? { properties: item.properties.map((property) => [property.key, property.value]) }
                : {}),
        })),
        shippingCharge: data.shippingCharge,
        discountAmount: data.discountAmount,
        quoteFingerprint: data.quoteFingerprint ?? null,
    };
}

async function buildManualOrderAmendmentQuoteFingerprint(
    taxQuote: TaxQuote,
): Promise<string> {
    return sha256Hex(stableStringify({
        version: 1,
        calculationVersion: taxQuote.calculationVersion,
        enabled: taxQuote.enabled,
        currencyCode: taxQuote.currencyCode,
        decimalPlaces: taxQuote.decimalPlaces,
        pricesIncludeTax: taxQuote.pricesIncludeTax,
        shippingTaxed: taxQuote.shippingTaxed,
        settingsVersion: taxQuote.settingsVersion,
        subtotalMinor: taxQuote.subtotalMinor,
        shippingMinor: taxQuote.shippingMinor,
        discountMinor: taxQuote.discountMinor,
        taxableMinor: taxQuote.taxableMinor,
        taxMinor: taxQuote.taxMinor,
        totalMinor: taxQuote.totalMinor,
        lines: taxQuote.lines,
        shipping: taxQuote.shipping,
    }));
}

async function requireAmendableOrder(
    db: Database,
    orderId: string,
    expectedVersion: number,
) {
    const order = await db.select().from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt), isNull(orders.archivedAt)))
        .get();
    if (!order) throw new NotFoundError("Order not found");
    if (order.version !== expectedVersion) {
        throw new ConflictError(
            "This order changed after you opened it. Reload and review the latest values.",
        );
    }
    const readiness = await getOrderEditReadiness(db, orderId);
    if (!readiness?.items.allowed) {
        throw new ConflictError(orderEditLockMessage(readiness?.items.reason ?? null));
    }
    return order;
}

/**
 * Lines the merchant keeps on an amended order keep the price and buyer
 * inputs the customer agreed to; only newly added lines take today's catalog
 * price and resolve their inputs against today's schema.
 */
async function loadRetainedUnitPrices(db: Database, orderId: string) {
    const rows = await db.select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        unitPriceMinor: orderItems.unitPriceMinor,
        fulfillmentType: orderItems.fulfillmentType,
        properties: orderItems.properties,
        propertiesPriceMinor: orderItems.propertiesPriceMinor,
        baseUnitPriceMinor: orderItems.baseUnitPriceMinor,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    return new Map(rows.map((row) => [row.id, row]));
}

/** An amendment keeps the order's one delivery method (Wave A §2.7). */
function amendmentDeliveryMethodKind(order: {
    shippingMethodKind: string | null;
    requiresShipping: boolean;
}): "delivery" | "pickup" | null {
    if (order.shippingMethodKind === "delivery" || order.shippingMethodKind === "pickup") {
        return order.shippingMethodKind;
    }
    // Orders placed before Wave A shipped everything.
    return order.requiresShipping ? "delivery" : null;
}

function requireAmendmentAddress(
    data: PreviewManualOrderAmendmentInput,
    prepared: { requiresShipping: boolean },
): string | null {
    if (!prepared.requiresShipping) return null;
    const address = data.shippingAddress?.trim();
    if (!address) throw new ValidationError("Enter the delivery address.");
    return address;
}

export async function previewManualOrderAmendment(
    db: Database,
    orderId: string,
    data: PreviewManualOrderAmendmentInput,
): Promise<ManualOrderAmendmentPreview> {
    const order = await requireAmendableOrder(db, orderId, data.expectedVersion);
    if (data.customerPhone !== order.customerPhone) {
        await validateCustomerPhoneCountry(db, data.customerPhone);
    }
    const prepared = await prepareManualOrderQuote(
        db,
        data,
        resolveOrderCurrencySnapshot(order),
        await loadRetainedUnitPrices(db, orderId),
        { fixedDeliveryMethodKind: amendmentDeliveryMethodKind(order) },
    );
    requireAmendmentAddress(data, prepared);
    const quoteFingerprint = await buildManualOrderAmendmentQuoteFingerprint(prepared.taxQuote);
    return {
        ...prepared.quote,
        orderId,
        expectedVersion: data.expectedVersion,
        resultingVersion: data.expectedVersion + 1,
        balanceDue: prepared.quote.totalAmount,
        quoteFingerprint,
    };
}

function amendmentCommitGuard(orderId: string, expectedVersion: number) {
    return sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${orderId}
          AND ${orders.version} = ${expectedVersion}
          AND ${orders.deletedAt} IS NULL
          AND ${orders.archivedAt} IS NULL
          AND ${orders.paymentMethod} = ${PaymentMethod.COD}
          AND ${orders.paymentStatus} = ${PaymentStatus.UNPAID}
          AND ${orders.paidAmountMinor} = 0
          AND ${orders.fulfillmentStatus} = ${FulfillmentStatus.PENDING}
          AND ${orders.status} IN (${OrderStatus.PENDING}, ${OrderStatus.PROCESSING}, ${OrderStatus.CONFIRMED})
          AND ${orders.shipmentClaimId} IS NULL
          AND ${orders.inventoryAction} IN ('reserved', 'none')
          AND EXISTS (
            SELECT 1 FROM ${orderTaxSnapshots}
            WHERE ${orderTaxSnapshots.orderId} = ${orderId}
          )
          AND EXISTS (
            SELECT 1 FROM ${codTracking}
            WHERE ${codTracking.orderId} = ${orderId}
              AND ${codTracking.codStatus} = 'pending'
              AND ${codTracking.collectedAt} IS NULL
              AND COALESCE(${codTracking.collectedAmountMinor}, 0) = 0
          )
          AND NOT EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${paymentSessionAttempts} WHERE ${paymentSessionAttempts.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${paymentPlans} WHERE ${paymentPlans.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${refundAttempts} WHERE ${refundAttempts.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${orderReturns} WHERE ${orderReturns.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${orderInvoices} WHERE ${orderInvoices.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${orderDiscountAllocations} WHERE ${orderDiscountAllocations.orderId} = ${orderId})
          AND NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            WHERE ${orderItems.orderId} = ${orderId}
              AND (${orderItems.fulfillmentStatus} <> ${ItemFulfillmentStatus.PENDING}
                OR ${orderItems.fulfilledQuantity} > 0)
          )
    )`;
}

async function resolveManualOrderAmendmentReplay(
    db: Database,
    keyHash: string,
    requestHash: string,
): Promise<ManualOrderAmendmentResult | null> {
    const row = await db.select({
        requestHash: orderAmendments.requestHash,
        responsePayload: orderAmendments.responsePayload,
    }).from(orderAmendments)
        .where(eq(orderAmendments.idempotencyKeyHash, keyHash))
        .get();
    if (!row) return null;
    if (row.requestHash !== requestHash) {
        throw new ConflictError("This amendment request key was already used for different changes.");
    }
    try {
        return JSON.parse(row.responsePayload) as ManualOrderAmendmentResult;
    } catch {
        throw new ServiceUnavailableError(
            "The confirmed amendment response is unavailable. Reload the order before retrying.",
        );
    }
}

export async function confirmManualOrderAmendment(
    db: Database,
    orderId: string,
    data: ConfirmManualOrderAmendmentInput,
    actorId: string | null,
): Promise<ManualOrderAmendmentResult> {
    const actorScope = actorId ?? "unknown-admin";
    const keyHash = await sha256Hex(`${actorScope}:${data.requestKey.trim()}`);
    const requestHash = await sha256Hex(stableStringify(
        normalizeAmendmentRequest(orderId, data),
    ));
    const replay = await resolveManualOrderAmendmentReplay(db, keyHash, requestHash);
    if (replay) return replay;

    const order = await requireAmendableOrder(db, orderId, data.expectedVersion);
    if (data.customerPhone !== order.customerPhone) {
        await validateCustomerPhoneCountry(db, data.customerPhone);
    }
    const prepared = await prepareManualOrderQuote(
        db,
        data,
        resolveOrderCurrencySnapshot(order),
        await loadRetainedUnitPrices(db, orderId),
        { fixedDeliveryMethodKind: amendmentDeliveryMethodKind(order) },
    );
    const shippingAddress = requireAmendmentAddress(data, prepared);
    const destination = prepared.address;
    const currentQuoteFingerprint = await buildManualOrderAmendmentQuoteFingerprint(prepared.taxQuote);
    if (currentQuoteFingerprint !== data.quoteFingerprint) {
        throw new ConflictError(
            "Prices or taxes changed after preview. Refresh the quote and review the updated COD total.",
        );
    }
    const existingItems = await db.select().from(orderItems)
        .where(eq(orderItems.orderId, orderId));
    const existingTaxSnapshot = await db.select().from(orderTaxSnapshots)
        .where(eq(orderTaxSnapshots.orderId, orderId)).get();
    const existingItemTaxSnapshots = await db.select().from(orderItemTaxSnapshots)
        .where(eq(orderItemTaxSnapshots.orderId, orderId));
    if (!existingTaxSnapshot) throw new ConflictError("The order tax snapshot is unavailable.");
    if (
        existingItemTaxSnapshots.length !== existingItems.length
        || existingItems.some((item) => !existingItemTaxSnapshots.some(
            (snapshot) => snapshot.orderItemId === item.id,
        ))
    ) {
        throw new ConflictError("An order line tax snapshot is unavailable.");
    }

    const existingById = new Map(existingItems.map((item) => [item.id, item]));
    const retainedIds = new Set<string>();
    const preparedItems = prepared.trackedItems.map((item, index) => {
        const requested = data.items[index]!;
        const existing = requested.orderItemId
            ? existingById.get(requested.orderItemId)
            : undefined;
        if (requested.orderItemId && (
            !existing
            || existing.productId !== item.productId
            || existing.variantId !== item.variantId
            || retainedIds.has(requested.orderItemId)
        )) {
            throw new ConflictError("An amended line no longer matches the loaded order. Reload and review it.");
        }
        const id = existing?.id ?? `item_${nanoid()}`;
        retainedIds.add(id);
        const lineTax = prepared.taxQuote.lines.find(
            (line) => line.lineId === prepared.allocationLineIds[index],
        );
        if (!lineTax) throw new ValidationError("Authoritative tax quote is missing an amendment line.");
        return { id, item, lineTax, retained: Boolean(existing) };
    });

    const pool = (order.inventoryPool as NonNullable<ReservationEntry["pool"]>) ?? "regular";
    const oldEntries = buildInventoryEntries(existingItems, pool);
    const newEntries = buildInventoryEntries(prepared.trackedItems, pool);
    const { positiveEntries, negativeEntries } = computeInventoryDeltas(oldEntries, newEntries, pool);
    const inventoryKey = `order-amendment:v1:${keyHash}`;
    const reservePlan = await prepareStockReservationBatch(
        db,
        toReservationBatchItems(positiveEntries, orderId),
        pool,
        { reservationKey: inventoryKey },
    );
    if (!reservePlan.success) {
        throw new ValidationError(reservePlan.error ?? "Insufficient stock for this amendment.");
    }
    const releasePlan = await prepareReservedStockReleaseBatch(
        db,
        negativeEntries,
        orderId,
        { releaseKey: inventoryKey, requireExact: true },
    );
    if (!releasePlan.success) {
        throw new ConflictError(
            releasePlan.error ?? "The existing reservation must be reconciled before amending.",
        );
    }

    let customerId = order.customerId;
    let newCustomerId: string | null = null;
    // An order an account owns stays filed under that account; a contact
    // edit only changes the order's own contact snapshot.
    if (!order.accountOwnerCustomerId && (data.customerPhone !== order.customerPhone || !customerId)) {
        const existingCustomer = await db.select({ id: customers.id }).from(customers)
            .where(guestRecordForPhone(data.customerPhone)).get();
        customerId = existingCustomer?.id ?? `cust_${nanoid()}`;
        if (!existingCustomer) newCustomerId = customerId;
    }

    const resultingVersion = data.expectedVersion + 1;
    const totalAmount = prepared.quote.totalAmount;
    const response: ManualOrderAmendmentResult = {
        id: orderId,
        version: resultingVersion,
        totalAmount,
        balanceDue: totalAmount,
        inventoryMutationVariantIds: [...new Set([
            ...positiveEntries.map((entry) => entry.variantId),
            ...negativeEntries.map((entry) => entry.variantId),
        ])],
    };
    const beforeSnapshot = JSON.stringify({
        order,
        items: existingItems,
        tax: existingTaxSnapshot,
        itemTaxes: existingItemTaxSnapshots,
    });
    const afterSnapshot = JSON.stringify({
        order: {
            ...normalizeAmendmentRequest(orderId, data),
            version: resultingVersion,
            currencyCode: prepared.taxQuote.currencyCode,
            currencyDecimalPlaces: prepared.taxQuote.decimalPlaces,
            subtotalAmountMinor: prepared.taxQuote.subtotalMinor,
            shippingAmountMinor: prepared.taxQuote.shippingMinor,
            discountAmountMinor: prepared.taxQuote.discountMinor,
            taxAmountMinor: prepared.taxQuote.taxMinor,
            totalAmountMinor: prepared.taxQuote.totalMinor,
            balanceDueMinor: prepared.taxQuote.totalMinor,
        },
        items: preparedItems.map(({ id, item, lineTax }) => ({ id, ...item, lineTax })),
    });

    const statements: SQLiteBatchItem[] = [
        buildBatchGuard(
            db,
            amendmentCommitGuard(orderId, data.expectedVersion),
            ORDER_AMENDMENT_GUARD_MARKER,
        ),
        ...reservePlan.statements,
        ...releasePlan.statements,
    ];
    if (newCustomerId) {
        statements.push(db.insert(customers).values({
            id: newCustomerId,
            name: data.customerName,
            email: data.customerEmail,
            phone: data.customerPhone,
            address: shippingAddress,
            city: destination?.city ?? null,
            zone: destination?.zone ?? null,
            area: destination?.area ?? null,
            cityName: prepared.locationNames.cityName,
            zoneName: prepared.locationNames.zoneName,
            areaName: prepared.locationNames.areaName,
            totalOrders: 1,
            lastOrderAt: sql`unixepoch()`,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }));
        statements.push(db.insert(customerHistory).values({
            id: `hist_${nanoid()}`,
            customerId: newCustomerId,
            name: data.customerName,
            email: data.customerEmail,
            phone: data.customerPhone,
            address: shippingAddress,
            city: destination?.city ?? null,
            zone: destination?.zone ?? null,
            area: destination?.area ?? null,
            cityName: prepared.locationNames.cityName,
            zoneName: prepared.locationNames.zoneName,
            areaName: prepared.locationNames.areaName,
            changeType: "created",
                actor: "staff",
            createdAt: sql`unixepoch()`,
        }));
    }
    statements.push(
        db.insert(orderAmendments).values({
            id: `oamd_${crypto.randomUUID()}`,
            orderId,
            actorId,
            idempotencyKeyHash: keyHash,
            requestHash,
            expectedVersion: data.expectedVersion,
            resultingVersion,
            beforeSnapshot,
            afterSnapshot,
            responsePayload: JSON.stringify(response),
            createdAt: sql`unixepoch()`,
        }),
        db.update(orders).set({
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail,
            shippingAddress,
            city: destination?.city ?? null,
            zone: destination?.zone ?? null,
            area: destination?.area ?? null,
            cityName: prepared.locationNames.cityName,
            zoneName: prepared.locationNames.zoneName,
            areaName: prepared.locationNames.areaName,
            requiresShipping: prepared.requiresShipping,
            notes: data.notes,
            currencyCode: prepared.taxQuote.currencyCode,
            currencyDecimalPlaces: prepared.taxQuote.decimalPlaces,
            subtotalAmountMinor: prepared.taxQuote.subtotalMinor,
            shippingAmountMinor: prepared.taxQuote.shippingMinor,
            discountAmountMinor: prepared.taxQuote.discountMinor,
            taxAmountMinor: prepared.taxQuote.taxMinor,
            totalAmountMinor: prepared.taxQuote.totalMinor,
            taxLabel: prepared.taxQuote.displayLabel,
            pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
            paidAmountMinor: 0,
            balanceDueMinor: prepared.taxQuote.totalMinor,
            paymentStatus: PaymentStatus.UNPAID,
            customerId,
            inventoryAction: newEntries.length > 0 ? "reserved" : "none",
            version: resultingVersion,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, data.expectedVersion),
            amendmentCommitGuard(orderId, data.expectedVersion),
        )),
    );

    for (const preparedItem of preparedItems) {
        const itemValues = {
            productId: preparedItem.item.productId,
            variantId: preparedItem.item.variantId,
            productImageMediaId: preparedItem.item.productImageMediaId,
            quantity: preparedItem.item.quantity,
            productName: preparedItem.item.productName,
            variantLabel: preparedItem.item.variantLabel,
            inventoryTracked: preparedItem.item.inventoryTracked,
            unitPriceMinor: preparedItem.lineTax.unitPriceMinor,
            lineSubtotalMinor: preparedItem.lineTax.grossAmountMinor,
            discountAmountMinor: preparedItem.lineTax.discountMinor,
            taxableAmountMinor: preparedItem.lineTax.taxableAmountMinor,
            taxAmountMinor: preparedItem.lineTax.taxMinor,
            fulfillmentStatus: ItemFulfillmentStatus.PENDING,
        };
        if (preparedItem.retained) {
            statements.push(
                db.update(orderItems).set(itemValues).where(and(
                    eq(orderItems.id, preparedItem.id),
                    eq(orderItems.orderId, orderId),
                )),
                db.update(orderItemTaxSnapshots).set({
                    taxClassId: preparedItem.lineTax.taxClassId,
                    taxClassName: preparedItem.lineTax.taxClassName,
                    pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
                    rateSnapshot: JSON.stringify(preparedItem.lineTax.components),
                    createdAt: sql`unixepoch()`,
                }).where(and(
                    eq(orderItemTaxSnapshots.orderItemId, preparedItem.id),
                    eq(orderItemTaxSnapshots.orderId, orderId),
                )),
            );
        } else {
            statements.push(
                db.insert(orderItems).values({
                    id: preparedItem.id,
                    orderId,
                    ...itemValues,
                    fulfillmentType: preparedItem.item.fulfillmentType,
                    properties: preparedItem.item.properties,
                    propertiesPriceMinor: preparedItem.item.propertiesPriceMinor,
                    baseUnitPriceMinor: preparedItem.item.baseUnitPriceMinor,
                    createdAt: sql`unixepoch()`,
                }),
                db.insert(orderItemTaxSnapshots).values({
                    orderItemId: preparedItem.id,
                    orderId,
                    taxClassId: preparedItem.lineTax.taxClassId,
                    taxClassName: preparedItem.lineTax.taxClassName,
                    pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
                    rateSnapshot: JSON.stringify(preparedItem.lineTax.components),
                    createdAt: sql`unixepoch()`,
                }),
            );
        }
    }
    const removedIds = existingItems
        .filter((item) => !retainedIds.has(item.id))
        .map((item) => item.id);
    if (removedIds.length > 0) {
        statements.push(db.delete(orderItems).where(and(
            eq(orderItems.orderId, orderId),
            inArray(orderItems.id, removedIds),
        )));
    }
    statements.push(
        db.update(orderTaxSnapshots).set({
            currencyCode: prepared.taxQuote.currencyCode,
            decimalPlaces: prepared.taxQuote.decimalPlaces,
            displayLabel: prepared.taxQuote.displayLabel,
            pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
            shippingTaxed: prepared.taxQuote.shippingTaxed,
            settingsVersion: prepared.taxQuote.settingsVersion,
            calculationVersion: prepared.taxQuote.calculationVersion,
            destinationSnapshot: JSON.stringify(prepared.taxQuote.destination),
            rateSnapshot: JSON.stringify({
                lines: prepared.taxQuote.lines.map((line) => ({
                    lineId: line.lineId,
                    taxClassId: line.taxClassId,
                    taxClassName: line.taxClassName,
                    components: line.components,
                })),
                shipping: prepared.taxQuote.shipping,
            }),
            createdAt: sql`unixepoch()`,
        }).where(eq(orderTaxSnapshots.orderId, orderId)),
        db.update(codTracking).set({ updatedAt: sql`unixepoch()` })
            .where(and(eq(codTracking.orderId, orderId), eq(codTracking.codStatus, "pending"))),
        buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${orders}
            INNER JOIN ${orderAmendments} ON ${orderAmendments.orderId} = ${orders.id}
            WHERE ${orders.id} = ${orderId}
              AND ${orders.version} = ${resultingVersion}
              AND ${orderAmendments.idempotencyKeyHash} = ${keyHash}
              AND ${orderAmendments.resultingVersion} = ${resultingVersion}
        )`, ORDER_AMENDMENT_GUARD_MARKER),
    );

    try {
        await safeBatch(db, statements);
    } catch (error) {
        const raceReplay = await resolveManualOrderAmendmentReplay(db, keyHash, requestHash);
        if (raceReplay) return raceReplay;
        if (
            isBatchGuardError(error, ORDER_AMENDMENT_GUARD_MARKER)
            || isInventoryReservationConflictError(error)
            || isPreparedReservedStockReleaseConflictError(error)
        ) {
            throw new ConflictError(
                "This order changed while the amendment was being confirmed. Reload and review it.",
            );
        }
        throw error;
    }

    await recordOrderEvent(db, {
        orderId,
        kind: "items_edited",
        actorId,
        data: {
            previousTotal: fromMinor(order.totalAmountMinor, order.currencyDecimalPlaces),
            total: totalAmount,
        },
    });
    if (order.customerId) await updateCustomerStatsService(db, order.customerId);
    if (customerId && customerId !== order.customerId) {
        await updateCustomerStatsService(db, customerId);
    }
    return response;
}

function buildInventoryEntries(
    items: { variantId: string | null; quantity: number; inventoryTracked?: boolean }[],
    pool: NonNullable<ReservationEntry["pool"]>,
): ReservationEntry[] {
    const merged = new Map<string, number>();
    for (const item of items) {
        if (!item.variantId || item.inventoryTracked === false) continue;
        merged.set(item.variantId, (merged.get(item.variantId) ?? 0) + item.quantity);
    }
    return Array.from(merged.entries()).map(([variantId, quantity]) => ({ variantId, quantity, pool }));
}

function computeInventoryDeltas(
    oldEntries: ReservationEntry[],
    newEntries: ReservationEntry[],
    pool: NonNullable<ReservationEntry["pool"]>,
): { positiveEntries: ReservationEntry[]; negativeEntries: ReservationEntry[] } {
    const deltaMap = new Map<string, number>();
    for (const entry of oldEntries) {
        deltaMap.set(entry.variantId, (deltaMap.get(entry.variantId) ?? 0) - entry.quantity);
    }
    for (const entry of newEntries) {
        deltaMap.set(entry.variantId, (deltaMap.get(entry.variantId) ?? 0) + entry.quantity);
    }

    const positiveEntries: ReservationEntry[] = [];
    const negativeEntries: ReservationEntry[] = [];
    for (const [variantId, delta] of deltaMap) {
        if (delta > 0) {
            positiveEntries.push({ variantId, quantity: delta, pool });
        } else if (delta < 0) {
            negativeEntries.push({ variantId, quantity: Math.abs(delta), pool });
        }
    }

    return { positiveEntries, negativeEntries };
}

function toReservationBatchItems(entries: ReservationEntry[], orderId: string) {
    return entries.map((entry) => ({
        variantId: entry.variantId,
        quantity: entry.quantity,
        orderId,
    }));
}
