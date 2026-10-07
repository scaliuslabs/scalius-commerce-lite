// The billing address contract (migration 0119, Shopify's rule), shared by
// checkout, the tax quote, agent checkout and staff orders. Buyer content:
// sent in the body only, never in a URL.
import { z } from "@hono/zod-openapi";
import { ADDRESS_FIELD_MAX_LENGTH } from "@scalius/shared/address";

const text = (max: number) => z.string().trim().max(max).nullable().optional();

/** The billing fields a request body may carry (spread into an object schema). */
export const billingAddressBodyShape = {
  billingSameAsShipping: z.boolean().nullable().optional().openapi({
    description: "An order that ships: false with a billing address sends a separate one; otherwise the shipping address is the billing address (the default).",
  }),
  billingCountryCode: z.string().trim().length(2).nullable().optional().openapi({
    description: "The billing country (ISO 3166-1 alpha-2), one an active market sells to. An order that ships nothing needs one (absent: the store's only selling country); it is taxed and placed there.",
  }),
  billingName: text(ADDRESS_FIELD_MAX_LENGTH.name),
  billingCompany: text(ADDRESS_FIELD_MAX_LENGTH.company),
  billingAddress: text(ADDRESS_FIELD_MAX_LENGTH.line1).openapi({ description: "The first street line (a full billing address)." }),
  billingAddressLine2: text(ADDRESS_FIELD_MAX_LENGTH.line2),
  billingDependentLocality: text(ADDRESS_FIELD_MAX_LENGTH.dependentLocality),
  billingLocality: text(ADDRESS_FIELD_MAX_LENGTH.locality),
  billingAdminArea: text(ADDRESS_FIELD_MAX_LENGTH.adminArea).openapi({
    description: "The admin area, as its code or name (GET /api/v1/address-rules/{countryCode}). A minimal billing address sends it when the country's rules require it.",
  }),
  billingPostalCode: text(ADDRESS_FIELD_MAX_LENGTH.postalCode).openapi({
    description: "A minimal billing address sends it when the country's rules require it.",
  }),
} as const;

/** The billing snapshot an order read returns. */
export const orderBillingAddressShape = {
  billingSameAsShipping: z.boolean().openapi({ description: "The shipping address is the billing address; the billing fields are then null." }),
  billingName: z.string().nullable().openapi({ description: "Null: the order contact's name." }),
  billingCompany: z.string().nullable(),
  billingAddress: z.string().nullable(),
  billingAddressLine2: z.string().nullable(),
  billingCountryCode: z.string().nullable().openapi({ description: "Null with `billingSameAsShipping` false: no billing address (orders placed before billing addresses, pickup orders not asked for one)." }),
  billingDependentLocality: z.string().nullable(),
  billingLocality: z.string().nullable(),
  billingAdminArea: z.string().nullable(),
  billingPostalCode: z.string().nullable(),
  billingPhone: z.string().nullable(),
  billingValidationSkipped: z.boolean().openapi({ description: "Staff kept a billing address that breaks its country's rules." }),
} as const;
