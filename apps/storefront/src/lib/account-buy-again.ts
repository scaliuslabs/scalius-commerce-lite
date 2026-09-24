// "Buy again" on an account order: the lines that can still be bought go back
// in the cart at today's price, through the same add-to-cart event product
// pages use. The store's cart check decides what is still sellable.
import type { AddToCartEventDetail } from "@/components/CartFlyout";
import type { CustomerOrderItem } from "@/lib/api/customer-auth";
import type { CartValidationResult } from "@/lib/api/orders";

/** Lines the store no longer sells as ordered; a short stock line still goes in, capped. */
const GONE = new Set(["PRODUCT_UNAVAILABLE", "VARIANT_REQUIRED", "VARIANT_UNAVAILABLE", "VARIANT_MISMATCH"]);

/** How many lines went back in the cart, or null when the store couldn't be reached. */
export async function addOrderToCart(items: CustomerOrderItem[]): Promise<{ added: number; missing: number } | null> {
  const lines = items.filter((item): item is CustomerOrderItem & { variantId: string } => Boolean(item.productId && item.variantId));
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
        })),
      }),
    });
    const json = await response.json().catch(() => null) as { success?: boolean; data?: CartValidationResult } | null;
    result = json?.success && json.data ? json.data : null;
  } catch {
    result = null;
  }
  if (!result) return null;

  const gone = new Set(result.issues.filter((issue) => GONE.has(issue.code)).map((issue) => issue.index));
  let added = 0;
  for (const line of result.items) {
    const quantity = Math.min(line.quantity, line.availableQuantity ?? line.quantity);
    if (gone.has(line.index) || quantity < 1) continue;
    const detail: AddToCartEventDetail = {
      id: line.productId,
      variantId: line.variantId,
      name: line.productName,
      price: line.unitPrice,
      quantity,
      slug: lines[line.index]?.productSlug ?? undefined,
      image: line.productImage ?? undefined,
      imageMediaId: line.productImageMediaId ?? undefined,
      options: line.variantLabel ? [{ name: "Variant", label: line.variantLabel }] : undefined,
      freeDelivery: line.freeDelivery,
    };
    document.dispatchEvent(new CustomEvent("add-to-cart", { detail }));
    added += 1;
  }
  return { added, missing: items.length - added };
}
