// "Buy again" on an account order: the lines that can still be bought go back
// in the cart at today's price, as one cart change, and the drawer opens once.
// The store's cart check decides what is still sellable.
import type { OpenCartEventDetail } from "@/components/CartFlyout";
import { addLinesToCart } from "@/store/cart";
import type { CustomerOrderItem } from "@/lib/api/customer-auth";
import type { OrderLineFulfilmentFacts } from "@/lib/api/types";
import type { CartValidationResult } from "@/lib/api/orders";
import { currentPresence } from "@/lib/presence-url";
import { accountCopy } from "@/lib/account-copy";
import { readLinePurchaseOption } from "@scalius/shared/line-properties";

/** Lines the store no longer sells as ordered; a short stock line still goes in, capped. */
const GONE = new Set(["product_unavailable", "variant_required", "variant_unavailable", "variant_mismatch"]);

/** How many lines went back in the cart, or null when the store couldn't be reached. */
export async function addOrderToCart(items: Array<CustomerOrderItem & OrderLineFulfilmentFacts>): Promise<{ added: number; missing: number } | null> {
  const lines = items.filter((item): item is CustomerOrderItem & OrderLineFulfilmentFacts & { variantId: string } => Boolean(item.productId && item.variantId));
  if (lines.length === 0) return { added: 0, missing: items.length };
  let result: CartValidationResult | null;
  try {
    const response = await fetch("/api/checkout/validate-cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: lines.map((item, index) => ({
          cartKey: String(index),
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price,
          productName: item.productName,
          variantLabel: item.variantLabel,
          // The same buyer inputs again; the store re-checks and re-prices them.
          // Keys starting "_" are the platform's (an app bundle), never inputs.
          ...(item.properties?.some(({ key }) => !key.startsWith("_"))
            ? { properties: item.properties.filter(({ key }) => !key.startsWith("_")).map(({ key, value }) => ({ key, value })) }
            : {}),
          // Bought under an app's option (a subscription): again under it, if it is still offered.
          ...(readLinePurchaseOption(item.properties ?? null) ? { purchaseOption: readLinePurchaseOption(item.properties ?? null)! } : {}),
        })),
        // Today's price in the page's market (MARKETS-DESIGN D5).
        ...(currentPresence() ? { presence: currentPresence() } : {}),
      }),
    });
    const json = await response.json().catch(() => null) as { success?: boolean; data?: CartValidationResult } | null;
    result = json?.success && json.data ? json.data : null;
  } catch {
    result = null;
  }
  if (!result) return null;

  const gone = new Set(result.issues.filter((issue) => GONE.has(issue.code)).map((issue) => issue.index));
  const cartLines: Parameters<typeof addLinesToCart>[0][number][] = [];
  for (const line of result.items) {
    const quantity = Math.min(line.quantity, line.availableQuantity ?? line.quantity);
    if (gone.has(line.index) || quantity < 1) continue;
    cartLines.push({
      id: line.productId,
      variantId: line.variantId,
      name: line.productName,
      price: line.unitPrice,
      quantity,
      slug: lines[line.index]?.productSlug ?? undefined,
      image: line.productImage ?? undefined,
      imageMediaId: line.productImageMediaId ?? undefined,
      options: line.variantLabel ? [{ name: accountCopy().format.variant, label: line.variantLabel }] : undefined,
      freeDelivery: line.freeDelivery,
      ...(line.purchaseOption ? { purchaseOption: line.purchaseOption } : {}),
      ...(line.fulfillmentKind ? { fulfillmentKind: line.fulfillmentKind } : {}),
      ...(line.properties?.length
        ? {
            properties: line.properties.map(({ key, value, label, displayValue, priceMinor }) => ({
              key, value, label, displayValue, priceMinor,
            })),
          }
        : {}),
    });
  }
  // One cart change for every line: a line-per-event add left later lines to
  // race the first one's drawer load and reported lines as added that weren't.
  const addedKeys = cartLines.length > 0 ? await addLinesToCart(cartLines) : [];
  if (addedKeys.length > 0) {
    document.dispatchEvent(new CustomEvent<OpenCartEventDetail>("open-cart", { detail: { addedLineKey: addedKeys[0] } }));
  }
  const added = addedKeys.length;
  return { added, missing: items.length - added };
}
