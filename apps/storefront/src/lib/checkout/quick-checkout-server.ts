/**
 * The API reads behind the no-JavaScript checkout (`/checkout/quick`): the
 * delivery rates for an address and the authoritative quote, fetched by the
 * storefront server exactly as the browser asks for them through its proxies.
 */
import { apiFetch } from "@/lib/api/transport";
import type { ShippingMethod } from "@/lib/api/types";
import {
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError,
  TaxQuoteDeliveryLocationError,
  TaxQuoteDeliveryRateError,
} from "./tax-quote-client";
import type { CheckoutTaxQuote } from "./tax-quote-contract";

const QUOTE_TIMEOUT_MS = 8_000;

/** The delivery rates for a city and thana; null when they could not be read. */
export async function fetchQuickCheckoutRates(
  cityId: string,
  zoneId: string,
): Promise<ShippingMethod[] | null> {
  const query = new URLSearchParams({ cityId, zoneId });
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

export type QuickCheckoutQuoteResult =
  | { ok: true; quote: CheckoutTaxQuote }
  | { ok: false; reason: "items" | "rate" | "location" | "unavailable"; message?: string };

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
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(customerSessionToken ? { "X-Customer-Session": customerSessionToken } : {}),
        },
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
    if (error instanceof TaxQuoteDeliveryRateError) return { ok: false, reason: "rate" };
    if (error instanceof TaxQuoteDeliveryLocationError) return { ok: false, reason: "location" };
    return { ok: false, reason: "unavailable" };
  }
}
