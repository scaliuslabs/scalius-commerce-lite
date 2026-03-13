// src/lib/api/abandoned-checkouts.ts
import { createApiUrl, fetchWithRetry } from "./client";

export interface AbandonedCheckoutPayload {
  checkoutId: string;
  customerPhone?: string;
  checkoutData: Record<string, any>;
}

/**
 * Sends the current state of the checkout form to the backend
 * to be saved as an abandoned checkout.
 *
 * This is a "fire-and-forget" style request.
 *
 * @param payload The abandoned checkout data.
 */
export async function saveAbandonedCheckout(payload: AbandonedCheckoutPayload): Promise<void> {
  const url = createApiUrl("/abandoned-checkouts");

  try {
    // This is an internal tracking/data-saving endpoint.
    // It is public to allow anonymous users to save their cart state.
    await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        keepalive: true,
      },
      1, // Only one retry
      5000, // 5-second timeout
      false, // Does not require authentication
    );
  } catch (error) {
    // The error is logged by fetchWithRetry, so we just swallow it here
    // to prevent it from crashing the client application.
    console.error("Error in saveAbandonedCheckout, but swallowing to prevent UI crash:", error);
  }
}

/**
 * Deletes an abandoned checkout record from the backend by posting to a cleanup endpoint.
 * This is a "fire-and-forget" style request, called after a successful order.
 *
 * @param checkoutId The ID of the checkout session to delete.
 */
export async function deleteAbandonedCheckout(checkoutId: string): Promise<void> {
  // CHANGE: Point to the new, dedicated cleanup endpoint
  const url = createApiUrl(`/abandoned-checkouts/cleanup`);

  try {
    // This call MUST be authenticated, as it's a destructive action.
    await fetchWithRetry(
      url,
      {
        // CHANGE: Use a simple POST method
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // CHANGE: Send the checkoutId in the request body
        body: JSON.stringify({ checkoutId }),
      },
      1, // Only one retry
      5000, // 5-second timeout
      true, // This call still requires authentication
    );
  } catch (error)
  {
    // Log a warning but don't let this failure block the user's success flow.
    console.warn(`Non-critical error: Failed to delete abandoned checkout record for ${checkoutId}. It may be cleaned up later.`, error);
  }
}