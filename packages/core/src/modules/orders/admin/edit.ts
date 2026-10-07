// Editing an order's customer and delivery details.
import { safeBatch, type Database } from "@scalius/database/client";
import { orders, customerAddresses, customers, deliveryShipments, firstCustomerAddressId, FulfillmentStatus } from "@scalius/database/schema";
import { sql, eq, inArray, isNull, and } from "drizzle-orm";
import { customerAddressColumns, guestRecordForContact, resolveAddress } from "../../customers";
import { orderAddressInput, orderShippingAddressColumns } from "../shipping-address";
import { orderBillingAddressColumns, resolveStaffBillingAddress } from "../billing-address";
import { nanoid } from "nanoid";
import type { UpdateOrderDetailsInput } from "../validation";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import { validateCustomerPhoneCountry } from "../../settings";
import { getOrderEditReadiness, orderEditLockMessage } from "./readiness";
import { type SQLiteBatchItem, OPEN_ORDER_STATUSES, updateCustomerStatsService } from "./shared";

const ORDER_DETAIL_FIELDS = [
    "customerName",
    "customerPhone",
    "customerEmail",
    "shippingAddress",
    "shippingAddressLine2",
    "shippingCountryCode",
    "shippingDependentLocality",
    "shippingLocality",
    "shippingAdminArea",
    "shippingPostalCode",
    "shippingCompany",
    "shippingName",
    "shippingPhone",
    "shippingValidationSkipped",
    "city",
    "zone",
    "area",
    "billingSameAsShipping",
    "billingName",
    "billingCompany",
    "billingAddress",
    "billingAddressLine2",
    "billingCountryCode",
    "billingDependentLocality",
    "billingLocality",
    "billingAdminArea",
    "billingPostalCode",
    "billingPhone",
    "billingValidationSkipped",
] as const;

/**
 * Corrects the customer, delivery and billing details of an order that has
 * not shipped (the phone-confirmation call). Money, items and tax snapshots
 * are untouched; a changed phone links the order to that phone's customer.
 * An edit that sends no billing field keeps the order's billing address.
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
    // Only an order that ships carries an address (Wave A §2.7). Its market
    // stays the one it was placed in; only the address snapshot changes.
    const ships = order.requiresShipping !== false;
    const customerName = data.customerName.trim();
    if (ships && !data.shippingAddress?.trim()) {
        throw new ValidationError("Enter the delivery address, city and thana.");
    }
    const address = ships
        ? await resolveAddress(db, orderAddressInput(data), { skipValidation: data.skipAddressValidation === true })
        : null;
    const sendsBilling = data.billingSameAsShipping !== undefined || data.billingCountryCode !== undefined;
    const billing = sendsBilling
        ? resolveStaffBillingAddress(data, { ships, skipValidation: data.skipAddressValidation === true })
        : undefined;
    const next = {
        customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail?.trim().toLowerCase() || null,
        // The recipient and phone stay the contact's unless they differed before.
        ...orderShippingAddressColumns(
            address && { ...address, name: order.shippingName, phone: order.shippingPhone },
            { name: customerName, phone: data.customerPhone },
        ),
        ...(billing === undefined ? {} : orderBillingAddressColumns(billing, { name: customerName, phone: data.customerPhone })),
    };
    const changedFields = ORDER_DETAIL_FIELDS.filter((field) =>
        field in next && (order[field] ?? null) !== ((next as Record<string, unknown>)[field] ?? null));
    if (changedFields.length === 0) return { id: orderId, version: order.version, changedFields: [] };
    if (next.customerPhone !== order.customerPhone) {
        await validateCustomerPhoneCountry(db, next.customerPhone);
    }

    let customerId = order.customerId;
    let newCustomerId: string | null = null;
    // An order an account owns stays filed under that account; a contact
    // edit only changes the order's own contact snapshot.
    if (!order.accountOwnerCustomerId && (next.customerPhone !== order.customerPhone || !customerId)) {
        const existingCustomer = await db.select({ id: customers.id }).from(customers)
            .where(guestRecordForContact({ phone: next.customerPhone })).get();
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
            totalOrders: 1,
            lastOrderAt: sql`unixepoch()`,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }));
        // The new record's address book starts with the order's address, as at checkout.
        if (address) {
            statements.push(db.insert(customerAddresses).values({
                id: firstCustomerAddressId(newCustomerId),
                customerId: newCustomerId,
                isDefault: true,
                ...customerAddressColumns(address),
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }));
        }
    }
    statements.push(db.update(orders).set({
        ...next,
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
