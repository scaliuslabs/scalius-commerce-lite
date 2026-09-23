import { validateAndFormatPhone } from "@scalius/shared/customer-utils";

export interface AbandonedCheckoutDisplayRecord {
  id: string;
  checkoutId: string | null;
  customerPhone: string | null;
  checkoutData: string;
}

export interface AbandonedCheckoutCartItem {
  id: string;
  variantId?: string;
  name: string;
  quantity: number;
  price: number;
  options?: Array<{ name: string; value: string }>;
  [key: string]: unknown;
}

export interface AbandonedCheckoutCustomerInfo {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  email?: string | null;
  location?: string | null;
}

export type AbandonedCheckoutStageVariant = "secondary" | "outline" | "default";

/** Catalog key suffix for how far the customer got (see `stage.*` in i18n/order-list). */
export type AbandonedCheckoutStage =
  | "infoCaptured"
  | "cartStarted"
  | "sessionCreated"
  | "paymentNotFinished"
  | "unreadable";

export interface ParsedAbandonedCheckoutDisplay {
  kind: "cart" | "stale_hosted_payment_order" | "unknown";
  stage: AbandonedCheckoutStage;
  variant: AbandonedCheckoutStageVariant;
  items: AbandonedCheckoutCartItem[];
  customerInfo: AbandonedCheckoutCustomerInfo;
  total: number;
  orderId: string | null;
  paymentMethod: string | null;
  paymentStatus: string | null;
  paidAmount: number | null;
  balanceDue: number | null;
}

export function formatAbandonedCheckoutId(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) return "—";

  const compact = normalized.replace(/^chk_session_/i, "") || normalized;
  if (compact.length <= 16) return compact;
  return `${compact.slice(0, 7)}…${compact.slice(-5)}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asValidPhone(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length > 32) return null;

  try {
    return validateAndFormatPhone(value);
  } catch {
    return null;
  }
}

function readableLocation(data: Record<string, unknown>): string | null {
  const parts = [
    asString(data.areaName),
    asString(data.zoneName),
    asString(data.cityName),
  ].filter((value): value is string => Boolean(value));

  const uniqueParts = [...new Set(parts)];
  return uniqueParts.length > 0 ? uniqueParts.join(", ") : null;
}

function parseCartItems(value: unknown): AbandonedCheckoutCartItem[] {
  return Array.isArray(value)
    ? value.flatMap((item): AbandonedCheckoutCartItem[] => {
        const candidate = asObject(item);
        if (!candidate || !(
            typeof candidate.id === "string" &&
            typeof candidate.name === "string" &&
            typeof candidate.quantity === "number" &&
            Number.isFinite(candidate.quantity) &&
            candidate.quantity > 0 &&
            typeof candidate.price === "number" &&
            Number.isFinite(candidate.price) &&
            candidate.price >= 0
        )) return [];

        const options = Array.isArray(candidate.options)
          ? candidate.options.flatMap((option) => {
              const parsed = asObject(option);
              const name = asString(parsed?.name);
              const value = asString(parsed?.value);
              return name && value ? [{ name, value }] : [];
            })
          : undefined;

        return [{
          ...candidate,
          id: candidate.id,
          variantId: asString(candidate.variantId) ?? undefined,
          name: candidate.name,
          quantity: candidate.quantity,
          price: candidate.price,
          options,
        }];
      })
    : [];
}

function parseCartShape(data: Record<string, unknown>): ParsedAbandonedCheckoutDisplay {
  const cart = asObject(data.cart);
  const items = parseCartItems(cart?.items);
  const total = asNumber(cart?.totalAmount) ?? 0;
  const customerInfo: AbandonedCheckoutCustomerInfo = {
    name: asString(data.customerName),
    phone: asValidPhone(data.customerPhone),
    address: asString(data.shippingAddress),
    notes: asString(data.notes),
    email: asString(data.customerEmail),
    location: readableLocation(data),
  };
  const hasCustomerInfo = Object.values(customerInfo).some(Boolean);

  return {
    kind: "cart",
    stage: hasCustomerInfo
      ? "infoCaptured"
      : items.length > 0
        ? "cartStarted"
        : "sessionCreated",
    variant: hasCustomerInfo ? "default" : items.length > 0 ? "secondary" : "outline",
    items,
    customerInfo,
    total,
    orderId: null,
    paymentMethod: null,
    paymentStatus: null,
    paidAmount: null,
    balanceDue: null,
  };
}

function isHostedPaymentMethod(value: string | null): boolean {
  return Boolean(value) && value !== "cod";
}

function parseArchivedHostedOrder(data: Record<string, unknown>): ParsedAbandonedCheckoutDisplay | null {
  const orderId = asString(data.id);
  const paymentMethod = asString(data.paymentMethod);
  const paymentStatus = asString(data.paymentStatus);

  if (
    !orderId ||
    !isHostedPaymentMethod(paymentMethod) ||
    (paymentStatus !== "unpaid" && paymentStatus !== "failed")
  ) {
    return null;
  }

  const customerInfo: AbandonedCheckoutCustomerInfo = {
    name: asString(data.customerName),
    phone: asValidPhone(data.customerPhone),
    address: asString(data.shippingAddress),
    notes: asString(data.notes),
    email: asString(data.customerEmail),
    location: readableLocation(data),
  };

  return {
    kind: "stale_hosted_payment_order",
    stage: "paymentNotFinished",
    variant: "outline",
    items: [],
    customerInfo,
    total: asNumber(data.totalAmount) ?? 0,
    orderId,
    paymentMethod,
    paymentStatus,
    paidAmount: asNumber(data.paidAmount),
    balanceDue: asNumber(data.balanceDue),
  };
}

export function parseAbandonedCheckoutDisplay(
  checkout: AbandonedCheckoutDisplayRecord,
): ParsedAbandonedCheckoutDisplay {
  try {
    const data = asObject(JSON.parse(checkout.checkoutData));
    if (!data) throw new Error("Checkout data is not an object");
    const storedPhone = asValidPhone(checkout.customerPhone);

    const archivedOrder = parseArchivedHostedOrder(data);
    if (archivedOrder) {
      return {
        ...archivedOrder,
        customerInfo: {
          ...archivedOrder.customerInfo,
          phone: storedPhone ?? archivedOrder.customerInfo.phone ?? null,
        },
      };
    }

    const cartDisplay = parseCartShape(data);
    const phone = storedPhone ?? cartDisplay.customerInfo.phone ?? null;
    return {
      ...cartDisplay,
      customerInfo: {
        ...cartDisplay.customerInfo,
        phone,
      },
      variant:
        phone || Object.values(cartDisplay.customerInfo).some(Boolean)
          ? "default"
          : cartDisplay.variant,
      stage:
        phone || Object.values(cartDisplay.customerInfo).some(Boolean)
          ? "infoCaptured"
          : cartDisplay.stage,
    };
  } catch {
    return {
      kind: "unknown",
      stage: "unreadable",
      variant: "outline",
      items: [],
      customerInfo: {
        phone: asValidPhone(checkout.customerPhone),
      },
      total: 0,
      orderId: null,
      paymentMethod: null,
      paymentStatus: null,
      paidAmount: null,
      balanceDue: null,
    };
  }
}
