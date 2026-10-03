// Schema pieces every port shares: money in integer minor units, ISO codes,
// references, idempotency keys and the provider HTTP request. Inputs and
// outputs are plain JSON, so an operation crosses a sandbox boundary (Workers
// RPC) or the in-process bundled loader unchanged.

import { z } from "zod";

/** Integer minor units (paisa, cents): never a float, never negative. */
export const providerMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const providerPositiveMinorSchema = providerMinorSchema.min(1);
export const providerCurrencySchema = z.string().regex(/^[A-Z]{3}$/, "Use an ISO 4217 code.");
export const providerCountrySchema = z.string().regex(/^[A-Z]{2}$/, "Use an ISO 3166-1 alpha-2 code.");
/**
 * The countries a courier or fraud checker serves (MARKETS-DESIGN step 3a):
 * `any`, or ISO codes. A provider is never offered for an order shipping
 * elsewhere: it is hidden with the reason, never an error at booking.
 */
export const providerCountriesSchema = z.union([z.literal("any"), z.array(providerCountrySchema).min(1).max(250)]);
export type ProviderCountries = z.infer<typeof providerCountriesSchema>;

/** Whether a provider serves a country (an unknown country: only an `any` provider). */
export function providerServesCountry(countries: ProviderCountries | undefined, country: string | null | undefined): boolean {
  if (countries === undefined || countries === "any") return true;
  return typeof country === "string" && countries.includes(country.trim().toUpperCase());
}
/** A provider or Scalius reference (order id, session id, consignment id). */
export const providerRefSchema = z.string().min(1).max(256);
/**
 * Deterministic per logical operation: a retry of the same operation sends
 * the same key, so a provider that supports idempotency (and every app
 * provider, through its own storage) applies it once.
 */
export const providerIdempotencyKeySchema = z.string().min(1).max(256);
export const providerReasonSchema = z.string().min(1).max(300);
/** Short audit facts kept with a record: never contact data or secrets. */
export const providerDetailsSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
);

/**
 * An inbound provider request (a webhook or a buyer's return), as the
 * platform received it: the exact body text for signature checks, header
 * names lowercased.
 */
export const providerHttpRequestSchema = z.object({
  method: z.string().regex(/^[A-Z]{3,7}$/),
  rawBody: z.string().max(1024 * 1024),
  headers: z.record(z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/), z.string().max(8192)),
  query: z.record(z.string().max(128), z.string().max(8192)),
}).strict();
export type ProviderHttpRequest = z.infer<typeof providerHttpRequestSchema>;

/** `testConnection`: whether the saved credentials authenticate with the provider. */
export const providerConnectionSchema = z.object({
  ok: z.boolean(),
  /** Merchant-facing; never a credential or a raw provider body. */
  message: z.string().max(300),
}).strict();
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

/** Operations without an input (`testConnection`). */
export const providerNoInputSchema = z.object({}).strict();
