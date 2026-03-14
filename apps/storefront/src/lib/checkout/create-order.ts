/**
 * Creates an order via the server-side proxy.
 * Shared by all gateway handlers.
 */
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
    discountAmount: parseFloat((checkoutData.discountAmount as string) || "0") || null,
    discountCode: checkoutData.discountCodeHidden || undefined,
    paymentMethod,
  };

  const res = await fetch("/api/checkout/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({} as Record<string, unknown>));
    const errObj = err.error;
    const errMsg =
      typeof errObj === "string"
        ? errObj
        : (errObj as Record<string, unknown> | undefined)?.message || `Order creation failed (${res.status})`;
    throw new Error(errMsg as string);
  }

  const data = await res.json();
  const orderId = data.data?.id || data.orderId || data.id || data.order?.id;
  if (!orderId) throw new Error("Order creation failed");
  return orderId as string;
}
