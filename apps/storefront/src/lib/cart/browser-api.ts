/**
 * The two public API writes the /cart page makes from the browser, as plain
 * `fetch` calls so the page does not ship the generated SDK and the SSR
 * transport. Request bodies and response handling match the SSR helpers in
 * `lib/api/discounts.ts` and `lib/api/abandoned-checkouts.ts`.
 */
import type { CartItem } from "@/store/cart";
import type { DiscountValidationResponse } from "@/lib/api/types";
import type { AbandonedCheckoutPayload } from "@/lib/api/abandoned-checkouts";
import { browserApiUrl } from "@/lib/api/browser-url";

interface DiscountValidationItem {
  id: string;
  price: number;
  quantity: number;
  variantId?: string;
}

export interface DiscountValidationBody {
  code: string;
  total?: number;
  shippingCost?: number;
  customerPhone?: string;
  items?: DiscountValidationItem[];
}

export function buildDiscountValidationBody(
  code: string,
  total?: number,
  items?: CartItem[],
  shippingCost?: number,
  customerPhone?: string,
): DiscountValidationBody {
  const body: DiscountValidationBody = { code };
  if (total !== undefined) body.total = total;
  if (shippingCost !== undefined) body.shippingCost = shippingCost;
  if (customerPhone) body.customerPhone = customerPhone;
  const apiItems = (items ?? []).flatMap((item): DiscountValidationItem[] => {
    const legacyProductId =
      "productId" in item && typeof item.productId === "string"
        ? item.productId
        : undefined;
    const id = item.id || legacyProductId;
    if (!id) return [];
    return [{
      id,
      price: Number(item.price),
      quantity: Number(item.quantity),
      ...(item.variantId ? { variantId: item.variantId } : {}),
    }];
  });
  if (apiItems.length > 0) body.items = apiItems;
  return body;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(browserApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

/** Non-2xx responses return the API error body, like the SDK's `error`. */
export async function validateDiscountFromBrowser(
  code: string,
  total?: number,
  items?: CartItem[],
  shippingCost?: number,
  customerPhone?: string,
): Promise<DiscountValidationResponse | null> {
  if (!code.trim()) return null;
  const response = await postJson(
    "/discounts/validate",
    buildDiscountValidationBody(code, total, items, shippingCost, customerPhone),
  );
  const json = (await response.json().catch(() => null)) as
    | { data?: DiscountValidationResponse }
    | null;
  if (!response.ok) return json as DiscountValidationResponse | null;
  return json?.data ?? null;
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
