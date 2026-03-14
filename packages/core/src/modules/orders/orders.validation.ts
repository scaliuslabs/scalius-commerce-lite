// src/modules/orders/orders.validation.ts
// Zod schemas for order create/update operations.
// Imported by admin API routes and OrderService.

import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

/** Schema for creating a new order (POST /api/orders) */
export const createOrderSchema = z.object({
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
            quantity: z.number().min(1, "Quantity must be at least 1"),
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

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Schema for updating an existing order (PUT /api/orders/:id) */
export const updateOrderSchema = createOrderSchema.extend({
    status: z.string().min(1, "Status is required"),
});

export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export const bulkDeleteOrderSchema = z.object({
    orderIds: z.array(z.string()),
    permanent: z.boolean().default(false),
});

export type BulkDeleteOrderInput = z.infer<typeof bulkDeleteOrderSchema>;

export const bulkShipOrderSchema = z.object({
    orderIds: z.array(z.string()),
    providerId: z.string(),
    options: z.any().optional(),
});

export type BulkShipOrderInput = z.infer<typeof bulkShipOrderSchema>;
