import { buyerApiErrorTextLater } from "../buyer-api-error-text-later";
/**
 * The two public API calls the cart makes from the browser, as plain `fetch`
 * calls so the page does not ship the generated SDK and the SSR transport.
 */
import type { CartItem } from "@/store/cart";
import type { AbandonedCheckoutPayload } from "@/lib/api/abandoned-checkouts";
import { browserApiUrl } from "@/lib/api/browser-url";
import {
  parseDiscountFacts,
  parsePreviewBundleDiscountLine,
  type CheckoutDiscountFacts,
} from "@/lib/checkout/quote-facts";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { currentPresence } from "@/lib/presence-url";

interface DiscountPreviewItem {
  id: string;
  price: number;
  /** Unit price before buyer-input surcharges: what quantity bundles price from. */
  basePrice?: number;
  quantity: number;
  variantId?: string;
}

/** The line's unit price without its buyer-input surcharges. */
function basePriceOf(item: CartItem): number | undefined {
  const surchargeMinor = (item.properties ?? []).reduce((sum, property) => sum + (property.priceMinor ?? 0), 0);
  if (!(surchargeMinor > 0)) return undefined;
  const places = getDecimalPlaces(getCurrencyCode());
  try {
    return fromMinor(Math.max(0, toMinor(Number(item.price), places) - surchargeMinor), places);
  } catch {
    return undefined;
  }
}

export interface DiscountPreviewBody {
  codes: string[];
  shippingCost?: number;
  customerPhone?: string;
  items: DiscountPreviewItem[];
  /** The page's presence: its market's currency prices the preview (MARKETS-DESIGN step 6). */
  presence?: string;
}

export function buildDiscountPreviewBody(
  codes: string[],
  items: CartItem[],
  shippingCost?: number,
  customerPhone?: string,
): DiscountPreviewBody {
  return {
    codes,
    items: items.map((item) => {
      const basePrice = basePriceOf(item);
      return {
        id: item.id,
        price: Number(item.price),
        ...(basePrice !== undefined ? { basePrice } : {}),
        quantity: Number(item.quantity),
        ...(item.variantId ? { variantId: item.variantId } : {}),
      };
    }),
    ...(shippingCost !== undefined ? { shippingCost } : {}),
    ...(customerPhone ? { customerPhone } : {}),
    ...(typeof document !== "undefined" && currentPresence() ? { presence: currentPresence()! } : {}),
  };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(browserApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

/** The readable sign-in hint the storefront sets beside its httpOnly session cookie. */
function isSignedIn(): boolean {
  try {
    return document.cookie.split(";").some((cookie) => cookie.trim().startsWith("cs_auth=1"));
  } catch {
    return false;
  }
}

/**
 * A guest's preview goes straight to the public API. A signed-in buyer's goes
 * through this origin, which adds the httpOnly session the API cannot see
 * cross-origin, so discounts limited to customer segments preview as checkout
 * prices them.
 */
function postDiscountPreview(body: DiscountPreviewBody): Promise<Response> {
  if (!isSignedIn()) return postJson("/discounts/validate", body);
  return fetch("/api/checkout/discount-preview", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

export type DiscountPreview =
  | ({ ok: true; totalDiscount: number; lineDiscountsMinor: number[] } & CheckoutDiscountFacts)
  | { ok: false; message: string | null };

/** Each previewed line's share of the store's discounts, by its position (0 where the answer names none). */
function parseLineDiscounts(value: unknown, count: number): number[] {
  const shares = new Array<number>(count).fill(0);
  if (!Array.isArray(value)) return shares;
  for (const entry of value) {
    const index = (entry as { index?: unknown })?.index;
    const minor = (entry as { discountMinor?: unknown })?.discountMinor;
    if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < count
      && typeof minor === "number" && Number.isSafeInteger(minor) && minor >= 0) shares[index] = minor;
  }
  return shares;
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
  // Signing in or out changes who the preview prices, so it is part of the cart state.
  const key = JSON.stringify([isSignedIn(), body]);
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
    const response = await postDiscountPreview(body);
    const json = (await response.json().catch(() => null)) as
      | { data?: Record<string, unknown> }
      | null;
    if (!response.ok || !json?.data) return { ok: false, message: await buyerApiErrorTextLater(json, { status: response.status }) };
    const totalDiscount = Number(json.data.totalDiscount);
    const facts = parseDiscountFacts(json.data);
    // A quantity-bundle saving is part of totalDiscount; list it like the quote does.
    const bundleLine = parsePreviewBundleDiscountLine(json.data);
    if (bundleLine) facts.discounts = [...facts.discounts, bundleLine];
    return {
      ok: true,
      totalDiscount: Number.isFinite(totalDiscount) && totalDiscount > 0 ? totalDiscount : 0,
      lineDiscountsMinor: parseLineDiscounts(json.data.lineDiscounts, body.items.length),
      ...facts,
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
