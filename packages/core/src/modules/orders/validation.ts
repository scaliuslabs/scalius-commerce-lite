// src/modules/orders/validation.ts
// Zod schemas for order create/update operations.
// Imported by admin API routes and OrderService.

import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { LINE_PROPERTY_INPUT_LIMITS } from "@scalius/shared/line-properties";

export const MAX_ORDER_LINE_ITEMS = 99;

const orderBaseContentSchema = z.object({
    customerName: z
        .string()
        .min(3, "Customer name must be at least 3 characters")
        .max(100, "Customer name must be less than 100 characters"),
    customerPhone: phoneNumberSchema,
    customerEmail: z.email().nullable(),
    /**
     * Required only when something ships (a physical line with a delivery
     * method); pickup, service-only and digital orders carry none.
     */
    shippingAddress: z
        .string()
        .min(10, "Address must be at least 10 characters")
        .max(500, "Address must be less than 500 characters")
        .nullable()
        .optional(),
    city: z.string().min(1, "City is required").nullable().optional(),
    zone: z.string().min(1, "Zone is required").nullable().optional(),
    area: z.string().nullable().optional(),
    cityName: z.string().optional(),
    zoneName: z.string().optional(),
    areaName: z.string().nullable().optional(),
    notes: z
        .string()
        .max(500, "Notes must be less than 500 characters")
        .nullable(),
    discountAmount: z
        .number()
        .min(0, "Discount must be greater than or equal to 0")
        .nullable(),
    shippingCharge: z
        .number()
        .min(0, "Shipping charge must be greater than or equal to 0"),
});

/** Buyer inputs for one line, as the storefront sends them (line-item properties). */
export const orderLinePropertiesInputSchema = z.array(z.object({
    key: z.string().min(1).max(40),
    value: z.string().max(LINE_PROPERTY_INPUT_LIMITS.valueLength),
})).max(LINE_PROPERTY_INPUT_LIMITS.entries);

const sellableOrderItemSchema = z.object({
    productId: z.string().min(1, "Product is required"),
    variantId: z.string().nullable(),
    quantity: z
        .number()
        .int("Quantity must be a whole number")
        .min(1, "Quantity must be at least 1")
        .max(99, "Quantity must be at most 99"),
    /** Buyer inputs the product asks for; priced from its schema. */
    properties: orderLinePropertiesInputSchema.optional(),
});

const sellableOrderContentSchema = orderBaseContentSchema.extend({
    items: z
        .array(sellableOrderItemSchema)
        .min(1, "Add at least one sellable item")
        .max(MAX_ORDER_LINE_ITEMS, `Add at most ${MAX_ORDER_LINE_ITEMS} sellable items`),
});

/** Schema for creating a new order (POST /api/orders). */
export const createOrderSchema = sellableOrderContentSchema.extend({
    requestKey: z.uuid("A valid manual-order request key is required"),
    /**
     * The delivery method picked: a pickup method needs no address, a
     * delivery method needs one. Required when a line is physical. The charge
     * may still be edited.
     */
    shippingMethodId: z.string().trim().min(1).max(180).nullable().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * Read-only authoritative preview used by the manual-order form. Contact facts
 * are intentionally excluded: tax and money depend only on the sellable lines,
 * destination, shipping, and order-level discount.
 */
export const quoteManualOrderSchema = sellableOrderContentSchema.pick({
    city: true,
    zone: true,
    area: true,
    items: true,
    discountAmount: true,
    shippingCharge: true,
}).extend({
    /** Decides pickup vs delivery (and so whether the address is taxed). */
    shippingMethodId: z.string().trim().min(1).max(180).nullable().optional(),
});

export type QuoteManualOrderInput = z.infer<typeof quoteManualOrderSchema>;

const amendableOrderItemSchema = sellableOrderItemSchema.extend({
    orderItemId: z.string().min(1).optional(),
});

export const previewManualOrderAmendmentSchema = orderBaseContentSchema.extend({
    expectedVersion: z.number().int().min(1),
    /**
     * Kept lines (with `orderItemId`) keep their frozen buyer inputs; new lines
     * may send `properties`.
     */
    items: z.array(amendableOrderItemSchema)
        .min(1, "Add at least one sellable item")
        .max(MAX_ORDER_LINE_ITEMS, `Add at most ${MAX_ORDER_LINE_ITEMS} sellable items`),
});

export const confirmManualOrderAmendmentSchema = previewManualOrderAmendmentSchema.extend({
    requestKey: z.uuid("A valid amendment request key is required"),
    quoteFingerprint: z.string().regex(
        /^[a-f0-9]{64}$/,
        "A valid amendment quote fingerprint is required",
    ),
});

export type PreviewManualOrderAmendmentInput = z.infer<typeof previewManualOrderAmendmentSchema>;
export type ConfirmManualOrderAmendmentInput = z.infer<typeof confirmManualOrderAmendmentSchema>;

/** Customer and delivery details of an order that has not shipped yet. */
export const updateOrderDetailsSchema = orderBaseContentSchema.pick({
    customerName: true,
    customerPhone: true,
    customerEmail: true,
    shippingAddress: true,
    city: true,
    zone: true,
    area: true,
}).extend({
    expectedVersion: z.number().int().min(1),
});

export type UpdateOrderDetailsInput = z.infer<typeof updateOrderDetailsSchema>;

const orderRevisionSchema = z.object({
    id: z.string().min(1, "Order is required"),
    expectedVersion: z
        .number()
        .int("Order version must be a whole number")
        .min(1, "Order version is required"),
});

/**
 * Archive is an organizational visibility change, not a commerce-state
 * mutation. Requiring every browser-loaded revision prevents a stale list from
 * hiding an order that changed while the merchant was reviewing it.
 */
export const archiveOrdersSchema = z.object({
    orders: z
        .array(orderRevisionSchema)
        .min(1, "Select at least one order")
        .max(90, "Archive at most 90 orders at a time")
        .superRefine((entries, ctx) => {
            const seen = new Set<string>();
            entries.forEach((entry, index) => {
                if (seen.has(entry.id)) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Each order can appear only once",
                        path: [index, "id"],
                    });
                }
                seen.add(entry.id);
            });
        }),
});

export type ArchiveOrdersInput = z.infer<typeof archiveOrdersSchema>;

export const restoreOrderSchema = orderRevisionSchema.pick({ expectedVersion: true });

export type RestoreOrderInput = z.infer<typeof restoreOrderSchema>;

const shipmentResourceIdSchema = z.string().trim().min(1).max(180);

/**
 * Provider shipment inputs that a merchant may choose. Money, line count, and
 * item description are deliberately absent: those facts are derived from the
 * current order immediately before the provider call.
 */
export const shipmentCreationOptionsSchema = z.object({
    deliveryType: z.number().int().min(0).max(1_000_000).optional(),
    itemType: z.number().int().min(0).max(1_000_000).optional(),
    itemWeight: z.number().finite().positive().max(10_000).optional(),
    note: z.string().trim().max(500).optional(),
}).strict();

export type ShipmentCreationOptionsInput = z.infer<typeof shipmentCreationOptionsSchema>;

const unknownShipmentResolutionBase = z.object({
    expectedOrderVersion: z.number().int().min(1),
    operationKey: z.string().uuid(),
    evidenceSource: z.enum(["courier_portal", "courier_support"]),
    evidenceNote: z.string().trim().min(8).max(500),
    confirmationAccepted: z.literal(true),
});

export const unknownShipmentResolutionSchema = z.discriminatedUnion("outcome", [
    unknownShipmentResolutionBase.extend({
        outcome: z.literal("confirmed_existing"),
        externalId: z.string().trim().min(1).max(180),
        trackingId: z.string().trim().min(1).max(180).optional(),
    }).strict(),
    unknownShipmentResolutionBase.extend({
        outcome: z.enum(["confirmed_not_created", "confirmed_cancelled"]),
    }).strict(),
]);

export type UnknownShipmentResolutionInput = z.infer<typeof unknownShipmentResolutionSchema>;

export const bulkShipOrderSchema = z.object({
    orderIds: z
        .array(shipmentResourceIdSchema)
        .min(1, "Select at least one order")
        .max(90, "Ship at most 90 orders at a time")
        .superRefine((orderIds, ctx) => {
            const seen = new Set<string>();
            orderIds.forEach((orderId, index) => {
                if (seen.has(orderId)) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Each order can appear only once",
                        path: [index],
                    });
                }
                seen.add(orderId);
            });
        }),
    providerId: shipmentResourceIdSchema,
    options: shipmentCreationOptionsSchema.optional(),
}).strict();

export type BulkShipOrderInput = z.infer<typeof bulkShipOrderSchema>;
