// src/lib/api/tracking.ts

import { createApiUrl, fetchWithRetry } from "./client";

/**
 * Defines the payload structure for sending a server-side event
 * to our backend's /meta/events endpoint. This matches the Zod schema
 * on the backend.
 */
export interface MetaCapiEventPayload {
  eventName:
  | "ViewContent"
  | "Search"
  | "AddToCart"
  | "InitiateCheckout"
  | "AddPaymentInfo"
  | "Purchase"
  | "Lead"
  | "CompleteRegistration";
  eventSourceUrl: string;
  userData: {
    em?: string;
    ph?: string;
    client_ip_address?: string;
    client_user_agent?: string;
    fbp?: string;
    fbc?: string;
    external_id?: string[];
    fn?: string;
    ln?: string;
    ct?: string;
    country?: string;
  };
  customData?: {
    value?: number;
    currency?: string;
    content_ids?: string[];
    contents?: {
      id: string;
      quantity: number;
      item_price?: number;
    }[];
    content_type?: "product" | "product_group";
    order_id?: string;
    search_string?: string;
    content_name?: string;
    content_category?: string;
    num_items?: number;
  };
}

/**
 * Sends a server-side event payload to our backend for processing
 * and forwarding to the Meta Conversions API.
 *
 * This function is designed to be "fire-and-forget".
 *
 * @param payload The event data to send.
 * @returns A promise that resolves when the request is sent, but doesn't wait for the full response.
 */
export async function sendMetaCapiEvent(payload: MetaCapiEventPayload): Promise<void> {
  const url = createApiUrl("/meta/events");

  try {
    // This is a tracking endpoint, so we don't need authentication (`requiresAuth: false`).
    // We use `keepalive: true` to increase the likelihood of the request
    // completing successfully, even if the user navigates away.
    await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        keepalive: true, // Important for tracking events
      },
      1, // Only one retry for tracking events to avoid duplicates
      5000, // 5-second timeout
      false, // This endpoint does not require a JWT token
    );
  } catch (error) {
    // The error is logged by fetchWithRetry, so we just swallow it here
    // to prevent it from crashing the client application.
    console.error("Error in sendMetaCapiEvent, but swallowing to prevent UI crash:", error);
  }
}