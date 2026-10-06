// src/modules/customers/customers.validation.ts
// Zod schemas for customer and address writes.
// Imported by admin API routes and CustomerService.

import { z } from "zod";
import { ADDRESS_FIELD_MAX_LENGTH } from "@scalius/shared/address";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

const text = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * A postal address as the dashboard, agents and the account page send it
 * (MARKETS-DESIGN D7): canonical fields, the recipient's phone (read in the
 * address country) and, in Bangladesh, the City/Thana/Area location ids.
 * The country's rules decide what is required (`resolveAddress`).
 */
export const addressInputSchema = z.object({
    /** ISO 3166-1 alpha-2. Absent means Bangladesh (its City/Thana/Area form sends none). */
    countryCode: z.string().trim().min(2).max(2).nullable().optional(),
    name: text(ADDRESS_FIELD_MAX_LENGTH.name),
    company: text(ADDRESS_FIELD_MAX_LENGTH.company),
    line1: text(ADDRESS_FIELD_MAX_LENGTH.line1),
    line2: text(ADDRESS_FIELD_MAX_LENGTH.line2),
    dependentLocality: text(ADDRESS_FIELD_MAX_LENGTH.dependentLocality),
    locality: text(ADDRESS_FIELD_MAX_LENGTH.locality),
    adminArea: text(ADDRESS_FIELD_MAX_LENGTH.adminArea),
    postalCode: text(ADDRESS_FIELD_MAX_LENGTH.postalCode),
    phone: text(32),
    city: text(180),
    zone: text(180),
    area: text(180),
}).strict();

/** An address-book write: the address, whether it becomes the default, and (staff only) skipping its rules. */
export const customerAddressInputSchema = addressInputSchema.extend({
    isDefault: z.boolean().optional(),
    skipValidation: z.boolean().optional(),
}).strict();

/**
 * Schema for creating a new customer (POST /api/customers). The phone may be
 * null only for a customer with an email, when the store lets digital and
 * service orders go without a phone (Settings → Customer accounts).
 */
export const createCustomerSchema = z.object({
    name: z.string().min(3).max(100),
    email: z.email().nullable(),
    phone: phoneNumberSchema.nullable(),
    /** The first address, which becomes the default. */
    address: addressInputSchema.extend({ skipValidation: z.boolean().optional() }).strict().nullable().optional(),
});

/** Schema for updating an existing customer (PUT /api/customers/:id): contact only. A phone can be set, never removed. */
export const updateCustomerSchema = createCustomerSchema.omit({ address: true, phone: true }).partial().extend({
    phone: phoneNumberSchema.optional(),
});

export type AddressInputBody = z.infer<typeof addressInputSchema>;
export type CustomerAddressInputBody = z.infer<typeof customerAddressInputSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
