import { buyerApiErrorTextLater } from "../buyer-api-error-text-later";
/**
 * The cart's browser-side API reads, as plain `fetch` calls and parsers so the
 * page does not ship the generated SDK and the SSR transport.
 */
import type { AbandonedCheckoutPayload } from "@/lib/api/abandoned-checkouts";
import { browserApiUrl } from "@/lib/api/browser-url";
import {
  parseDiscountFacts,
  parsePreviewBundleDiscountLine,
  type CheckoutDiscountFacts,
} from "@/lib/checkout/quote-facts";

export type DiscountPreview =
  | ({ ok: true; totalDiscount: number; lineDiscountsMinor: number[] } & CheckoutDiscountFacts)
  | { ok: false; message: string | null };

/** Each checked line's share of the store's discounts, by its position in the check (0 where the answer names none). */
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
 * The cart's discounts from the cart check that carried its codes
 * (`discountCodes`): every applied code (with why it does or does not apply),
 * the store's automatic discounts and its apps', and each checked line's
 * share by its position in the check's `items`. A refused check says why.
 */
export async function readCartCheckDiscount(
  response: { ok: boolean; status: number },
  json: unknown,
  lineCount: number,
): Promise<DiscountPreview> {
  const data = (json as { data?: { discount?: unknown } } | null)?.data?.discount;
  if (!response.ok || !data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, message: response.ok ? null : await buyerApiErrorTextLater(json, { status: response.status }) };
  }
  try {
    const discount = data as Record<string, unknown>;
    const totalDiscount = Number(discount.totalDiscount);
    const facts = parseDiscountFacts(discount);
    // A quantity-bundle saving is part of totalDiscount; list it like the quote does.
    const bundleLine = parsePreviewBundleDiscountLine(discount);
    if (bundleLine) facts.discounts = [...facts.discounts, bundleLine];
    return {
      ok: true,
      totalDiscount: Number.isFinite(totalDiscount) && totalDiscount > 0 ? totalDiscount : 0,
      lineDiscountsMinor: parseLineDiscounts(discount.lineDiscounts, lineCount),
      ...facts,
    };
  } catch {
    return { ok: false, message: null };
  }
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(browserApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
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
