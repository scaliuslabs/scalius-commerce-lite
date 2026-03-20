// src/lib/api/abandoned-checkouts.ts
import { getConfiguredSdkClient, getConfiguredSdkAuthClient } from "./client";
import {
  postApiV1AbandonedCheckouts,
  postApiV1AbandonedCheckoutsCleanup,
} from "@scalius/api-client/sdk";

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
  try {
    await postApiV1AbandonedCheckouts({
      client: getConfiguredSdkClient(),
      body: payload as any,
    });
  } catch (error: unknown) {
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
  try {
    await postApiV1AbandonedCheckoutsCleanup({
      client: getConfiguredSdkAuthClient(),
      body: { checkoutId } as any,
    });
  } catch (error: unknown) {
    // Log a warning but don't let this failure block the user's success flow.
    console.warn(`Non-critical error: Failed to delete abandoned checkout record for ${checkoutId}. It may be cleaned up later.`, error);
  }
}
