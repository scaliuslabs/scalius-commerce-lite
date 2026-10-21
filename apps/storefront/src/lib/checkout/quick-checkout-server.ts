/**
 * The API reads behind the no-JavaScript checkout (`/checkout/quick`): the
 * delivery rates for an address and the authoritative quote, fetched by the
 * storefront server exactly as the browser asks for them through its proxies.
 */
import type { AddressRules } from "@scalius/shared/address";
import { apiFetch } from "@/lib/api/transport";
import type { CartRuleError } from "@/lib/api/orders";
import type { ShippingMethod } from "@/lib/api/types";
import {
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError,
  TaxQuoteCartRulesError,
  TaxQuoteDeliveryLocationError,
  TaxQuoteDeliveryRateError,
} from "./tax-quote-client";
import type { CheckoutTaxQuote, QuotedShippingRate } from "./tax-quote-contract";

const QUOTE_TIMEOUT_MS = 8_000;

/**
 * The delivery rates of a destination's shipping zone: Bangladesh's city and
 * thana, or another country with its region and postal code (MARKETS-DESIGN
 * step 3b); null when they could not be read.
 */
export async function fetchQuickCheckoutRates(
  destination: { cityId: string; zoneId: string } | { countryCode: string; adminArea?: string; postalCode?: string },
): Promise<ShippingMethod[] | null> {
  const query = new URLSearchParams();
  if ("countryCode" in destination) {
    query.set("countryCode", destination.countryCode);
    if (destination.adminArea) query.set("adminArea", destination.adminArea);
    if (destination.postalCode) query.set("postalCode", destination.postalCode);
  } else {
    query.set("cityId", destination.cityId);
    query.set("zoneId", destination.zoneId);
  }
  try {
    const response = await apiFetch(`/shipping-methods?${query}`, {}, { auth: false, retries: 1 });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { shippingMethods?: unknown } };
    const rates = body.data?.shippingMethods;
    return Array.isArray(rates) ? (rates as ShippingMethod[]) : null;
  } catch {
    return null;
  }
}

/** One country's address rules (the billing address is checked with them); null when they could not be read. */
export async function fetchQuickCheckoutAddressRules(countryCode: string): Promise<AddressRules | null> {
  try {
    const response = await apiFetch(`/address-rules/${encodeURIComponent(countryCode)}`, {}, { auth: false, retries: 1 });
    if (!response.ok) return null;
    const body = (await response.json()) as { success?: unknown; data?: AddressRules };
    return body.success === true && body.data?.countryCode === countryCode ? body.data : null;
  } catch {
    return null;
  }
}

export type QuickCheckoutQuoteResult =
  | { ok: true; quote: CheckoutTaxQuote }
  /** A store app's rules block the order: shown in the app's words. */
  | { ok: false; reason: "rules"; ruleErrors: CartRuleError[] }
  /** The option was refused; `shippingRates` are the ones left when a store app hid it. */
  | { ok: false; reason: "rate"; shippingRates: QuotedShippingRate[] | null }
  | { ok: false; reason: "items" | "location" | "unavailable"; message?: string };

/**
 * The quote client's headers with this server's own. Set on one `Headers`,
 * never spread beside them: `Headers` lower-cases its names, and an object
 * holding both `content-type` and `Content-Type` became a doubled
 * "application/json, application/json" that the API could not read (buyer QA B2).
 */
export function quoteHeaders(clientHeaders: HeadersInit | undefined, customerSessionToken: string | null): Headers {
  const headers = new Headers(clientHeaders);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  if (customerSessionToken) headers.set("X-Customer-Session", customerSessionToken);
  return headers;
}

export async function fetchQuickCheckoutQuote(
  input: Record<string, unknown>,
  customerSessionToken: string | null,
): Promise<QuickCheckoutQuoteResult> {
  // The same parser and cart checks as the browser; only the transport differs.
  const fetcher = ((_url: string, init?: RequestInit) =>
    apiFetch(
      "/orders/tax-quote",
      {
        method: "POST",
        headers: quoteHeaders(init?.headers, customerSessionToken),
        body: init?.body,
        cache: "no-store",
      },
      { retries: 0, timeout: QUOTE_TIMEOUT_MS, auth: false },
    )) as typeof fetch;
  try {
    return { ok: true, quote: await fetchAuthoritativeTaxQuote(input, fetcher) };
  } catch (error) {
    if (error instanceof TaxQuoteCartChangedError) {
      return { ok: false, reason: "items", message: error.issues[0]?.message };
    }
    if (error instanceof TaxQuoteCartRulesError) {
      return { ok: false, reason: "rules", ruleErrors: error.ruleErrors };
    }
    if (error instanceof TaxQuoteDeliveryRateError) {
      return { ok: false, reason: "rate", shippingRates: error.shippingRates };
    }
    if (error instanceof TaxQuoteDeliveryLocationError) return { ok: false, reason: "location" };
    return { ok: false, reason: "unavailable" };
  }
}
