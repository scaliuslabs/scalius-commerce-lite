// Editing an order's customer and delivery details.
import { safeBatch, type Database } from "@scalius/database/client";
import { orders, customers, deliveryShipments, FulfillmentStatus } from "@scalius/database/schema";
import { sql, eq, inArray, isNull, and } from "drizzle-orm";
import { guestRecordForPhone } from "../../customers/customer-identity";
import { nanoid } from "nanoid";
import type { UpdateOrderDetailsInput } from "../validation";
import { NotFoundError, ConflictError } from "@scalius/core/errors";
import { validateCustomerPhoneCountry } from "../../settings/phone-country-policy";
import { resolveActiveDeliveryLocationNames } from "../../delivery/location-validation";
import { getOrderEditReadiness, orderEditLockMessage } from "./readiness";
import { type SQLiteBatchItem, OPEN_ORDER_STATUSES, updateCustomerStatsService } from "./shared";

const ORDER_DETAIL_FIELDS = [
    "customerName",
    "customerPhone",
    "customerEmail",
    "shippingAddress",
    "city",
    "zone",
    "area",
] as const;

/**
 * Corrects the customer and delivery details of an order that has not shipped
 * (the phone-confirmation call). Money, items and tax snapshots are untouched;
 * a changed phone links the order to that phone's customer.
 */
export async function updateOrderDetails(
    db: Database,
    orderId: string,
    data: UpdateOrderDetailsInput,
): Promise<{ id: string; version: number; changedFields: string[] }> {
    const order = await db.select().from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
        .get();
    if (!order) throw new NotFoundError("Order not found");
    if (order.version !== data.expectedVersion) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }
    const readiness = await getOrderEditReadiness(db, orderId);
    if (!readiness?.details.allowed) {
        throw new ConflictError(orderEditLockMessage(readiness?.details.reason ?? null));
    }
    const next = {
        customerName: data.customerName.trim(),
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail?.trim().toLowerCase() || null,
        shippingAddress: data.shippingAddress.trim(),
        city: data.city,
        zone: data.zone,
        area: data.area,
    };
    const changedFields = ORDER_DETAIL_FIELDS.filter((field) => (order[field] ?? null) !== next[field]);
    if (changedFields.length === 0) return { id: orderId, version: order.version, changedFields: [] };
    if (next.customerPhone !== order.customerPhone) {
        await validateCustomerPhoneCountry(db, next.customerPhone);
    }
    const locationNames = await resolveActiveDeliveryLocationNames(db, next);

    let customerId = order.customerId;
    let newCustomerId: string | null = null;
    // An order an account owns stays filed under that account; a contact
    // edit only changes the order's own contact snapshot.
    if (!order.accountOwnerCustomerId && (next.customerPhone !== order.customerPhone || !customerId)) {
        const existingCustomer = await db.select({ id: customers.id }).from(customers)
            .where(guestRecordForPhone(next.customerPhone)).get();
        customerId = existingCustomer?.id ?? `cust_${nanoid()}`;
        if (!existingCustomer) newCustomerId = customerId;
    }

    const resultingVersion = order.version + 1;
    const statements: SQLiteBatchItem[] = [];
    if (newCustomerId) {
        statements.push(db.insert(customers).values({
            id: newCustomerId,
            name: next.customerName,
            email: next.customerEmail,
            phone: next.customerPhone,
            address: next.shippingAddress,
            city: next.city,
            zone: next.zone,
            area: next.area,
            ...locationNames,
            totalOrders: 1,
            lastOrderAt: sql`unixepoch()`,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }));
    }
    statements.push(db.update(orders).set({
        ...next,
        ...locationNames,
        customerId,
        version: resultingVersion,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, order.version),
        isNull(orders.archivedAt),
        inArray(orders.status, [...OPEN_ORDER_STATUSES]),
        eq(orders.fulfillmentStatus, FulfillmentStatus.PENDING),
        isNull(orders.shipmentClaimId),
        sql`NOT EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.orderId} = ${orderId})`,
    )).returning({ id: orders.id }));
    const results = await safeBatch(db, statements as never) as unknown[][];
    if ((results.at(-1) ?? []).length === 0) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }
    if (order.customerId) await updateCustomerStatsService(db, order.customerId);
    if (customerId && customerId !== order.customerId) await updateCustomerStatsService(db, customerId);
    return { id: orderId, version: resultingVersion, changedFields: [...changedFields] };
}
