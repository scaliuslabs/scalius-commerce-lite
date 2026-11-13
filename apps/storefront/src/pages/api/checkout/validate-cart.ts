import { getCustomerSessionTokenFromCookie } from "@/lib/customer-session-cookie";
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  validateCartItems,
  type CartValidationOptions,
  type CartValidationRequestItem,
} from "@/lib/api/orders";
import { parseCheckoutAttributes, parseRequestProperties, parseRequestPurchaseOptions } from "@/lib/checkout/tax-quote-contract";
import { isMarketSubfolder } from "@scalius/shared/markets";
import { CART_REQUEST_MAX_BYTES, payloadTooLargeResponse, readBoundedJson } from "@/lib/bounded-body";
import { withRateLimitWait } from "@/lib/rate-limited";
import { CART_LINE_INPUT_LIMITS } from "@scalius/shared/line-identity";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItem(value: unknown): CartValidationRequestItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.productId !== "string" || value.productId.trim() === "") return null;
  if (
    typeof value.variantId !== "string" ||
    value.variantId.trim() === "" ||
    value.variantId.trim() === "default"
  ) return null;
  if (typeof value.quantity !== "number" || !Number.isInteger(value.quantity)) return null;
  // Absent: a line put back from a stored source, quoted at today's price.
  if (value.price !== undefined && (typeof value.price !== "number" || !Number.isFinite(value.price))) return null;
  // A page from the build before a line carried one option per app sends one
  // `purchaseOption`: refused, never checked (or sold) as a one-time line.
  if (value.purchaseOption !== undefined && value.purchaseOption !== null) return null;
  let properties: CartValidationRequestItem["properties"];
  let purchaseOptions: string[] | undefined;
  try {
    // Buyer inputs stay in the body; bounded like the API's own limits.
    properties = parseRequestProperties(value.properties);
    purchaseOptions = parseRequestPurchaseOptions(value.purchaseOptions);
  } catch {
    return null;
  }

  return {
    cartKey: typeof value.cartKey === "string" ? value.cartKey : null,
    productId: value.productId,
    variantId: value.variantId.trim(),
    quantity: value.quantity,
    ...(typeof value.price === "number" ? { price: value.price } : {}),
    productName: typeof value.productName === "string" ? value.productName : null,
    variantLabel: typeof value.variantLabel === "string" ? value.variantLabel : null,
    ...(properties ? { properties } : {}),
    ...(purchaseOptions ? { purchaseOptions } : {}),
  };
}

function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A delivery rate is checked with its address; a pickup rate on its own
 * (it needs no address). Without a rate only the items are checked.
 */
function normalizeOptions(payload: unknown): CartValidationOptions {
  if (!isRecord(payload)) return {};
  const city = optionalString(payload, "city");
  const zone = optionalString(payload, "zone");
  const shippingMethodId = optionalString(payload, "shippingMethodId");
  const token = optionalString(payload, "shippingRateToken");
  const rateQuote = {
    ...(token && token.length <= 2048 ? { shippingRateToken: token } : {}),
    ...(typeof payload.cod === "boolean" ? { cod: payload.cod } : {}),
  };
  // The page's presence (`en-in`): its market prices the cart before an address.
  const presenceValue = optionalString(payload, "presence");
  const presence = isMarketSubfolder(presenceValue) ? { presence: presenceValue } : {};
  // Another country's delivery: its rate is checked against its region and postal code, never a Bangladesh City/Thana.
  const country = optionalString(payload, "shippingCountryCode")?.toUpperCase() ?? null;
  if (country && country !== "BD" && /^[A-Z]{2}$/.test(country)) {
    return {
      shippingCountryCode: country,
      shippingAdminArea: optionalString(payload, "shippingAdminArea"),
      shippingPostalCode: optionalString(payload, "shippingPostalCode"),
      shippingMethodId,
      ...rateQuote,
      ...presence,
    };
  }
  if (city && zone) {
    return {
      city,
      zone,
      area: optionalString(payload, "area"),
      shippingMethodId,
      ...rateQuote,
      ...presence,
    };
  }
  return shippingMethodId ? { shippingMethodId, ...rateQuote, ...presence } : presence;
}

/** Whether the cart's buyer answers pass what the API takes together (`CART_LINE_INPUT_LIMITS`). */
function cartAnswersOverLimit(items: readonly CartValidationRequestItem[]): boolean {
  let entries = 0;
  let characters = 0;
  for (const item of items) {
    for (const property of item.properties ?? []) {
      entries += 1;
      characters += property.value.length;
    }
  }
  return entries > CART_LINE_INPUT_LIMITS.entries || characters > CART_LINE_INPUT_LIMITS.valueCharacters;
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ success: false, error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }

  try {
    const body = await readBoundedJson(request, CART_REQUEST_MAX_BYTES);
    if (!body.ok && body.reason === "too_large") return payloadTooLargeResponse();
    const payload = body.ok ? body.value : null;
    const rawItems = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
    const normalizedItems = rawItems.map(normalizeItem);

    if (normalizedItems.length === 0 || normalizedItems.some((item) => item === null)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: normalizedItems.length === 0
            ? "Your cart is empty. Please add items before checkout."
            : "Every cart item must include a saved product variant.",
        }),
        { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } },
      );
    }
    const items = normalizedItems as CartValidationRequestItem[];
    // The API takes at most CART_LINE_INPUT_LIMITS of buyer answers in one cart: past it the buyer
    // reads what to do (`answers_too_many`, buyer-refusal-words.ts), never a raw 400 or 413.
    if (cartAnswersOverLimit(items)) {
      return new Response(JSON.stringify({ success: false, errorCode: "answers_too_many", error: "Too many buyer answers in one cart" }), {
        status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
      });
    }

    let attributes: Record<string, string> | undefined;
    try {
      attributes = parseCheckoutAttributes(isRecord(payload) ? payload.attributes : undefined);
    } catch {
      return new Response(JSON.stringify({ success: false, error: "Checkout details are invalid" }), {
        status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    const result = await validateCartItems(items, {
      ...normalizeOptions(payload),
      ...(attributes ? { attributes } : {}),
    }, getCustomerSessionTokenFromCookie(request.headers.get("cookie")), request.headers);
    if (!result.success) {
      // The API's rate limit keeps its wait, in the details and in Retry-After (`rate-limited.ts`).
      const wait = withRateLimitWait(result.details, result.retryAfterSeconds);
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error,
          details: wait.details,
        }),
        {
          status: result.status && result.status >= 400 ? result.status : 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", ...wait.headers },
        },
      );
    }

    return new Response(JSON.stringify({ success: true, data: result.data }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[checkout/validate-cart] Error:", error);
    return new Response(JSON.stringify({ success: false, error: "We couldn't check your cart. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }
};
