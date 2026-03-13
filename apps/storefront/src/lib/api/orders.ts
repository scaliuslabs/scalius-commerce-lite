// src/lib/api/orders.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { Order, CreateOrderPayload } from "./types";

/**
 * Submits a new order to the backend.
 * This is an authenticated request.
 *
 * @param payload The data for the new order, including customer info and items.
 * @returns A promise resolving to an object with the new order's ID or an error.
 */
export async function createOrder(
  payload: CreateOrderPayload,
): Promise<{ success: boolean; orderId?: string; error?: any }> {
  try {
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

    const data: any = await response.json();

    if (!response.ok || !data.success) {
      const errorMsg = typeof data.error === 'string'
        ? data.error
        : (data.error as any)?.message || (data.details as string) || (data.message as string) || "Order creation failed";

      console.error("Failed to create order:", errorMsg);
      return { success: false, error: errorMsg };
    }

    // Capture the 202 Async Accepted queue payload and poll for completion!
    if (response.status === 202 && data.success && data.data?.checkoutToken) {
      const checkoutToken = data.data.checkoutToken;
      const initialOrderId = data.data.orderId;

      let attempts = 0;
      const maxAttempts = 30; // 30 * 1.5s = 45s max wait time

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1500));

        const statusRes = await fetchWithRetry(createApiUrl(`/orders/status/${checkoutToken}`), {}, 2, 5000, true);

        if (statusRes.ok) {
          const statusData = await statusRes.json() as Record<string, any>;
          if (statusData.status === "completed") {
            return { success: true, orderId: statusData.orderId || initialOrderId };
          } else if (statusData.status === "failed") {
            return { success: false, error: statusData.error || "Order ingestion failed during high traffic. Please try again." };
          }
        }
        attempts++;
      }

      return { success: false, error: "Order processing timed out. Please check your order history." };
    }

    // Normal synchronous return
    return { success: true, orderId: data.data?.id || data.data?.orderId };
  } catch (error) {
    console.error("Error creating order:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error occurred",
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
    const url = createApiUrl(`/orders/${orderId}`);
    const response = await fetchWithRetry(url);

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`API error: ${response.status}`);
    }

    const data: { order: Order } = await response.json();
    return data.order;
  } catch (error) {
    console.error(`Error fetching details for order "${orderId}":`, error);
    return null;
  }
}
