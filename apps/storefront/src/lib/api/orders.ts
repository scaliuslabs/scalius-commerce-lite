// src/lib/api/orders.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { OrderReceipt, CreateOrderPayload } from "./types";
import { unwrapData } from "./unwrap";
import { getCheckoutErrorMessage } from "@/lib/checkout/error-messages";

type CreateOrderResult = {
  success: boolean;
  orderId?: string;
  receiptToken?: string;
  totalAmount?: number;
  paymentMethod?: string;
  status?: number;
  error?: string;
  details?: unknown;
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
    | "PRICE_CHANGED";
  action: "remove" | "select_variant" | "reduce_quantity" | "refresh_item";
  message: string;
  productName: string | null;
  variantLabel: string | null;
  requestedQuantity: number;
  availableQuantity?: number;
  submittedPrice?: number;
  currentPrice?: number;
};

export type CartValidationRequestItem = {
  cartKey?: string | null;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName?: string | null;
  variantLabel?: string | null;
};

export type CartValidationResult = {
  valid: boolean;
  issues: CartValidationIssue[];
  items: Array<{
    index: number;
    cartKey?: string | null;
    productId: string;
    variantId: string | null;
    quantity: number;
    unitPrice: number;
    productName: string;
    variantLabel: string | null;
    freeDelivery: boolean;
    availableQuantity: number | null;
  }>;
  subtotal: number;
  hasFreeDeliveryProduct: boolean;
  delivery?: {
    shippingCharge: number;
    cityName: string;
    zoneName: string;
    areaName: string | null;
  };
};

export type CartValidationOptions = {
  inventoryPool?: "regular" | "preorder" | "backorder";
  city?: string | null;
  zone?: string | null;
  area?: string | null;
  shippingMethodId?: string | null;
};

type OrderStatusData = {
  status?: string;
  orderId?: string;
  receiptToken?: string;
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

/**
 * Submits a new order to the backend.
 * This is an authenticated request.
 *
 * @param payload The data for the new order, including customer info and items.
 * @returns A promise resolving to an object with the new order's ID or an error.
 */
export async function createOrder(
  payload: CreateOrderPayload,
  options: CreateOrderOptions = {},
): Promise<CreateOrderResult> {
  try {
    // Use fetchWithRetry directly for orders because this mutation must not
    // be retried automatically. The 202 branch below is legacy compatibility;
    // the normal buyer path returns a committed order synchronously.
    const url = createApiUrl("/orders");
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.customerSessionToken
            ? { "X-Customer-Session": options.customerSessionToken }
            : {}),
        },
        body: JSON.stringify(payload),
      },
      0, // Do not retry the actual creation to prevent double ingestion
      15000,
      true,
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
        totalAmount?: number;
        paymentMethod?: string;
      };
    };

    if (!response.ok || !data.success) {
      const errorMsg = getCheckoutErrorMessage(data);
      const details = getApiErrorDetails(data);

      console.error("Failed to create order:", errorMsg);
      return { success: false, error: errorMsg, status: response.status, details };
    }

    // Capture the 202 Async Accepted queue payload and poll for completion!
    if (response.status === 202 && data.success && data.data?.checkoutToken) {
      const checkoutToken = data.data.checkoutToken;
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

        const statusRes = await fetchWithRetry(createApiUrl(`/orders/status/${checkoutToken}`), {}, 2, 5000, true);

        if (statusRes.ok) {
          const statusJson = (await statusRes.json()) as OrderStatusPayload;
          // Status endpoint uses ok() wrapper: { success: true, data: { status, orderId } }
          // But 202 responses use raw c.json(): { status: "processing" }
          const statusData = statusJson.data ?? statusJson;
          if (statusData.status === "completed") {
            return {
              success: true,
              orderId: statusData.orderId || initialOrderId,
              receiptToken: statusData.receiptToken || checkoutToken,
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
      receiptToken: data.data?.receiptToken || data.data?.checkoutToken,
      totalAmount: typeof data.data?.totalAmount === "number" ? data.data.totalAmount : undefined,
      paymentMethod: data.data?.paymentMethod,
      status: response.status,
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

export async function validateCartItems(
  items: CartValidationRequestItem[],
  options: CartValidationOptions = {},
): Promise<{ success: true; data: CartValidationResult } | { success: false; error: string; status?: number; details?: unknown }> {
  try {
    const response = await fetchWithRetry(
      createApiUrl("/orders/cart-validation"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, ...options }),
      },
      1,
      8000,
      true,
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
        error: getCheckoutErrorMessage(json, "Cart validation failed"),
        details: getApiErrorDetails(json),
      };
    }

    return { success: true, data: json.data };
  } catch (error: unknown) {
    console.error("Error validating cart:", error);
    return {
      success: false,
      status: 500,
      error: "Cart validation failed",
    };
  }
}

export async function getOrderReceipt(
  orderId: string,
  receiptToken: string,
): Promise<OrderReceipt | null> {
  if (!orderId || !receiptToken) {
    console.error("getOrderReceipt: orderId and receiptToken are required.");
    return null;
  }

  try {
    const params = new URLSearchParams({ token: receiptToken });
    const response = await fetchWithRetry(
      createApiUrl(`/orders/receipt/${encodeURIComponent(orderId)}?${params}`),
      {},
      2,
      5000,
      true,
    );
    if (!response.ok) return null;

    const data = await response.json();
    return unwrapData<{ order: OrderReceipt }>(data)?.order ?? null;
  } catch (error: unknown) {
    console.error(`Error fetching receipt for order "${orderId}":`, error);
    return null;
  }
}
