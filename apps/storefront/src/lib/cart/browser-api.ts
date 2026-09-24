/**
 * The two public API calls the cart makes from the browser, as plain `fetch`
 * calls so the page does not ship the generated SDK and the SSR transport.
 */
import type { CartItem } from "@/store/cart";
import type { AbandonedCheckoutPayload } from "@/lib/api/abandoned-checkouts";
import { browserApiUrl } from "@/lib/api/browser-url";
import {
  parseDiscountFacts,
  type CheckoutDiscountFacts,
} from "@/lib/checkout/tax-quote-contract";

interface DiscountPreviewItem {
  id: string;
  price: number;
  quantity: number;
  variantId?: string;
}

export interface DiscountPreviewBody {
  codes: string[];
  shippingCost?: number;
  customerPhone?: string;
  items: DiscountPreviewItem[];
}

export function buildDiscountPreviewBody(
  codes: string[],
  items: CartItem[],
  shippingCost?: number,
  customerPhone?: string,
): DiscountPreviewBody {
  return {
    codes,
    items: items.map((item) => ({
      id: item.id,
      price: Number(item.price),
      quantity: Number(item.quantity),
      ...(item.variantId ? { variantId: item.variantId } : {}),
    })),
    ...(shippingCost !== undefined ? { shippingCost } : {}),
    ...(customerPhone ? { customerPhone } : {}),
  };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(browserApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

export type DiscountPreview =
  | ({ ok: true; totalDiscount: number } & CheckoutDiscountFacts)
  | { ok: false; message: string | null };

/** The API error envelope is `{ success: false, error: { message } }`. */
function errorMessage(json: unknown): string | null {
  const error = (json as { error?: unknown } | null)?.error;
  const message = typeof error === "string"
    ? error
    : (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

/**
 * The cart's discounts before a delivery destination is chosen: every applied
 * code (with why it does or does not apply) plus active automatic discounts.
 */
let lastPreview: { key: string; result: Promise<DiscountPreview> } | null = null;

/**
 * One request per cart state: the page asks again on every render (load,
 * address, delivery option), but the same codes, items, delivery charge and
 * phone reuse the answer already received or in flight.
 */
export function previewCartDiscounts(
  codes: string[],
  items: CartItem[],
  shippingCost?: number,
  customerPhone?: string,
): Promise<DiscountPreview> {
  const body = buildDiscountPreviewBody(codes, items, shippingCost, customerPhone);
  const key = JSON.stringify(body);
  if (lastPreview?.key === key) return lastPreview.result;
  const result = requestDiscountPreview(body);
  lastPreview = { key, result };
  // A failed answer is not reused: the next render asks again.
  void result.then((preview) => {
    if (!preview.ok && lastPreview?.result === result) lastPreview = null;
  });
  return result;
}

async function requestDiscountPreview(body: DiscountPreviewBody): Promise<DiscountPreview> {
  try {
    const response = await postJson("/discounts/validate", body);
    const json = (await response.json().catch(() => null)) as
      | { data?: Record<string, unknown> }
      | null;
    if (!response.ok || !json?.data) return { ok: false, message: errorMessage(json) };
    const totalDiscount = Number(json.data.totalDiscount);
    return {
      ok: true,
      totalDiscount: Number.isFinite(totalDiscount) && totalDiscount > 0 ? totalDiscount : 0,
      ...parseDiscountFacts(json.data),
    };
  } catch {
    return { ok: false, message: null };
  }
}

/** Fire-and-forget; failures never reach the buyer. */
export async function saveAbandonedCheckoutFromBrowser(
  payload: AbandonedCheckoutPayload,
): Promise<void> {
  try {
    const response = await postJson("/abandoned-checkouts", payload);
    await response.body?.cancel();
  } catch {
    // Abandoned-checkout capture is best effort.
  }
}
