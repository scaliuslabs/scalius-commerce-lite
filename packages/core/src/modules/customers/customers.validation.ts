// src/modules/customers/customers.validation.ts
// Zod schemas for customer create/update operations.
// Imported by admin API routes and CustomerService.

import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

/** Schema for creating a new customer (POST /api/customers) */
export const createCustomerSchema = z.object({
    name: z.string().min(3).max(100),
    email: z.email().nullable(),
    phone: phoneNumberSchema,
    address: z.string().max(500).nullable(),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
});

/** Schema for updating an existing customer (PUT /api/customers/:id) */
export const updateCustomerSchema = createCustomerSchema.partial();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
