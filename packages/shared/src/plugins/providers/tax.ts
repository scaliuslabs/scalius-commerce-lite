// The tax port (docs/MARKETS-DESIGN.md, D8): calculate → commit → void,
// each idempotent. Contract only in this wave: the built-in system provider
// (flat and manual rates by tax region) and the checkout wiring arrive with
// markets step 3. A provider calculates on the discounted lines the platform
// sends and returns one tax amount per line and per shipping charge; the
// platform persists them as the order's tax lines and commits the document
// after the order commits (void on cancellation, refund on a refund).

import { z } from "zod";
import {
  providerCountrySchema,
  providerCurrencySchema,
  providerIdempotencyKeySchema,
  providerMinorSchema,
  providerRefSchema,
} from "./common";

export const taxAddressSchema = z.object({
  country: providerCountrySchema,
  /** State, division or province code. */
  adminArea: z.string().max(80).nullable(),
  city: z.string().max(120).nullable(),
  postalCode: z.string().max(40).nullable(),
}).strict();

export const taxCalculateInputSchema = z.object({
  /** Stable per priced cart: the same cart calculates once. */
  idempotencyKey: providerIdempotencyKeySchema,
  currency: providerCurrencySchema,
  pricesIncludeTax: z.boolean(),
  destination: taxAddressSchema,
  origin: taxAddressSchema.nullable(),
  /** Each line after every discount, in minor units. */
  lines: z.array(z.object({
    lineId: providerRefSchema,
    taxCode: z.string().max(64).nullable(),
    quantity: z.number().int().min(1),
    amountMinor: providerMinorSchema,
  }).strict()).max(250),
  shippingMinor: providerMinorSchema,
  customer: z.object({ id: providerRefSchema, exempt: z.boolean() }).strict().nullable(),
}).strict();

const taxLine = z.object({
  taxMinor: providerMinorSchema,
  /** Basis points (1500 = 15%), for display; the amount is authoritative. */
  rateBps: z.number().int().min(0).max(100_000),
  jurisdiction: z.string().max(120),
}).strict();

export const taxCalculationSchema = z.object({
  /** The provider's document id, committed or voided later. */
  calculationId: providerRefSchema,
  lines: z.array(z.object({ lineId: providerRefSchema, taxes: z.array(taxLine).max(10) }).strict()).max(250),
  shipping: z.array(taxLine).max(10),
}).strict();

export const taxCommitInputSchema = z.object({
  calculationId: providerRefSchema,
  orderId: providerRefSchema,
  idempotencyKey: providerIdempotencyKeySchema,
}).strict();
export const taxVoidInputSchema = taxCommitInputSchema;
export const taxDocumentSchema = z.object({ documentId: providerRefSchema }).strict();

export const TAX_PORT = {
  calculate: { input: taxCalculateInputSchema, output: taxCalculationSchema },
  commit: { input: taxCommitInputSchema, output: taxDocumentSchema },
  void: { input: taxVoidInputSchema, output: taxDocumentSchema },
} as const;
