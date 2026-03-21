// src/lib/api/orders.ts

import { createApiUrl, fetchWithRetry, getConfiguredSdkAuthClient } from "./client";
import type { Order, CreateOrderPayload } from "./types";
import { unwrapData } from "./unwrap";
import { getApiV1OrdersById } from "@scalius/api-client/sdk";

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
      error?: string | { message?: string };
      details?: string;
      message?: string;
      data?: { id?: string; orderId?: string; checkoutToken?: string };
    };

    if (!response.ok || !data.success) {
      const errorMsg = typeof data.error === 'string'
        ? data.error
        : (typeof data.error === 'object' && data.error?.message) || data.details || data.message || "Order creation failed";

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
          const statusJson = await statusRes.json() as Record<string, any>;
          // Status endpoint uses ok() wrapper: { success: true, data: { status, orderId } }
          // But 202 responses use raw c.json(): { status: "processing" }
          const statusData: Record<string, any> = statusJson.data ?? statusJson;
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
  } catch (error: unknown) {
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
