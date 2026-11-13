import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import type { CartRuleError, CartValidationIssue } from "@/lib/api/orders";
import { apiFetch } from "@/lib/api/transport";
import {
  normalizeTaxQuoteRequest,
  parseTaxQuoteEnvelope,
  TAX_QUOTE_MAX_REQUEST_BYTES,
  TAX_QUOTE_MAX_RESPONSE_BYTES,
  type QuotedShippingRate,
} from "@/lib/checkout/tax-quote-contract";
import {
  CART_RULES_REASON,
  cartRuleRefusal,
  DELIVERY_LOCATION_UNAVAILABLE_REASON,
  DELIVERY_RATE_UNAVAILABLE_REASON,
  isDeliveryRateUnavailable,
  parseTaxQuoteCartIssues,
  refusedDeliveryRates,
  refusedForItems,
  unavailableDeliveryLocation,
  type DeliveryLocationLevel,
  type ItemsDeliveryRefusal,
} from "@/lib/checkout/tax-quote-error-contract";
import { getCustomerSessionTokenFromCookie } from "../../../lib/customer-session-cookie";
import { buyerUiLocaleHeaders } from "@/lib/buyer-ui/locale";
import { readBoundedJson } from "@/lib/bounded-body";

export const prerender = false;

const TAX_QUOTE_API_PATH = "/orders/tax-quote";
const TAX_QUOTE_UPSTREAM_TIMEOUT_MS = 8_000;


function responseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    Pragma: "no-cache",
  });
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(),
  });
}

function isCrossOrigin(request: Request): boolean {
  if (shouldRejectCrossOriginCookieRequest(request)) return true;
  const submittedOrigin = request.headers.get("Origin");
  if (!submittedOrigin) return false;
  try {
    return new URL(submittedOrigin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

function safeUpstreamFailureStatus(status: number): number {
  return status === 400 ||
    status === 409 ||
    status === 422 ||
    status === 429 ||
    status === 503
    ? status
    : 502;
}

export const POST: APIRoute = async ({ request }) => {
  if (isCrossOrigin(request)) {
    return jsonResponse({ success: false, error: "Request origin denied" }, 403);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return jsonResponse({ success: false, error: "JSON request required" }, 415);
  }
  const read = await readBoundedJson(request, TAX_QUOTE_MAX_REQUEST_BYTES);
  if (!read.ok && read.reason === "too_large") {
    return jsonResponse({ success: false, error: "Request too large" }, 413);
  }

  let normalizedRequest;
  try {
    if (!read.ok) throw new SyntaxError("Tax quote request is not JSON");
    normalizedRequest = normalizeTaxQuoteRequest(read.value);
  } catch {
    return jsonResponse(
      { success: false, error: "Checkout tax quote request is invalid" },
      400,
    );
  }

  try {
    const customerSessionToken = getCustomerSessionTokenFromCookie(
      request.headers.get("cookie"),
    );
    const upstream = await apiFetch(
      TAX_QUOTE_API_PATH,
      {
        method: "POST",
        headers: {
          ...await buyerUiLocaleHeaders(request.headers),
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(customerSessionToken
            ? { "X-Customer-Session": customerSessionToken }
            : {}),
        },
        body: JSON.stringify(normalizedRequest),
        cache: "no-store",
      },
      { retries: 0, timeout: TAX_QUOTE_UPSTREAM_TIMEOUT_MS, auth: false },
    );

    if (!upstream.ok) {
      let itemIssues: CartValidationIssue[] = [];
      let ruleErrors: CartRuleError[] | null = null;
      let deliveryRateUnavailable = false;
      let visibleRates: QuotedShippingRate[] | null = null;
      let itemsRefusal: ItemsDeliveryRefusal | null = null;
      let locationGone: DeliveryLocationLevel | null = null;
      try {
        const answer = await readBoundedJson(upstream, TAX_QUOTE_MAX_RESPONSE_BYTES);
        if (!answer.ok) throw new SyntaxError("Tax quote refusal is unreadable");
        const payload = answer.value;
        itemIssues = parseTaxQuoteCartIssues(payload);
        ruleErrors = cartRuleRefusal(payload);
        deliveryRateUnavailable = isDeliveryRateUnavailable(payload);
        visibleRates = refusedDeliveryRates(payload);
        itemsRefusal = refusedForItems(payload);
        locationGone = unavailableDeliveryLocation(payload);
      } catch {
        itemIssues = [];
      }
      return jsonResponse(
        {
          success: false,
          error: "Current checkout total is unavailable",
          ...(itemIssues.length > 0
            ? { details: { itemIssues } }
            : ruleErrors
              ? { details: { reason: CART_RULES_REASON, ruleErrors } }
            : deliveryRateUnavailable
              ? {
                  details: {
                    reason: DELIVERY_RATE_UNAVAILABLE_REASON,
                    // The options still offered, when a store app hid the chosen one.
                    ...(visibleRates ? { shippingRates: visibleRates } : {}),
                    // The options these items can't take and their weight, so
                    // the cart says why (too heavy) instead of "no delivery".
                    ...(itemsRefusal
                      ? { unavailableRates: itemsRefusal.rates, weightGrams: itemsRefusal.weightGrams }
                      : {}),
                  },
                }
              : locationGone
                ? { details: { reason: DELIVERY_LOCATION_UNAVAILABLE_REASON, field: locationGone } }
                : {}),
        },
        safeUpstreamFailureStatus(upstream.status),
      );
    }

    const answer = await readBoundedJson(upstream, TAX_QUOTE_MAX_RESPONSE_BYTES);
    if (!answer.ok) throw new SyntaxError("Tax quote is unreadable");
    const quote = parseTaxQuoteEnvelope(answer.value);
    return jsonResponse({ success: true, data: quote }, 200);
  } catch {
    return jsonResponse(
      { success: false, error: "Current checkout total is unavailable" },
      502,
    );
  }
};
