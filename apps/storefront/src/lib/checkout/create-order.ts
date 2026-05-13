/**
 * Creates an order via the server-side proxy.
 * Shared by all gateway handlers.
 */
import { getCheckoutErrorMessage } from "./error-messages";

export function parseDiscountInput(checkoutData: Record<string, unknown>): {
  code?: string;
  amount: number | null;
} {
  const rawHidden = checkoutData.discountCodeHidden;
  const fallbackAmount =
    parseFloat(String(checkoutData.discountAmount ?? "0")) || null;

  if (typeof rawHidden !== "string" || rawHidden.trim() === "") {
    return {
      code:
        typeof checkoutData.discountCode === "string"
          ? checkoutData.discountCode
          : undefined,
      amount: fallbackAmount,
    };
  }

  try {
    const parsed = JSON.parse(rawHidden) as { code?: unknown; amount?: unknown };
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    const amount =
      typeof parsed.amount === "number"
        ? parsed.amount
        : parseFloat(String(parsed.amount ?? ""));

    return {
      code,
      amount: Number.isFinite(amount) && amount > 0 ? amount : fallbackAmount,
    };
  } catch {
    return {
      code: rawHidden,
      amount: fallbackAmount,
    };
  }
}

export async function createOrder(
  checkoutData: Record<string, unknown>,
  paymentMethod: string,
): Promise<string> {
  let cartItems: Record<string, { id: string; variantId?: string; quantity: number; price: number }> = {};
  try {
    cartItems = JSON.parse((checkoutData.cartItems as string) || "{}");
  } catch {
    // ignore parse errors
  }

  const items = Object.values(cartItems).map((item) => ({
    productId: item.id,
    variantId: item.variantId && item.variantId !== "default" ? item.variantId : null,
    quantity: item.quantity,
    price: item.price,
  }));
  const discount = parseDiscountInput(checkoutData);

  const payload = {
    customerName: checkoutData.customerName,
    customerPhone: checkoutData.customerPhone,
    customerEmail: checkoutData.customerEmail || null,
    shippingAddress: checkoutData.shippingAddress,
    city: checkoutData.city,
    zone: checkoutData.zone,
    area: checkoutData.area || null,
    cityName: checkoutData.cityName || undefined,
    zoneName: checkoutData.zoneName || undefined,
    areaName: checkoutData.areaName || undefined,
    notes: checkoutData.notes || null,
    items,
    shippingCharge: parseFloat((checkoutData.shippingCharge as string) || "0"),
    shippingMethodId: checkoutData.shippingMethodId,
    discountAmount: discount.amount,
    discountCode: discount.code,
    paymentMethod,
  };

  const res = await fetch("/api/checkout/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({} as Record<string, unknown>));
    throw new Error(
      getCheckoutErrorMessage(err, `Order creation failed (${res.status})`),
    );
  }

  const data = await res.json();
  const orderId = data.data?.id || data.orderId || data.id || data.order?.id;
  if (!orderId) throw new Error("Order creation failed");
  return orderId as string;
}
