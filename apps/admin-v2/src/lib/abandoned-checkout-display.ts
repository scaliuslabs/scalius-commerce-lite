export interface AbandonedCheckoutDisplayRecord {
  id: string;
  checkoutId: string | null;
  customerPhone: string | null;
  checkoutData: string;
}

export interface AbandonedCheckoutCartItem {
  id: string;
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
}

export type AbandonedCheckoutStageVariant = "secondary" | "outline" | "default";

export interface ParsedAbandonedCheckoutDisplay {
  kind: "cart" | "stale_hosted_payment_order" | "unknown";
  stage: string;
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
  if (!normalized) return "Unknown";

  const compact = normalized.replace(/^chk_session_/i, "") || normalized;
  if (compact.length <= 16) return compact;
  return `${compact.slice(0, 7)}…${compact.slice(-5)}`;
}

export function formatAbandonedCheckoutItemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

export function formatAbandonedCheckoutRecordCount(count: number): string {
  return `${count} checkout ${count === 1 ? "record" : "records"}`;
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
    phone: asString(data.customerPhone),
    address: asString(data.shippingAddress),
    notes: asString(data.notes),
    email: asString(data.customerEmail),
  };
  const hasCustomerInfo = Object.values(customerInfo).some(Boolean);

  return {
    kind: "cart",
    stage: hasCustomerInfo
      ? "Info Captured"
      : items.length > 0
        ? "Cart Started"
        : "Session Created",
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
  return value === "stripe" || value === "sslcommerz" || value === "polar";
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
    phone: asString(data.customerPhone),
    address: asString(data.shippingAddress),
    notes: asString(data.notes),
    email: asString(data.customerEmail),
  };

  return {
    kind: "stale_hosted_payment_order",
    stage: "Archived hosted payment",
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

    const archivedOrder = parseArchivedHostedOrder(data);
    if (archivedOrder) return archivedOrder;

    const cartDisplay = parseCartShape(data);
    const phone = checkout.customerPhone ?? cartDisplay.customerInfo.phone ?? null;
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
          ? "Info Captured"
          : cartDisplay.stage,
    };
  } catch {
    return {
      kind: "unknown",
      stage: "Unreadable",
      variant: "outline",
      items: [],
      customerInfo: {
        phone: checkout.customerPhone,
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
