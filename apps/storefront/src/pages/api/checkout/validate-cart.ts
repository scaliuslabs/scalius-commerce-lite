import type { APIRoute } from "astro";
import { validateCartItems, type CartValidationRequestItem } from "@/lib/api/orders";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItem(value: unknown): CartValidationRequestItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.productId !== "string" || value.productId.trim() === "") return null;
  if (typeof value.quantity !== "number" || !Number.isInteger(value.quantity)) return null;
  if (typeof value.price !== "number" || !Number.isFinite(value.price)) return null;

  return {
    cartKey: typeof value.cartKey === "string" ? value.cartKey : null,
    productId: value.productId,
    variantId: typeof value.variantId === "string" && value.variantId !== "default"
      ? value.variantId
      : null,
    quantity: value.quantity,
    price: value.price,
    productName: typeof value.productName === "string" ? value.productName : null,
    variantLabel: typeof value.variantLabel === "string" ? value.variantLabel : null,
  };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const payload = await request.json().catch(() => null);
    const rawItems = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
    const items = rawItems.map(normalizeItem).filter((item): item is CartValidationRequestItem => item !== null);

    if (items.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Your cart is empty. Please add items before checkout.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const result = await validateCartItems(items);
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
    return new Response(JSON.stringify({ success: false, error: "Cart validation failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
