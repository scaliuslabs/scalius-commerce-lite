// src/lib/api/abandoned-checkouts.ts
import { getConfiguredSdkClient } from "./transport";
import { postApiV1AbandonedCheckouts } from "@scalius/api-client/sdk";
import type { PostApiV1AbandonedCheckoutsData } from "@scalius/api-client/types";

type AbandonedCheckoutBody = NonNullable<PostApiV1AbandonedCheckoutsData["body"]>;

export interface AbandonedCheckoutPayload {
  checkoutId: string;
  customerPhone?: string;
  checkoutData: AbandonedCheckoutBody["checkoutData"];
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
    const body: AbandonedCheckoutBody = payload;
    await postApiV1AbandonedCheckouts({
      client: getConfiguredSdkClient(),
      body,
    });
  } catch (error: unknown) {
    // The error is logged by apiFetch, so we just swallow it here
    // to prevent it from crashing the client application.
    console.error("Error in saveAbandonedCheckout, but swallowing to prevent UI crash:", error);
  }
}
