// The tax port (docs/MARKETS-DESIGN.md, D8): calculate → commit → void or
// refund, each idempotent. The built-in system provider (`system`: the
// merchant's rates by tax region) and app providers implement the same port;
// checkout selects one per country region, else the store-wide one, and
// fails closed when it cannot be called. A provider calculates on the
// discounted lines the platform sends and returns the tax of each line and
// of the shipping charge; the platform rounds each amount to the market's
// price increment, persists the lines on the order, and commits the
// document after the order commits (void on cancellation, refund on a
// refund).

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
  /**
   * The store's delivery location ids of the address, most specific first
   * (Bangladesh's Area, Thana and City). Absent: none.
   */
  locationIds: z.array(providerRefSchema).max(3).optional(),
}).strict();

export const taxCalculateInputSchema = z.object({
  /** Stable per priced cart: the same cart calculates once. */
  idempotencyKey: providerIdempotencyKeySchema,
  currency: providerCurrencySchema,
  /** The order's market's flag: each amount already includes its tax. */
  pricesIncludeTax: z.boolean(),
  destination: taxAddressSchema,
  origin: taxAddressSchema.nullable(),
  /** Each taxable line after every discount, in minor units. */
  lines: z.array(z.object({
    lineId: providerRefSchema,
    /** The line's tax class (the store's id); null: the store default. */
    taxCode: z.string().max(64).nullable(),
    quantity: z.number().int().min(1),
    amountMinor: providerMinorSchema,
  }).strict()).max(250),
  /** The shipping charge after its discount; 0 when shipping is not taxed. */
  shippingMinor: providerMinorSchema,
  /** The shipping charge's tax class (the store's id); null: the store default. */
  shippingTaxCode: z.string().max(64).nullable().optional(),
  customer: z.object({ id: providerRefSchema, exempt: z.boolean() }).strict().nullable(),
}).strict();

const taxLine = z.object({
  taxMinor: providerMinorSchema,
  /** Basis points (1500 = 15%), for display; the amount is authoritative. */
  rateBps: z.number().int().min(0).max(100_000),
  jurisdiction: z.string().max(120),
  /** What the buyer and the invoice call the tax ("VAT"); absent: the jurisdiction. */
  name: z.string().max(120).optional(),
  /** The provider's reference of the rate it applied. */
  rateRef: providerRefSchema.optional(),
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
/** A refund's share of tax: the provider reverses it on its committed document. */
export const taxRefundInputSchema = z.object({
  calculationId: providerRefSchema,
  orderId: providerRefSchema,
  refundId: providerRefSchema,
  idempotencyKey: providerIdempotencyKeySchema,
  /** The refunded amount, tax included, and the tax in it. */
  amountMinor: providerMinorSchema,
  taxMinor: providerMinorSchema,
}).strict();
export const taxDocumentSchema = z.object({ documentId: providerRefSchema }).strict();

export const TAX_PORT = {
  calculate: { input: taxCalculateInputSchema, output: taxCalculationSchema },
  commit: { input: taxCommitInputSchema, output: taxDocumentSchema },
  void: { input: taxVoidInputSchema, output: taxDocumentSchema },
  refund: { input: taxRefundInputSchema, output: taxDocumentSchema },
} as const;

export type TaxAddress = z.infer<typeof taxAddressSchema>;
export type TaxCalculateInput = z.infer<typeof taxCalculateInputSchema>;
export type TaxCalculation = z.infer<typeof taxCalculationSchema>;
export type TaxCalculationLine = z.infer<typeof taxLine>;
