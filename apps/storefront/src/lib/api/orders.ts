// src/lib/api/orders.ts

import { createApiUrl, fetchWithRetry, getConfiguredSdkAuthClient } from "./client";
import type { Order, OrderReceipt, CreateOrderPayload } from "./types";
import { unwrapData } from "./unwrap";
import { getApiV1OrdersById } from "@scalius/api-client/sdk";
import { getCheckoutErrorMessage } from "@/lib/checkout/error-messages";

/**
 * Submits a new order to the backend.
 * This is an authenticated request.
 *
 * @param payload The data for the new order, including customer info and items.
 * @returns A promise resolving to an object with the new order's ID or an error.
 */
export async function createOrder(
  payload: CreateOrderPayload,
): Promise<{ success: boolean; orderId?: string; receiptToken?: string; error?: any }> {
  try {
    // Use fetchWithRetry directly for orders because:
    // 1. We need retries=0 to prevent double ingestion
    // 2. We need 15s timeout for this heavy endpoint
    // 3. The 202 polling logic requires raw response access
    const url = createApiUrl("/orders");
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      data?: { id?: string; orderId?: string; checkoutToken?: string; receiptToken?: string };
    };

    if (!response.ok || !data.success) {
      const errorMsg = getCheckoutErrorMessage(data);

      console.error("Failed to create order:", errorMsg);
      return { success: false, error: errorMsg };
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
          const statusJson = await statusRes.json() as Record<string, any>;
          // Status endpoint uses ok() wrapper: { success: true, data: { status, orderId } }
          // But 202 responses use raw c.json(): { status: "processing" }
          const statusData: Record<string, any> = statusJson.data ?? statusJson;
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
    };
  } catch (error: unknown) {
    console.error("Error creating order:", error);
    return {
      success: false,
      error: "Order creation failed",
    };
  }
}

/**
 * Fetches the details of a specific order by its ID.
 * This is an authenticated request.
 *
 * @param orderId The unique identifier of the order.
 * @returns A promise resolving to the full Order object or null if not found.
 */
export async function getOrderDetails(orderId: string): Promise<Order | null> {
  if (!orderId) {
    console.error("getOrderDetails: orderId is required.");
    return null;
  }

  try {
    const { data, error } = await getApiV1OrdersById({
      client: getConfiguredSdkAuthClient(),
      path: { id: orderId },
    });
    if (error) return null;
    return unwrapData<{ order: Order }>(data)?.order ?? null;
  } catch (error: unknown) {
    console.error(`Error fetching details for order "${orderId}":`, error);
    return null;
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
