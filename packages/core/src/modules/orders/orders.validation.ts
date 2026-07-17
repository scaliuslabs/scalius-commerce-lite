// src/modules/orders/orders.validation.ts
// Zod schemas for order create/update operations.
// Imported by admin API routes and OrderService.

import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

const orderContentSchema = z.object({
    customerName: z
        .string()
        .min(3, "Customer name must be at least 3 characters")
        .max(100, "Customer name must be less than 100 characters"),
    customerPhone: phoneNumberSchema,
    customerEmail: z.email().nullable(),
    shippingAddress: z
        .string()
        .min(10, "Address must be at least 10 characters")
        .max(500, "Address must be less than 500 characters"),
    city: z.string().min(1, "City is required"),
    zone: z.string().min(1, "Zone is required"),
    area: z.string().nullable(),
    cityName: z.string().optional(),
    zoneName: z.string().optional(),
    areaName: z.string().nullable().optional(),
    notes: z
        .string()
        .max(500, "Notes must be less than 500 characters")
        .nullable(),
    items: z.array(
        z.object({
            productId: z.string().min(1, "Product is required"),
            variantId: z.string().nullable(),
            quantity: z
                .number()
                .int("Quantity must be a whole number")
                .min(1, "Quantity must be at least 1")
                .max(99, "Quantity must be at most 99"),
            price: z.number().min(0, "Price must be greater than or equal to 0"),
        }),
    ),
    discountAmount: z
        .number()
        .min(0, "Discount must be greater than or equal to 0")
        .nullable(),
    shippingCharge: z
        .number()
        .min(0, "Shipping charge must be greater than or equal to 0"),
});

/** Schema for creating a new order (POST /api/orders). */
export const createOrderSchema = orderContentSchema.extend({
    requestKey: z.uuid("A valid manual-order request key is required"),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Schema for updating an existing order (PUT /api/orders/:id) */
export const updateOrderSchema = orderContentSchema.extend({
    expectedVersion: z
        .number()
        .int("Order version must be a whole number")
        .min(1, "Order version is required"),
    status: z.string().min(1, "Status is required"),
});

export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

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

export const bulkShipOrderSchema = z.object({
    orderIds: z.array(z.string()),
    providerId: z.string(),
    options: z.any().optional(),
});

export type BulkShipOrderInput = z.infer<typeof bulkShipOrderSchema>;
