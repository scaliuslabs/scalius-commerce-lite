import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  validateCartItems,
  type CartValidationOptions,
  type CartValidationRequestItem,
} from "@/lib/api/orders";
import { parseRequestProperties } from "@/lib/checkout/tax-quote-contract";

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
  if (typeof value.price !== "number" || !Number.isFinite(value.price)) return null;
  let properties: CartValidationRequestItem["properties"];
  try {
    // Buyer inputs stay in the body; bounded like the API's own limits.
    properties = parseRequestProperties(value.properties);
  } catch {
    return null;
  }

  return {
    cartKey: typeof value.cartKey === "string" ? value.cartKey : null,
    productId: value.productId,
    variantId: value.variantId.trim(),
    quantity: value.quantity,
    price: value.price,
    productName: typeof value.productName === "string" ? value.productName : null,
    variantLabel: typeof value.variantLabel === "string" ? value.variantLabel : null,
    ...(properties ? { properties } : {}),
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
  if (city && zone) {
    return {
      city,
      zone,
      area: optionalString(payload, "area"),
      shippingMethodId,
    };
  }
  return shippingMethodId ? { shippingMethodId } : {};
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ success: false, error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await request.json().catch(() => null);
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
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const items = normalizedItems as CartValidationRequestItem[];

    const result = await validateCartItems(items, normalizeOptions(payload));
    if (!result.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error,
          details: result.details,
        }),
        {
          status: result.status && result.status >= 400 ? result.status : 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ success: true, data: result.data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[checkout/validate-cart] Error:", error);
    return new Response(JSON.stringify({ success: false, error: "We couldn't check your cart. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
