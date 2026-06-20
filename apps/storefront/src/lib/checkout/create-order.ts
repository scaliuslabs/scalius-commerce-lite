/**
 * Creates an order via the server-side proxy.
 * Shared by all gateway handlers.
 */
import { getCheckoutErrorMessage } from "./error-messages";
import type { CreateOrderPayload } from "../api/types";
import type { CartValidationIssue } from "../api/orders";

type PaymentMethod = NonNullable<CreateOrderPayload["paymentMethod"]>;

type CheckoutCartLine = {
  id: string;
  variantId?: string;
  quantity: number;
  price: number;
  name?: string;
  size?: string;
  color?: string;
};

type ErrorPayload = {
  error?: unknown;
  details?: unknown;
};

export class CheckoutOrderError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly cartIssues: CartValidationIssue[];

  constructor(message: string, options: {
    status: number;
    details: unknown;
    cartIssues: CartValidationIssue[];
  }) {
    super(message);
    this.name = "CheckoutOrderError";
    this.status = options.status;
    this.details = options.details;
    this.cartIssues = options.cartIssues;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function readOptionalString(value: unknown): string | null {
  const str = readString(value).trim();
  return str ? str : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function variantLabelForCartLine(item: CheckoutCartLine): string | null {
  const parts = [item.size, item.color]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map((part) => part.trim());
  return parts.length > 0 ? parts.join(" / ") : null;
}

function extractCartIssues(payload: ErrorPayload): CartValidationIssue[] {
  const details = payload.details;
  if (isRecord(details) && Array.isArray(details.itemIssues)) {
    return details.itemIssues as CartValidationIssue[];
  }
  const error = payload.error;
  if (isRecord(error) && isRecord(error.details) && Array.isArray(error.details.itemIssues)) {
    return error.details.itemIssues as CartValidationIssue[];
  }
  return [];
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
): Promise<{ orderId: string; receiptToken: string; totalAmount?: number; paymentMethod?: string }> {
  let cartItems: Record<string, CheckoutCartLine> = {};
  try {
    cartItems = JSON.parse((checkoutData.cartItems as string) || "{}");
  } catch {
    // ignore parse errors
  }

  const items = Object.entries(cartItems).map(([cartKey, item]) => ({
    cartKey,
    productId: item.id,
    variantId: item.variantId && item.variantId !== "default" ? item.variantId : null,
    quantity: item.quantity,
    price: item.price,
    productName: typeof item.name === "string" ? item.name : null,
    variantLabel: variantLabelForCartLine(item),
  }));
  const discount = parseDiscountInput(checkoutData);
  const checkoutRequestId = readString(
    checkoutData.checkoutRequestId ?? checkoutData.checkoutId,
  ).trim();

  if (!checkoutRequestId) {
    throw new Error("Checkout session expired. Please refresh checkout and try again.");
  }

  const payload: CreateOrderPayload = {
    checkoutRequestId,
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
    const err = await res.json().catch(() => ({} as ErrorPayload)) as ErrorPayload;
    throw new CheckoutOrderError(
      getCheckoutErrorMessage(err, `Order creation failed (${res.status})`),
      {
        status: res.status,
        details: err.details,
        cartIssues: extractCartIssues(err),
      },
    );
  }

  const data = await res.json();
  const orderId = data.data?.id || data.orderId || data.id || data.order?.id;
  const receiptToken = data.data?.receiptToken || data.receiptToken || data.checkoutToken;
  const totalAmount = typeof data.data?.totalAmount === "number"
    ? data.data.totalAmount
    : typeof data.totalAmount === "number"
      ? data.totalAmount
      : undefined;
  const resolvedPaymentMethod = typeof data.data?.paymentMethod === "string"
    ? data.data.paymentMethod
    : typeof data.paymentMethod === "string"
      ? data.paymentMethod
      : undefined;
  if (!orderId) throw new Error("Order creation failed");
  if (!receiptToken) throw new Error("Order receipt token missing");
  return {
    orderId: orderId as string,
    receiptToken: receiptToken as string,
    totalAmount,
    paymentMethod: resolvedPaymentMethod,
  };
}
