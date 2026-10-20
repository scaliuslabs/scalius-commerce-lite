// src/lib/api/orders.ts

import { apiFetch } from "./transport";
import { getRuntimePresence } from "./runtime";
import { isMarketSubfolder } from "@scalius/shared/markets";
import { CUSTOMER_SESSION_ENDED_HEADER } from "@scalius/shared/customer-auth-policy";
import type { BuyerUiBlock } from "@scalius/shared/plugins/buyer-ui";
import { buyerUiLocaleHeaders } from "@/lib/buyer-ui/locale";
import type { OrderLineProperty, OrderReceipt, CreateOrderPayload } from "./types";
import type {
  DeliveryMethodKind,
  FulfillmentKind,
  FulfillmentType,
} from "@scalius/shared/fulfilment";
import { unwrapData } from "./unwrap";
import { getCheckoutErrorMessage } from "@/lib/checkout/error-messages";
import { parseCartRuleErrors } from "@/lib/checkout/tax-quote-error-contract";

export class OrderReceiptAccessError extends Error {
  constructor(public readonly status: number) {
    super(status === 404 ? "Order receipt proof is invalid or expired." : "Order receipt is unavailable.");
    this.name = "OrderReceiptAccessError";
  }
}

type CreateOrderResult = {
  success: boolean;
  orderId?: string;
  receiptToken?: string;
  statusToken?: string;
  totalAmount?: number;
  paymentMethod?: string;
  status?: number;
  errorCode?: string;
  error?: string;
  details?: unknown;
  /** The session sent no longer signs anyone in: the order is a guest's; clear the session cookies. */
  customerSessionEnded?: boolean;
};

export type CartValidationIssue = {
  index: number;
  cartKey?: string | null;
  productId: string;
  variantId: string | null;
  code:
    | "PRODUCT_UNAVAILABLE"
    | "VARIANT_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "QUANTITY_UNAVAILABLE"
    | "PRICE_CHANGED"
    | "PROPERTIES_REQUIRED"
    | "PROPERTIES_INVALID"
    | "FULFILMENT_UNAVAILABLE";
  action: "remove" | "select_variant" | "reduce_quantity" | "refresh_item" | "edit_properties";
  message: string;
  productName: string | null;
  variantLabel: string | null;
  requestedQuantity: number;
  availableQuantity?: number;
  submittedPrice?: number;
  currentPrice?: number;
  /** The buyer input a PROPERTIES_* issue is about, when it is one field. */
  propertyKey?: string | null;
};

/**
 * A store app's checkout rule that blocks the order ("At most 10 per order").
 * `message` is the app's own buyer-facing text: shown as text, never markup,
 * and never translated. `index`/`cartKey` name the line like `issues[]` do;
 * both null mean the whole cart.
 */
export type CartRuleError = {
  code: string;
  message: string;
  index: number | null;
  cartKey: string | null;
};

export type CartValidationRequestItem = {
  cartKey?: string | null;
  productId: string;
  variantId: string;
  quantity: number;
  /** The unit price the buyer saw: base plus the surcharges of its buyer inputs. */
  price: number;
  productName?: string | null;
  variantLabel?: string | null;
  /** Buyer inputs, body only (never a URL). */
  properties?: Array<{ key: string; value: string }>;
};

export type CartValidationItem = {
  index: number;
  cartKey?: string | null;
  productId: string;
  variantId: string;
  quantity: number;
  /** One unit: base plus surcharges. */
  unitPrice: number;
  /** One unit before the surcharges of its buyer inputs. */
  baseUnitPrice?: number;
  propertiesPrice?: number;
  propertiesPriceMinor?: number;
  /** The inputs as the order will keep them (labels frozen). */
  properties?: OrderLineProperty[];
  /** Apps' add-ons to each unit, in `unitPrice` ("Add-on: …"); never sent back. */
  adjustments?: OrderLineProperty[];
  /** Canonical inputs hash for the v3 line key; "none" without inputs. */
  propertiesHash?: string;
  fulfillmentKind?: FulfillmentKind;
  /** Null for a physical line until a delivery or pickup method is chosen. */
  fulfillmentType?: FulfillmentType | null;
  productName: string;
  variantLabel: string | null;
  freeDelivery: boolean;
  availableQuantity: number | null;
  productImageMediaId: string | null;
  productImage: string | null;
};

export type CartValidationResult = {
  buyerUi?: import("@scalius/shared/plugins/buyer-ui").BuyerUiBlock[];
  valid: boolean;
  issues: CartValidationIssue[];
  /**
   * Store app rules that block checkout; checked only when `issues` is empty
   * (`valid` is false whenever there is one). Absent from older APIs.
   */
  ruleErrors?: CartRuleError[];
  items: CartValidationItem[];
  subtotal: number;
  /** The cart's currency: its market's (MARKETS-DESIGN step 6). Absent from older APIs. */
  currencyCode?: string;
  hasFreeDeliveryProduct: boolean;
  /** Some line is physical: the buyer chooses delivery or pickup. */
  requiresDeliveryMethod?: boolean;
  /** The chosen method's kind; null until one is chosen or when nothing is physical. */
  deliveryMethodKind?: DeliveryMethodKind | null;
  /** Some line ships to an address. */
  requiresShipping?: boolean;
  /** Payment methods this cart may use (no cash on delivery when nothing is handed over). */
  allowedPaymentMethods?: string[];
  delivery?: {
    kind?: DeliveryMethodKind;
    shippingCharge: number;
    shippingMethod: {
      id: string;
      name: string;
      description: string | null;
      baseAmountMinor: number;
      feeWaived: boolean;
    };
    /** Null for pickup. */
    cityName: string | null;
    zoneName: string | null;
    areaName: string | null;
    pickup?: { address: string | null; hours: string | null } | null;
  };
};

export type CartValidationOptions = {
  attributes?: Record<string, string>;
  inventoryPool?: "regular" | "preorder" | "backorder";
  /** Another country's delivery (absent: Bangladesh, with City/Thana/Area). */
  shippingCountryCode?: string | null;
  city?: string | null;
  zone?: string | null;
  area?: string | null;
  /** Another country's region and postal code: its shipping zone matches on them. */
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
  shippingMethodId?: string | null;
  shippingRateToken?: string | null;
  cod?: boolean;
  /** The page's subfolder presence (`en-in`): before an address, its market prices the cart. */
  presence?: string | null;
};

type OrderStatusData = {
  status?: string;
  orderId?: string;
  error?: string;
};

type OrderStatusPayload = OrderStatusData & {
  data?: OrderStatusData;
};

type CreateOrderOptions = {
  customerSessionToken?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getApiErrorDetails(data: unknown): unknown {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.error) && "details" in data.error) return data.error.details;
  return data.details;
}

function getApiErrorCode(data: unknown): string | undefined {
  if (!isRecord(data) || !isRecord(data.error)) return undefined;
  return typeof data.error.code === "string" ? data.error.code : undefined;
}

/**
 * Submits a new order to the backend.
 * This is an authenticated request.
 *
 * @param payload The data for the new order, including customer info and items.
 * @returns A promise resolving to an object with the new order's ID or an error.
 */
export async function createOrder(
  // `trackingSignals` is set only by the checkout proxy, from the buyer's request.
  payload: CreateOrderPayload,
  options: CreateOrderOptions = {},
): Promise<CreateOrderResult> {
  try {
    // Call apiFetch with retries: 0 because this mutation must not be retried
    // automatically. The 202 branch below is legacy compatibility;
    // the normal buyer path returns a committed order synchronously.
    const path = "/orders";
    const response = await apiFetch(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.customerSessionToken
            ? { "X-Customer-Session": options.customerSessionToken }
            : {}),
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      },
      // Do not retry the actual creation to prevent double ingestion
      { retries: 0, timeout: 15000, auth: false },
    );

    const data = await response.json() as {
      success?: boolean;
      error?: unknown;
      details?: unknown;
      message?: unknown;
      data?: {
        id?: string;
        orderId?: string;
        checkoutToken?: string;
        receiptToken?: string;
        statusToken?: string;
        totalAmount?: number;
        paymentMethod?: string;
      };
    };

    if (!response.ok || !data.success) {
      const errorMsg = getCheckoutErrorMessage(data);
      const details = getApiErrorDetails(data);
      const errorCode = getApiErrorCode(data);

      console.error("Failed to create order:", errorMsg);
      return { success: false, error: errorMsg, errorCode, status: response.status, details };
    }

    // Capture the 202 Async Accepted queue payload and poll for completion!
    if (response.status === 202 && data.success && data.data?.statusToken) {
      const statusToken = data.data.statusToken;
      const initialOrderId = data.data.orderId;

      // Adaptive polling: start fast (200ms), back off gradually.
      // The queue typically completes in 2-3s. Fixed 1.5s intervals waste
      // 15-20s; adaptive polling catches completion in 3-4s on average.
      const pollIntervals = [
        200, 200, 300, 300, 500, 500, 500,  // First 2.5s: aggressive
        1000, 1000, 1000, 1000,             // Next 4s: moderate
        2000, 2000, 2000, 2000, 2000,       // Next 10s: relaxed
        3000, 3000, 3000, 3000,             // Final 12s: slow
      ]; // Total: ~28.5s across 20 attempts

      for (let i = 0; i < pollIntervals.length; i++) {
        await new Promise(resolve => setTimeout(resolve, pollIntervals[i]));

        const statusRes = await apiFetch(
          `/orders/status/${encodeURIComponent(statusToken)}`,
          {},
          { retries: 2, timeout: 5000, auth: false },
        );

        if (statusRes.ok) {
          const statusJson = (await statusRes.json()) as OrderStatusPayload;
          // Status endpoint uses ok() wrapper: { success: true, data: { status, orderId } }
          // But 202 responses use raw c.json(): { status: "processing" }
          const statusData = statusJson.data ?? statusJson;
          if (statusData.status === "completed") {
            const replayResponse = await apiFetch(
              path,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(options.customerSessionToken
                    ? { "X-Customer-Session": options.customerSessionToken }
                    : {}),
                },
                body: JSON.stringify(payload),
                cache: "no-store",
              },
              { retries: 0, timeout: 15000, auth: false },
            );
            const replayData = await replayResponse.json() as {
              success?: boolean;
              data?: {
                id?: string;
                orderId?: string;
                receiptToken?: string;
                totalAmount?: number;
                paymentMethod?: string;
              };
            };

            if (replayResponse.ok && replayData.success && replayData.data?.receiptToken) {
              return {
                success: true,
                orderId: replayData.data.orderId || replayData.data.id || statusData.orderId || initialOrderId,
                receiptToken: replayData.data.receiptToken,
                statusToken,
                totalAmount: typeof replayData.data.totalAmount === "number" ? replayData.data.totalAmount : undefined,
                paymentMethod: replayData.data.paymentMethod,
                status: replayResponse.status,
              };
            }

            if (!replayResponse.ok || !replayData.success) {
              return {
                success: false,
                status: replayResponse.status,
                error: getCheckoutErrorMessage(replayData),
                errorCode: getApiErrorCode(replayData),
                details: getApiErrorDetails(replayData),
              };
            }

            return { success: false, error: "Order completed but receipt proof is unavailable. Please check your order history." };
          } else if (statusData.status === "expired") {
            return {
              success: false,
              status: 409,
              errorCode: "CHECKOUT_ATTEMPT_EXPIRED",
              error: "This checkout has ended. Please review your cart before placing a new order.",
            };
          } else if (statusData.status === "failed") {
            return { success: false, error: statusData.error || "Order ingestion failed during high traffic. Please try again." };
          }
        }
      }

      return { success: false, error: "Order processing timed out. Please check your order history." };
    }

    // Normal synchronous return
    return {
      success: true,
      orderId: data.data?.id || data.data?.orderId,
      receiptToken: data.data?.receiptToken,
      statusToken: data.data?.statusToken,
      totalAmount: typeof data.data?.totalAmount === "number" ? data.data.totalAmount : undefined,
      paymentMethod: data.data?.paymentMethod,
      status: response.status,
      customerSessionEnded: response.headers.get(CUSTOMER_SESSION_ENDED_HEADER) === "1",
    };
  } catch (error: unknown) {
    console.error("Error creating order:", error);
    return {
      success: false,
      status: 500,
      error: "Order creation failed",
    };
  }
}

/** The presence a cart check carries: the caller's, else (on the server) the render's. */
function cartPresence(presence: string | null | undefined): { presence?: string } {
  const value = presence ?? (import.meta.env.SSR ? getRuntimePresence() : null);
  return value && isMarketSubfolder(value) ? { presence: value } : {};
}

export async function validateCartItems(
  items: CartValidationRequestItem[],
  options: CartValidationOptions = {},
  customerSessionToken?: string | null,
  buyerHeaders?: Headers,
): Promise<{ success: true; data: CartValidationResult } | { success: false; error: string; status?: number; details?: unknown }> {
  try {
    const response = await apiFetch(
      "/orders/cart-validation",
      {
        method: "POST",
        headers: {
          ...await buyerUiLocaleHeaders(buyerHeaders),
          "Content-Type": "application/json",
          ...(customerSessionToken ? { "X-Customer-Session": customerSessionToken } : {}),
        },
        // A presence page's market prices the cart (server renders know their presence).
        body: JSON.stringify({ items, ...options, ...cartPresence(options.presence) }),
        cache: "no-store",
      },
      { retries: 1, timeout: 8000, auth: false },
    );

    const json = await response.json() as {
      success?: boolean;
      data?: CartValidationResult;
      error?: unknown;
      details?: unknown;
    };

    if (!response.ok || !json.success || !json.data) {
      return {
        success: false,
        status: response.status,
        error: getCheckoutErrorMessage(json, "We couldn't check your cart. Try again."),
        details: getApiErrorDetails(json),
      };
    }

    // App rule messages are bounded and checked here, once, for every reader.
    const data = json.data.ruleErrors === undefined
      ? json.data
      : { ...json.data, ruleErrors: parseCartRuleErrors(json.data.ruleErrors) };
    return { success: true, data };
  } catch (error: unknown) {
    console.error("Error validating cart:", error);
    return {
      success: false,
      status: 500,
      error: "We couldn't check your cart. Try again.",
    };
  }
}

/**
 * Server-side only: a signed-in account owner who lacks this browser's receipt
 * cookie (the order email's link, another device) gets a fresh private proof.
 * Returns null when the session does not own the order.
 */
export async function getAccountOwnerReceiptProof(
  orderId: string,
  customerSessionToken: string,
): Promise<string | null> {
  const response = await apiFetch(
    `/orders/receipt/${encodeURIComponent(orderId)}/owner-proof`,
    {
      method: "POST",
      headers: { "X-Customer-Session": customerSessionToken },
      cache: "no-store",
    },
    { retries: 0, timeout: 5000, auth: true },
  );
  if (!response.ok) return null;
  const data = unwrapData<{ receiptToken?: unknown }>(await response.json());
  return typeof data?.receiptToken === "string" ? data.receiptToken : null;
}

export async function getOrderReceipt(
  orderId: string,
  receiptToken: string,
): Promise<(OrderReceipt & { buyerUi?: BuyerUiBlock[] }) | null> {
  if (!orderId || !receiptToken) {
    console.error("getOrderReceipt: orderId and receiptToken are required.");
    return null;
  }

  const response = await apiFetch(
    `/orders/receipt/${encodeURIComponent(orderId)}`,
    {
      headers: { "X-Receipt-Token": receiptToken, ...await buyerUiLocaleHeaders() },
      cache: "no-store",
    },
    { retries: 2, timeout: 5000, auth: false },
  );
  if (!response.ok) throw new OrderReceiptAccessError(response.status);

  const data = await response.json();
  const receipt = unwrapData<{ order: OrderReceipt & { buyerUi?: BuyerUiBlock[] } }>(data)?.order ?? null;
  if (!receipt) throw new OrderReceiptAccessError(502);
  return receipt;
}
