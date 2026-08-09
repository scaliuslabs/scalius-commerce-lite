// src/lib/api/tracking.ts

import { createApiUrl, fetchWithRetry } from "./client";

/**
 * Defines the payload structure for sending a server-side event
 * to our backend's /meta/events endpoint. This matches the Zod schema
 * on the backend.
 */
export interface MetaCapiEventPayload {
  eventId?: string;
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
  try {
    await fetchWithRetry(
      createApiUrl("/meta/events"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        keepalive: true,
      },
      0,
      2500,
      false,
      false,
    );
  } catch {
    // Buyer telemetry is best-effort. The API circuit breaker owns provider
    // diagnostics; page teardown or a blocked beacon must stay console-silent.
  }
}
