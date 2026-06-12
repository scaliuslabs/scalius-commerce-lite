/**
 * Creates an order via the server-side proxy.
 * Shared by all gateway handlers.
 */
import { getCheckoutErrorMessage } from "./error-messages";
import type { CreateOrderPayload } from "@/lib/api/types";

type PaymentMethod = NonNullable<CreateOrderPayload["paymentMethod"]>;

function readString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function readOptionalString(value: unknown): string | null {
  const str = readString(value).trim();
  return str ? str : null;
}

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
  paymentMethod: PaymentMethod,
): Promise<{ orderId: string; receiptToken: string }> {
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

  const payload: CreateOrderPayload = {
    customerName: readString(checkoutData.customerName),
    customerPhone: readString(checkoutData.customerPhone),
    customerEmail: readOptionalString(checkoutData.customerEmail),
    shippingAddress: readString(checkoutData.shippingAddress),
    city: readString(checkoutData.city),
    zone: readString(checkoutData.zone),
    area: readOptionalString(checkoutData.area),
    cityName: readOptionalString(checkoutData.cityName),
    zoneName: readOptionalString(checkoutData.zoneName),
    areaName: readOptionalString(checkoutData.areaName),
    notes: readOptionalString(checkoutData.notes),
    items,
    shippingCharge: parseFloat((checkoutData.shippingCharge as string) || "0"),
    shippingMethodId: readOptionalString(checkoutData.shippingMethodId),
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
  const receiptToken = data.data?.receiptToken || data.receiptToken || data.checkoutToken;
  if (!orderId) throw new Error("Order creation failed");
  if (!receiptToken) throw new Error("Order receipt token missing");
  return { orderId: orderId as string, receiptToken: receiptToken as string };
}
